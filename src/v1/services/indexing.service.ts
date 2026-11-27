import { SETTING_CAPS } from "../config/configuration.config.js";
import { pool, withTransaction } from "../config/db.config.js";
import { EMBEDDING_BATCH_SIZE, MAX_INDEXING_ATTEMPTS, MODEL_PROBE_TIMEOUT_MS } from "../config/indexing.config.js";
import { OLLAMA_TIMEOUT_MS } from "../config/ollama.config.js";
import type { ClaimedIndex, IndexBuildOutcome } from "../types/documentIndexes.type.js";
import { AppError } from "../utils/appError.util.js";
import { describeError } from "../utils/describeError.util.js";
import { MalformedModelAnswerError } from "../utils/malformedModelAnswerError.util.js";
import { ModelTimeoutError } from "../utils/modelTimeoutError.util.js";
import { ModelUnavailableError } from "../utils/modelUnavailableError.util.js";
import { RequestCancelledError } from "../utils/requestCancelledError.util.js";
import { emitEvent } from "./events.service.js";
import { runWithModelTurnService } from "./modelTurn.service.js";
import { embedTextsService, listInstalledModelsService } from "./ollama.service.js";

// The work for one index the queue has claimed (indexingQueue.service.ts decides which one and when). Nothing here logs
// or reports the text of a chunk: only index ids and messages.

const FAILED_MESSAGE = "Indexing failed";
const MODEL_NOT_INSTALLED_MESSAGE = "The embedding model is not installed on the model server";
const MODEL_NOT_ALLOWED_MESSAGE = "The embedding model of this index is no longer allowed";

// the models the caps allow today, which an index built before a cap changed may no longer be among
const isModelAllowed = (model: string): boolean => (SETTING_CAPS.embeddingModel.allowed as readonly string[]).includes(model);

// What goes in the log about a failed build: the index and the name, code and message of the error, never the error object
// itself: a database error carries the failing row (the text of a chunk) in its details.
const logFailure = (indexId: string, error: unknown): void => {
    console.error(`Index ${indexId} could not be built: ${describeError(error)}`);
};

// Puts the index back in the queue, in the place its queue time gives it, keeping the vectors and the tokens stored.
// Does nothing when the index is gone or is no longer being built.
const requeueBuild = async (indexId: string): Promise<void> => {
    await pool.query("UPDATE document_indexes SET status = 'queued', started_at = NULL WHERE id = $1 AND status = 'indexing'", [indexId]);
};

// Marks the index failed and tells its owner. An index deleted meanwhile is not reported: there is nobody to tell.
const failBuild = async (claimed: ClaimedIndex, message: string): Promise<IndexBuildOutcome> => {
    const { rows } = await pool.query<{ id: string }>(
        "UPDATE document_indexes SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = 'indexing' RETURNING id",
        [claimed.id, message]
    );

    if (rows.length > 0) {
        emitEvent({ type: "failed", indexId: claimed.id, userId: claimed.userId, error: message });
    }

    return "done";
};

// Stores the vectors of one batch and the counts, in one short transaction (no call to the model is made while it is
// open). Returns how many chunks of the index hold a vector now, or null when the index is gone (or is no longer being
// built). The count is read from the chunks themselves, so the stored number always agrees with them.
//
// The index row is locked first, because deleting an index takes its row and then its chunks (the cascade): a transaction
// that took the chunks first would wait for the delete while the delete waited for it, and PostgreSQL would end one of them
// with a deadlock error. In the same order, the second one waits for the first and both finish.
const storeBatch = async (indexId: string, chunkIndexes: number[], vectors: number[][], tokens: number): Promise<number | null> =>
    withTransaction(async (client) => {
        const { rowCount: locked } = await client.query(
            "SELECT 1 FROM document_indexes WHERE id = $1 AND status = 'indexing' FOR NO KEY UPDATE",
            [indexId]
        );

        if (locked === 0) {
            return null;
        }

        const { rowCount } = await client.query(
            `UPDATE chunks SET embedding = batch.embedding::vector
             FROM unnest($2::int[], $3::text[]) AS batch(chunk_index, embedding)
             WHERE chunks.index_id = $1 AND chunks.chunk_index = batch.chunk_index AND chunks.embedding IS NULL`,
            [indexId, chunkIndexes, vectors.map((vector) => JSON.stringify(vector))]
        );

        if (rowCount === 0) {
            return null;
        }

        const { rows } = await client.query<{ embeddedCount: number }>(
            `UPDATE document_indexes SET
                 embedded_count = (SELECT count(*)::int FROM chunks WHERE index_id = $1 AND embedding IS NOT NULL),
                 embedding_tokens = embedding_tokens + $2
             WHERE id = $1 AND status = 'indexing'
             RETURNING embedded_count AS "embeddedCount"`,
            [indexId, tokens]
        );

        return rows.length === 0 ? null : rows[0].embeddedCount;
    });

// Embeds the chunks that still have no vector, batch by batch, so a build that was interrupted continues where it stopped.
// Returns null when every chunk has its vector, and otherwise the outcome the build ends with: "done" when the index (or its
// document) was deleted meanwhile, or what a failure of the model server led to (handleModelFailure).
//
// Only the call to the model server is guarded: what that call throws says something about the model server. An error of
// the database (reading the chunks, storing a batch) is not caught here and goes up as it is: it is not the model server's
// fault, so nothing is asked of it, no attempt is counted and the index is not failed.
const embedChunks = async (claimed: ClaimedIndex, signal: AbortSignal): Promise<IndexBuildOutcome | null> => {
    while (true) {
        if (signal.aborted) {
            throw new RequestCancelledError();
        }

        const { rows: chunks } = await pool.query<{ chunkIndex: number; text: string }>(
            `SELECT chunk_index AS "chunkIndex", text FROM chunks
             WHERE index_id = $1 AND embedding IS NULL ORDER BY chunk_index LIMIT $2`,
            [claimed.id, EMBEDDING_BATCH_SIZE]
        );

        if (chunks.length === 0) {
            return null;
        }

        let batch: { embeddings: number[][]; promptTokens: number };

        try {
            // one turn with the model per batch, so a question waits for at most one batch, not a whole document
            batch = await runWithModelTurnService(
                () => embedTextsService(claimed.embeddingModel, chunks.map((chunk) => chunk.text), { timeoutMs: OLLAMA_TIMEOUT_MS, signal }),
                { signal }
            );
        } catch (error) {
            return handleModelFailure(claimed, error, signal);
        }

        const embeddedCount = await storeBatch(claimed.id, chunks.map((chunk) => chunk.chunkIndex), batch.embeddings, batch.promptTokens);

        if (embeddedCount === null) {
            return "done";
        }

        emitEvent({ type: "progress", indexId: claimed.id, userId: claimed.userId, embeddedCount, chunkCount: claimed.chunkCount });
    }
};

// Decides what a failed call to the model server means. A RequestCancelledError is not handled here: it goes up to the caller.
const handleModelFailure = async (claimed: ClaimedIndex, error: unknown, signal: AbortSignal): Promise<IndexBuildOutcome> => {
    if (error instanceof RequestCancelledError) {
        throw error;
    }

    // an expected error that is neither of the two below: the messages of AppErrors are written to be shown, so it is the
    // reason the index failed
    if (error instanceof AppError && !(error instanceof ModelUnavailableError) && !(error instanceof ModelTimeoutError)) {
        return failBuild(claimed, error.message);
    }

    // the answer was not what the API needs: trying again will not change it
    if (error instanceof MalformedModelAnswerError) {
        logFailure(claimed.id, error);
        return failBuild(claimed, FAILED_MESSAGE);
    }

    // the server could not be reached or did not answer in time: expected, not logged; anything else (an error answer)
    // is written to the log
    if (!(error instanceof ModelUnavailableError) && !(error instanceof ModelTimeoutError)) {
        logFailure(claimed.id, error);
    }

    return handleDroppedBatch(claimed, signal);
};

// A batch failed and the model server did not say why (it was unreachable, it did not answer in time, or it answered with an
// error). Ask it once what it has installed:
// - it does not answer (the connection fails or the probe times out): it is away, which is not the index's fault, so the
//   index goes back to the queue with its attempts unchanged and the queue stops until its next round;
// - it answers with a list and the model is not among its models: the build can never succeed, so it fails at once;
// - it answers with a list that has the model, or answers with something that is not a list (an error status, a body that
//   cannot be read): it is up, so the batch was dropped, which counts as an attempt; after MAX_INDEXING_ATTEMPTS the index
//   fails, before that it goes back to the queue. A server that is up and broken must run out of attempts, and not be
//   asked again for ever.
const handleDroppedBatch = async (claimed: ClaimedIndex, signal: AbortSignal): Promise<IndexBuildOutcome> => {
    let installed: string[] | null = null;

    try {
        installed = await listInstalledModelsService({ timeoutMs: MODEL_PROBE_TIMEOUT_MS, signal });
    } catch (error) {
        if (error instanceof RequestCancelledError) {
            throw error;
        }

        if (error instanceof ModelUnavailableError || error instanceof ModelTimeoutError) {
            await requeueBuild(claimed.id);
            return "requeued";
        }

        // it answered, so it is up
        logFailure(claimed.id, error);
    }

    if (installed && !installed.includes(claimed.embeddingModel)) {
        return failBuild(claimed, MODEL_NOT_INSTALLED_MESSAGE);
    }

    const { rows } = await pool.query<{ attempts: number }>(
        "UPDATE document_indexes SET attempts = attempts + 1 WHERE id = $1 AND status = 'indexing' RETURNING attempts",
        [claimed.id]
    );

    if (rows.length === 0) {
        return "done";
    }

    if (rows[0].attempts >= MAX_INDEXING_ATTEMPTS) {
        return failBuild(claimed, FAILED_MESSAGE);
    }

    await requeueBuild(claimed.id);
    return "requeued";
};

// Builds the index and decides what a failure means. A RequestCancelledError is not handled here: it goes up to the caller.
const buildIndex = async (claimed: ClaimedIndex, signal: AbortSignal): Promise<IndexBuildOutcome> => {
    // an index built before a cap changed may name a model that is no longer allowed: it is not sent anywhere
    if (!isModelAllowed(claimed.embeddingModel)) {
        return failBuild(claimed, MODEL_NOT_ALLOWED_MESSAGE);
    }

    const ended = await embedChunks(claimed, signal);

    if (ended !== null) {
        return ended;
    }

    // ready only when no chunk is left without a vector; the statement says so, so a build never ends "ready" with a hole
    const { rows } = await pool.query<{ id: string }>(
        `UPDATE document_indexes SET status = 'ready', embedded_count = chunk_count, finished_at = now(), error = NULL
         WHERE id = $1 AND status = 'indexing' AND NOT EXISTS (SELECT 1 FROM chunks WHERE index_id = $1 AND embedding IS NULL)
         RETURNING id`,
        [claimed.id]
    );

    if (rows.length === 0) {
        return "done";
    }

    emitEvent({ type: "ready", indexId: claimed.id, userId: claimed.userId });
    return "done";
};

// Runs the build of one index the queue has claimed, until it is ready, it fails or it is put back in the queue. The signal
// aborts the request in flight and the wait for the model's turn: the queue aborts it when the worker stops and when the
// index or its document is deleted; the index then goes back to the queue quietly (a deleted one is gone, so nothing
// changes) and nothing is reported or logged as an error.
export const runIndexBuildService = async (claimed: ClaimedIndex, signal: AbortSignal): Promise<IndexBuildOutcome> => {
    if (signal.aborted) {
        await requeueBuild(claimed.id);
        return "cancelled";
    }

    emitEvent({ type: "started", indexId: claimed.id, userId: claimed.userId });

    try {
        return await buildIndex(claimed, signal);
    } catch (error) {
        if (error instanceof RequestCancelledError) {
            await requeueBuild(claimed.id);
            return "cancelled";
        }

        throw error;
    }
};
