import type { Pool, PoolClient } from "pg";
import { LOCK_KEYS, pool, withTransaction } from "../config/db.config.js";
import {
    MAX_ACTIVE_INDEX_BUILDS_PER_USER,
    MAX_INDEX_BUILDS_PER_DAY,
    MAX_INDEX_BUILDS_PER_DAY_TOTAL,
    MAX_QUEUED_INDEX_BUILDS
} from "../config/limits.config.js";
import type { ConfigurationSettings, IndexState } from "../types/configuration.type.js";
import type { DocumentIndex } from "../types/documentIndexes.type.js";
import { AppError } from "../utils/appError.util.js";
import { chunkText } from "../utils/chunkText.util.js";
import { isUuid } from "../utils/uuid.util.js";
import type { CreateDocumentIndexInput } from "../validators/documentIndexes.validator.js";
import type { SettingsInput } from "../validators/configuration.validator.js";
import { resolveConfigurationService } from "./configuration.service.js";
import { abortIndexBuildService, notifyIndexQueuedService } from "./indexingQueue.service.js";

// What can run against a pool or a transaction.
type Queryable = Pool | PoolClient;

// The columns of an index as the API shows it, from document_indexes as "di". The place in line is counted over the queued
// indexes of every user, in the order the worker takes them (queue time, then id), and is null for an index that is not queued.
const INDEX_COLUMNS = `di.id, di.document_id AS "documentId", di.chunk_size AS "chunkSize", di.embedding_model AS "embeddingModel",
    di.status, di.chunk_count AS "chunkCount", di.embedded_count AS "embeddedCount", di.embedding_tokens AS "embeddingTokens",
    di.attempts, di.error,
    CASE WHEN di.status = 'queued' THEN (
        SELECT count(*)::int + 1 FROM document_indexes ahead
        WHERE ahead.status = 'queued' AND (ahead.queued_at, ahead.id) < (di.queued_at, di.id)
    ) END AS "queuePosition",
    di.created_at AS "createdAt", di.queued_at AS "queuedAt", di.started_at AS "startedAt", di.finished_at AS "finishedAt"`;

const DOCUMENT_NOT_FOUND_MESSAGE = "Document not found";
const INDEX_NOT_FOUND_MESSAGE = "Index not found";
const IN_PROGRESS_MESSAGE = "You have reached the maximum number of index builds in progress; try again when one finishes";
const USER_DAILY_MESSAGE = "You have reached the daily limit of index builds, please try again later";
const GLOBAL_DAILY_MESSAGE = "The daily indexing capacity is used up, please try again tomorrow";
const QUEUE_FULL_MESSAGE = "The indexing queue is full, please try again in a few minutes";
const INDEX_CHANGED_MESSAGE = "The index changed while it was being queued, please try again";

export interface IndexBuild {
    chunkSize: number;
    embeddingModel: string;
    // the pieces of the document's text, in order
    chunks: string[];
}

// What the document says it needs: the two index-time settings, from the body when it gives them and from the default
// profile when it does not (through the one resolver, which checks them against the caps).
export const resolveIndexSettingsService = async (userId: string, input: CreateDocumentIndexInput): Promise<Pick<ConfigurationSettings, "chunkSize" | "embeddingModel">> => {
    const overrides: SettingsInput = {};

    if (input.chunkSize !== undefined) {
        overrides.chunkSize = input.chunkSize;
    }

    if (input.embeddingModel !== undefined) {
        overrides.embeddingModel = input.embeddingModel;
    }

    const { snapshot } = await resolveConfigurationService(userId, { overrides });

    return { chunkSize: snapshot.settings.chunkSize, embeddingModel: snapshot.settings.embeddingModel };
};

// Two requests of one user that arrive together are served one after the other: the second one counts what the first one
// made. The lock is on the user's row and lasts until the transaction ends.
export const lockUserBuildsService = async (client: PoolClient, userId: string): Promise<void> => {
    await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);
};

// The caps that count every user's work (the queue, the builds of the day) are checked one request at a time, whoever it is
// from: without this lock two users could each read "one place left" and both take it. Always taken after the user's own
// lock, so two requests cannot wait for each other.
export const lockIndexingQueueService = async (client: PoolClient): Promise<void> => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEYS.indexingQueue]);
};

const countOf = async (client: Queryable, sql: string, values: unknown[] = []): Promise<number> => {
    const { rows } = await client.query<{ count: number }>(sql, values);

    return rows[0].count;
};

// The caps on starting a build, in this order, so the same request always gets the same refusal: the user's builds in
// progress (409), the user's builds of the last 24 hours (429), everybody's builds of the last 24 hours (429) and the
// queue (503). The documents a user may keep is the upload's own cap and is checked before these. Called with both locks held
// (lockUserBuildsService, then lockIndexingQueueService), so the counts are not out of date by the time the build is
// inserted; called with the pool and no lock, it is a quick refusal that is only a guess (see createDocumentIndexService).
// Counts the queued and the indexing builds of the user, whichever document they belong to; the builds of the day
// come from index_build_usage, which a deleted index or document does not give back.
export const assertBuildCapacityService = async (client: Queryable, userId: string): Promise<void> => {
    const active = await countOf(
        client,
        `SELECT count(*)::int AS count FROM document_indexes di JOIN documents d ON d.id = di.document_id
         WHERE d.user_id = $1 AND di.status IN ('queued', 'indexing')`,
        [userId]
    );

    if (active >= MAX_ACTIVE_INDEX_BUILDS_PER_USER) {
        throw new AppError(409, IN_PROGRESS_MESSAGE);
    }

    const today = await countOf(client, "SELECT count(*)::int AS count FROM index_build_usage WHERE user_id = $1 AND accepted_at > now() - interval '24 hours'", [userId]);

    if (today >= MAX_INDEX_BUILDS_PER_DAY) {
        throw new AppError(429, USER_DAILY_MESSAGE);
    }

    const todayInAll = await countOf(client, "SELECT count(*)::int AS count FROM index_build_usage WHERE accepted_at > now() - interval '24 hours'");

    if (todayInAll >= MAX_INDEX_BUILDS_PER_DAY_TOTAL) {
        throw new AppError(429, GLOBAL_DAILY_MESSAGE);
    }

    const queued = await countOf(client, "SELECT count(*)::int AS count FROM document_indexes WHERE status = 'queued'");

    if (queued >= MAX_QUEUED_INDEX_BUILDS) {
        throw new AppError(503, QUEUE_FULL_MESSAGE);
    }
};

// Counts one accepted build for the user.
const recordBuildUsage = async (client: PoolClient, userId: string): Promise<void> => {
    await client.query("INSERT INTO index_build_usage (user_id) VALUES ($1)", [userId]);
};

// Inserts a queued index of the document with its chunks (without vectors) in one statement, and counts the build. The caps
// are the caller's: they were checked, under the locks, before this.
export const insertQueuedIndexService = async (client: PoolClient, userId: string, documentId: string, build: IndexBuild): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
        "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, $2, $3, $4) RETURNING id",
        [documentId, build.chunkSize, build.embeddingModel, build.chunks.length]
    );
    const indexId = rows[0].id;

    await client.query(
        `INSERT INTO chunks (index_id, chunk_index, text)
         SELECT $1::uuid, (c.position - 1)::int, c.chunk_text
         FROM unnest($2::text[]) WITH ORDINALITY AS c(chunk_text, position)`,
        [indexId, build.chunks]
    );
    await recordBuildUsage(client, userId);

    return indexId;
};

const readIndex = async (queryable: Queryable, indexId: string): Promise<DocumentIndex> => {
    const { rows } = await queryable.query<DocumentIndex>(`SELECT ${INDEX_COLUMNS} FROM document_indexes di WHERE di.id = $1`, [indexId]);

    if (rows.length === 0) {
        throw new AppError(404, INDEX_NOT_FOUND_MESSAGE);
    }

    return rows[0];
};

// The indexes of the given documents, ordered by chunk size and then by model (the caller groups them by document).
export const getIndexesOfDocumentsService = async (documentIds: string[]): Promise<DocumentIndex[]> => {
    if (documentIds.length === 0) {
        return [];
    }

    const { rows } = await pool.query<DocumentIndex>(
        `SELECT ${INDEX_COLUMNS} FROM document_indexes di WHERE di.document_id = ANY($1::uuid[]) ORDER BY di.chunk_size, di.embedding_model, di.id`,
        [documentIds]
    );

    return rows;
};

// A document that is not the caller's, does not exist or has a malformed id is the same 404, so its existence is not revealed.
const assertDocumentOwned = async (userId: string, documentId: string): Promise<void> => {
    if (!isUuid(documentId)) {
        throw new AppError(404, DOCUMENT_NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query("SELECT 1 FROM documents WHERE id = $1 AND user_id = $2", [documentId, userId]);

    if (rows.length === 0) {
        throw new AppError(404, DOCUMENT_NOT_FOUND_MESSAGE);
    }
};

// The pieces of the text of the caller's document at one chunk size.
const chunkDocument = async (queryable: Queryable, userId: string, documentId: string, chunkSize: number): Promise<string[]> => {
    const { rows } = await queryable.query<{ text: string }>("SELECT text FROM documents WHERE id = $1 AND user_id = $2", [documentId, userId]);

    if (rows.length === 0) {
        throw new AppError(404, DOCUMENT_NOT_FOUND_MESSAGE);
    }

    return chunkText(rows[0].text, chunkSize);
};

interface ExistingIndex {
    id: string;
    status: DocumentIndex["status"];
}

const findExistingIndex = async (queryable: Queryable, documentId: string, chunkSize: number, embeddingModel: string): Promise<ExistingIndex | undefined> => {
    const { rows } = await queryable.query<ExistingIndex>(
        "SELECT id, status FROM document_indexes WHERE document_id = $1 AND chunk_size = $2 AND embedding_model = $3",
        [documentId, chunkSize, embeddingModel]
    );

    return rows[0];
};

// Queues an index of an existing document at the size and model the body gives (the default profile's when it gives none).
// An index of that size and model that is queued, being built or ready is returned as it is (created: false) before any cap is
// looked at, because nothing is built. A failed one is queued again with the same id (attempts back to 0, no error, a new
// queue time, the vectors it has kept) and counts as a build; a missing one is made. Both are checked against the caps
// of the user and of the server, inside one transaction that holds the user's lock and the queue's lock.
export const createDocumentIndexService = async (userId: string, documentId: string, input: CreateDocumentIndexInput): Promise<{ index: DocumentIndex; created: boolean }> => {
    await assertDocumentOwned(userId, documentId);

    const { chunkSize, embeddingModel } = await resolveIndexSettingsService(userId, input);
    const existing = await findExistingIndex(pool, documentId, chunkSize, embeddingModel);

    if (existing && existing.status !== "failed") {
        return { index: await readIndex(pool, existing.id), created: false };
    }

    // A request that is going to be refused for a cap does not pay for reading and cutting a text that may be a million
    // characters: the caps are looked at first, without a lock. Only a guess (another request may take the last place a
    // moment later), so they are checked again under the locks below, which is what decides.
    await assertBuildCapacityService(pool, userId);

    // cut before the transaction, so the locks are not held while a long text is chunked; a failed index already has its chunks
    const chunks = existing ? null : await chunkDocument(pool, userId, documentId, chunkSize);

    try {
        const outcome = await withTransaction(async (client) => {
            await lockUserBuildsService(client, userId);

            // another request of the same user may have made, or deleted, the index while this one waited for the lock
            const current = await findExistingIndex(client, documentId, chunkSize, embeddingModel);

            if (current && current.status !== "failed") {
                return { indexId: current.id, created: false };
            }

            await lockIndexingQueueService(client);
            await assertBuildCapacityService(client, userId);

            if (current) {
                const { rows } = await client.query<{ id: string }>(
                    `UPDATE document_indexes SET status = 'queued', attempts = 0, error = NULL, queued_at = now(), started_at = NULL, finished_at = NULL
                     WHERE id = $1 AND status = 'failed' RETURNING id`,
                    [current.id]
                );

                if (rows.length === 0) {
                    throw new AppError(409, INDEX_CHANGED_MESSAGE);
                }

                await recordBuildUsage(client, userId);
                return { indexId: current.id, created: true };
            }

            const build: IndexBuild = { chunkSize, embeddingModel, chunks: chunks ?? await chunkDocument(client, userId, documentId, chunkSize) };

            return { indexId: await insertQueuedIndexService(client, userId, documentId, build), created: true };
        });

        if (outcome.created) {
            notifyIndexQueuedService();
        }

        return { index: await readIndex(pool, outcome.indexId), created: outcome.created };
    } catch (error) {
        // the document was deleted between the check and the insert (the foreign key of the index says so)
        if (error instanceof Error && "code" in error && error.code === "23503") {
            throw new AppError(404, DOCUMENT_NOT_FOUND_MESSAGE);
        }

        throw error;
    }
};

// One index of one of the caller's documents. A document that is not the caller's is a 404 about the document; an index
// of another document is a 404 about the index.
export const getDocumentIndexByIdService = async (userId: string, documentId: string, indexId: string): Promise<DocumentIndex> => {
    await assertDocumentOwned(userId, documentId);

    if (!isUuid(indexId)) {
        throw new AppError(404, INDEX_NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<DocumentIndex>(
        `SELECT ${INDEX_COLUMNS} FROM document_indexes di WHERE di.id = $1 AND di.document_id = $2`,
        [indexId, documentId]
    );

    if (rows.length === 0) {
        throw new AppError(404, INDEX_NOT_FOUND_MESSAGE);
    }

    return rows[0];
};

// Deletes the index; its chunks go with it (the foreign key's cascade). The build it was part of is not given back: the
// usage rows stay. When the index is the one being built, its request to the model server is aborted, after the delete so
// the worker cannot take the index again in between.
export const deleteDocumentIndexService = async (userId: string, documentId: string, indexId: string): Promise<void> => {
    await assertDocumentOwned(userId, documentId);

    if (!isUuid(indexId)) {
        throw new AppError(404, INDEX_NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<{ id: string }>("DELETE FROM document_indexes WHERE id = $1 AND document_id = $2 RETURNING id", [indexId, documentId]);

    if (rows.length === 0) {
        throw new AppError(404, INDEX_NOT_FOUND_MESSAGE);
    }

    abortIndexBuildService({ indexId });
};

// The index the caller's document has at a chunk size and model, in any state, or null when it has none: what the dry run of a
// configuration reports. It reads and builds nothing. A document that is not the caller's is the usual 404.
export const findIndexStateService = async (userId: string, documentId: string, settings: { chunkSize: number; embeddingModel: string }): Promise<IndexState | null> => {
    await assertDocumentOwned(userId, documentId);

    const existing = await findExistingIndex(pool, documentId, settings.chunkSize, settings.embeddingModel);

    return existing ? { id: existing.id, status: existing.status } : null;
};

// The ready index of the caller's document at a chunk size and model, for the routes that answer from an index. It never
// builds one and never calls the model server: an index that is missing, queued, being built or failed is a 409 that
// tells the client to build it first (POST /v1/documents/:id/indexes), which is the only route that spends the build caps.
export const findReadyIndexService = async (userId: string, documentId: string, settings: { chunkSize: number; embeddingModel: string }): Promise<DocumentIndex> => {
    await assertDocumentOwned(userId, documentId);

    const { rows } = await pool.query<DocumentIndex>(
        `SELECT ${INDEX_COLUMNS} FROM document_indexes di
         WHERE di.document_id = $1 AND di.chunk_size = $2 AND di.embedding_model = $3 AND di.status = 'ready'`,
        [documentId, settings.chunkSize, settings.embeddingModel]
    );

    if (rows.length === 0) {
        throw new AppError(409, `This document has no ready index for chunk size ${settings.chunkSize}`);
    }

    return rows[0];
};
