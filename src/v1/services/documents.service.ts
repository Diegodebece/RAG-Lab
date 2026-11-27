import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../config/db.config.js";
import { MAX_DOCUMENT_CHARACTERS, MAX_DOCUMENTS_PER_USER } from "../config/limits.config.js";
import type { Document } from "../types/documents.type.js";
import { AppError } from "../utils/appError.util.js";
import { chunkText } from "../utils/chunkText.util.js";
import { sanitizeText } from "../utils/sanitizeText.util.js";
import { isUuid } from "../utils/uuid.util.js";
import type { CreateDocumentInput } from "../validators/documents.validator.js";
import {
    assertBuildCapacityService,
    getIndexesOfDocumentsService,
    insertQueuedIndexService,
    lockIndexingQueueService,
    lockUserBuildsService,
    resolveIndexSettingsService
} from "./documentIndexes.service.js";
import { abortIndexBuildService, notifyIndexQueuedService } from "./indexingQueue.service.js";

// The columns of a document as the API shows it: never the text and never the owner (the caller already knows it).
const DOCUMENT_COLUMNS = `id, filename, character_count AS "characterCount", content_hash AS "contentHash", created_at AS "createdAt"`;

type DocumentRow = Omit<Document, "indexes">;

const NOT_FOUND_MESSAGE = "Document not found";
const LIMIT_REACHED_MESSAGE = "You have reached the maximum number of documents";
const DUPLICATE_MESSAGE = "You already have a document with this text";
const NO_TEXT_MESSAGE = "The document has no readable text";

// the unique index of (user, content hash) that says a user already has this text (migration 006)
const CONTENT_HASH_CONSTRAINT = "documents_user_id_content_hash_unique";

// Puts each document's indexes in it, in one query for all the documents.
const withIndexes = async (rows: DocumentRow[]): Promise<Document[]> => {
    const indexes = await getIndexesOfDocumentsService(rows.map((row) => row.id));

    return rows.map((row) => ({ ...row, indexes: indexes.filter((index) => index.documentId === row.id) }));
};

// The caller's documents, newest first, each with its indexes ordered by chunk size and then by model.
export const getDocumentsService = async (userId: string): Promise<Document[]> => {
    const { rows } = await pool.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE user_id = $1 ORDER BY created_at DESC, id`,
        [userId]
    );

    return withIndexes(rows);
};

export const getDocumentByIdService = async (userId: string, id: string): Promise<Document> => {
    if (!isUuid(id)) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1 AND user_id = $2`, [id, userId]);

    if (rows.length === 0) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    return (await withIndexes(rows))[0];
};

const countDocumentsOf = async (queryable: Pool | PoolClient, userId: string): Promise<number> => {
    const { rows } = await queryable.query<{ count: number }>("SELECT count(*)::int AS count FROM documents WHERE user_id = $1", [userId]);

    return rows[0].count;
};

// Stores a document and queues its first index. The owner comes from the token. The text is cleaned (the one cleaning the
// stored text, the hash and the chunks all go by), hashed (SHA-256 of the stored text as UTF-8: the same text is one
// document per user) and cut in chunks before anything is locked. Then one transaction, holding the user's lock and the queue's
// lock, checks the caps in a fixed order (documents of the user, builds in progress, builds of the day, builds of the day in
// all, the queue, and a copy of the same text) and stores the document, the index, its chunks and the usage row, or
// nothing at all. The worker is woken after the commit. The size and the model are the body's when it gives them and the
// default profile's when it does not.
export const createDocumentService = async (userId: string, documentData: CreateDocumentInput): Promise<Document> => {
    // a quick refusal before the text is cleaned and cut; the check that counts is the one under the lock
    if ((await countDocumentsOf(pool, userId)) >= MAX_DOCUMENTS_PER_USER) {
        throw new AppError(409, LIMIT_REACHED_MESSAGE);
    }

    const text = sanitizeText(documentData.text);

    if (text === "") {
        throw new AppError(400, NO_TEXT_MESSAGE);
    }

    // cleaning never makes a text longer apart from a few characters that Unicode normalization splits in two
    if (text.length > MAX_DOCUMENT_CHARACTERS) {
        throw new AppError(400, "Validation error", [`Text cannot have more than ${MAX_DOCUMENT_CHARACTERS} characters`]);
    }

    const contentHash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    const { chunkSize, embeddingModel } = await resolveIndexSettingsService(userId, { chunkSize: documentData.chunkSize, embeddingModel: documentData.embeddingModel });
    const chunks = chunkText(text, chunkSize);

    try {
        const documentId = await withTransaction(async (client) => {
            await lockUserBuildsService(client, userId);
            await lockIndexingQueueService(client);

            if ((await countDocumentsOf(client, userId)) >= MAX_DOCUMENTS_PER_USER) {
                throw new AppError(409, LIMIT_REACHED_MESSAGE);
            }

            await assertBuildCapacityService(client, userId);

            const { rows: duplicates } = await client.query("SELECT 1 FROM documents WHERE user_id = $1 AND content_hash = $2", [userId, contentHash]);

            if (duplicates.length > 0) {
                throw new AppError(409, DUPLICATE_MESSAGE);
            }

            const { rows } = await client.query<{ id: string }>(
                "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                [userId, documentData.filename, text, text.length, contentHash]
            );

            await insertQueuedIndexService(client, userId, rows[0].id, { chunkSize, embeddingModel, chunks });

            return rows[0].id;
        });

        notifyIndexQueuedService();

        return await getDocumentByIdService(userId, documentId);
    } catch (error) {
        // another request stored the same text between the check and the insert
        if (error instanceof Error && "code" in error && error.code === "23505" && "constraint" in error && error.constraint === CONTENT_HASH_CONSTRAINT) {
            throw new AppError(409, DUPLICATE_MESSAGE);
        }

        throw error;
    }
};

// Deletes the document with its indexes and their chunks (the foreign keys' cascade); the builds it counted stay counted. When
// one of its indexes is being built, that build's request to the model server is aborted, after the delete so the worker
// cannot take the index again in between.
export const deleteDocumentService = async (userId: string, id: string): Promise<void> => {
    if (!isUuid(id)) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    const { rows } = await pool.query<{ id: string }>("DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);

    if (rows.length === 0) {
        throw new AppError(404, NOT_FOUND_MESSAGE);
    }

    abortIndexBuildService({ documentId: id });
};
