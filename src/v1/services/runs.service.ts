import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { getSecretKey } from "../config/auth.config.js";
import { pool } from "../config/db.config.js";
import { MIN_MODEL_CALL_MS } from "../config/limits.config.js";
import { OLLAMA_TIMEOUT_MS } from "../config/ollama.config.js";
import type { Fragment, RetrievalRun, RetrievalSettings, RunStatus, RunTimings } from "../types/runs.type.js";
import { hashSnapshotText, toCanonicalJson, toRetrievalSnapshot } from "../utils/configurationSnapshot.util.js";
import { isForeignKeyViolation } from "../utils/dbErrors.util.js";
import { ModelTimeoutError } from "../utils/modelTimeoutError.util.js";
import { RequestCancelledError } from "../utils/requestCancelledError.util.js";
import type { SearchDocumentInput } from "../validators/runs.validator.js";
import { resolveConfigurationService } from "./configuration.service.js";
import { findReadyIndexService } from "./documentIndexes.service.js";
import { runWithModelTurnService } from "./modelTurn.service.js";
import { embedTextsService } from "./ollama.service.js";
import { admitQuestionService, createQuestionDeadline, recordQuestionUsageService } from "./questionAdmission.service.js";
import { findFragmentsService } from "./retrieval.service.js";

// milliseconds with two decimals, the unit and precision the runs table and the response use
const elapsedSince = (start: number): number => Math.round((performance.now() - start) * 100) / 100;

// What is embedded for a retrieval mode. "vector" embeds the raw, trimmed question, with no instruction or prefix: RAG Web's
// evaluated behavior. The switch has a case for every mode, so widening the enumeration without writing its case fails typecheck.
const toQueryText = (mode: RetrievalSettings["retrievalMode"], question: string): string => {
    switch (mode) {
        case "vector":
            return question;
    }
};

// What names the key of the question hashes: a change to how they are made takes a new version here, so old and new hashes are
// never taken for each other.
const QUESTION_HASH_KEY_LABEL = "rag-lab:question-hash:v1";

// HMAC-SHA-256 of the trimmed question as UTF-8, keyed from SECRET_KEY: it pairs the same question across runs without keeping its
// text, and nobody who only holds the table can compute the hash of a guessed question. Rotating SECRET_KEY changes every hash, so
// the runs from before a rotation are no longer paired with the ones after it.
const hashQuestion = (question: string): string => {
    const secretKey = getSecretKey();

    if (!secretKey) {
        throw new Error("SECRET_KEY is not set");
    }

    const key = createHmac("sha256", secretKey).update(QUESTION_HASH_KEY_LABEL).digest();

    return createHmac("sha256", key).update(question, "utf8").digest("hex");
};

// what the table keeps of a fragment: where it was, why it was returned and its score, never its text
const toStoredFragment = (fragment: Fragment): { chunkIndex: number; retrieval: Fragment["retrieval"]; score?: number } => ({
    chunkIndex: fragment.chunkIndex,
    retrieval: fragment.retrieval,
    ...(fragment.score === undefined ? {} : { score: fragment.score })
});

interface RunToStore {
    userId: string;
    status: RunStatus;
    profileId: string | null;
    documentId: string;
    indexId: string;
    configurationText: string;
    configurationHash: string;
    questionHash: string;
    questionCharacters: number;
    fragmentsText: string;
    embeddingTokens: number;
    timings: RunTimings;
}

// Inserts the run. The profile, the document and the index are named through subqueries that filter by the owner, so a row that
// was deleted since it was read gives NULL (the foreign keys set to NULL do the same later), and an id the user does not own can
// never be written. An insert that still fails on a foreign key (the row was deleted between the subquery and the check) is tried
// once more, and then the error is the caller's.
const insertRun = async (run: RunToStore): Promise<{ id: string; createdAt: Date }> => {
    const insert = async (): Promise<{ id: string; createdAt: Date }> => {
        const { rows } = await pool.query<{ id: string; createdAt: Date }>(
            `INSERT INTO runs (
                 user_id, kind, status, profile_id, document_id, index_id, configuration, configuration_hash, question_hash,
                 question_characters, fragments, embedding_tokens, wait_ms, embedding_ms, retrieval_ms, total_ms
             ) VALUES (
                 $1, 'retrieval', $2,
                 (SELECT id FROM profiles WHERE id = $3 AND user_id = $1),
                 (SELECT id FROM documents WHERE id = $4 AND user_id = $1),
                 (SELECT di.id FROM document_indexes di JOIN documents d ON d.id = di.document_id WHERE di.id = $5 AND d.user_id = $1),
                 $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15
             ) RETURNING id, created_at AS "createdAt"`,
            [
                run.userId, run.status, run.profileId, run.documentId, run.indexId, run.configurationText, run.configurationHash, run.questionHash,
                run.questionCharacters, run.fragmentsText, run.embeddingTokens, run.timings.waitMs, run.timings.embeddingMs, run.timings.retrievalMs, run.timings.totalMs
            ]
        );

        return rows[0];
    };

    try {
        return await insert();
    } catch (error) {
        if (isForeignKeyViolation(error)) {
            return await insert();
        }

        throw error;
    }
};

// Searches one of the caller's documents for a question, and stores the run. In this order, and a refusal at any step stores and
// counts nothing: the configuration is resolved (the profile and the caps), the ready index of the document at the resolved chunk
// size and model is found (it never builds one: a missing or unfinished index is a 409), the question is admitted (one at a time
// per user, a place in the line, the day's count of question_usage), it waits for the model's turn and is embedded within the time
// the question has left (under MIN_MODEL_CALL_MS left, nothing is sent), the question is counted (a row of question_usage) as soon
// as the embedding is done, the index is searched after the turn is released, and the run is inserted. The signal takes the
// question out of the line, or stops the embedding, when the client disconnects; a client that hangs up after the request was sent
// is counted too, because the model did the work. Once the embedding is back, the question stays counted whatever happens to the
// run: an index or a document that went meanwhile is the refusal it would have been before the embedding, and a question that ran
// out of time while the index was searched is a 504, both with no run stored.
export const searchDocumentService = async (userId: string, documentId: string, input: SearchDocumentInput, signal?: AbortSignal): Promise<RetrievalRun> => {
    const started = performance.now();
    const deadline = createQuestionDeadline();

    const resolved = await resolveConfigurationService(userId, {
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.overrides === undefined ? {} : { overrides: input.overrides })
    });
    const snapshot = toRetrievalSnapshot(resolved.snapshot);
    const configurationText = toCanonicalJson(snapshot);
    const configurationHash = hashSnapshotText(configurationText);
    const { settings } = snapshot;
    const index = await findReadyIndexService(userId, documentId, settings);
    const questionHash = hashQuestion(input.question);

    const ticket = await admitQuestionService(userId);

    try {
        // the line is shared with the indexing batches, first come first served: a question waits for the batch in flight and the
        // questions ahead of it, and for no longer than it has left. Only Ollama's work is inside the turn.
        const queued = performance.now();
        const maxWaitMs = deadline.timeLeft();

        // true once the request is on its way to Ollama: from then on the model works for the question, whatever the client does
        const call = { requestSent: false };

        // what runs when the turn comes
        const embedInTurn = async (): Promise<{ vector: number[]; tokens: number; waitMs: number; embeddingMs: number }> => {
            ticket.started();
            const waitMs = elapsedSince(queued);
            const embeddingStarted = performance.now();
            const timeLeft = deadline.timeLeft();

            // a question that finds almost no time left cannot be a real embedding: it is the 504 of a model that was too slow, and
            // nothing is sent
            if (timeLeft < MIN_MODEL_CALL_MS) {
                throw new ModelTimeoutError();
            }

            // an aborted signal sends nothing (the wrapper refuses before it calls fetch), and a question that was not sent is free
            call.requestSent = signal?.aborted !== true;

            const { embeddings, promptTokens } = await embedTextsService(settings.embeddingModel, [toQueryText(settings.retrievalMode, input.question)], {
                timeoutMs: Math.min(timeLeft, OLLAMA_TIMEOUT_MS),
                signal
            });

            return { vector: embeddings[0], tokens: promptTokens, waitMs, embeddingMs: elapsedSince(embeddingStarted) };
        };

        let embedded: Awaited<ReturnType<typeof embedInTurn>>;

        try {
            embedded = await runWithModelTurnService(embedInTurn, { maxWaitMs, signal });
        } catch (error) {
            // the client hung up after the request was sent: Ollama did the work, so the question counts. A failure of the model
            // server (503, 504, a malformed answer) and a cancel before the request was sent cost nothing.
            if (call.requestSent && error instanceof RequestCancelledError) {
                await recordQuestionUsageService(userId);
            }

            throw error;
        }

        // the embedding is done: the question counts, whatever becomes of the run (the search below can fail, and the index can be gone)
        await recordQuestionUsageService(userId);

        const retrievalStarted = performance.now();
        const fragments = await findFragmentsService(userId, index.id, embedded.vector, {
            topK: settings.topK,
            minScore: settings.minScore,
            neighborWindow: settings.neighborWindow
        });
        const retrievalMs = elapsedSince(retrievalStarted);

        // nothing was close enough, or the index went while the question was being embedded: the same checks as before the
        // question was admitted tell them apart, and a gone document or index is the refusal it would have been then, with no run
        if (fragments.length === 0) {
            await findReadyIndexService(userId, documentId, settings);
        }

        const status: RunStatus = fragments.length === 0 ? "no_match" : "matched";
        const timings: RunTimings = { waitMs: embedded.waitMs, embeddingMs: embedded.embeddingMs, retrievalMs, totalMs: elapsedSince(started) };

        // the time of the question is up: the answer is the 504 of a model that was too slow, and no run is stored (the usage row stays)
        deadline.timeLeft();

        const stored = await insertRun({
            userId,
            status,
            profileId: resolved.profileId,
            documentId: index.documentId,
            indexId: index.id,
            configurationText,
            configurationHash,
            questionHash,
            questionCharacters: input.question.length,
            fragmentsText: JSON.stringify(fragments.map(toStoredFragment)),
            embeddingTokens: embedded.tokens,
            timings
        });

        return {
            id: stored.id,
            kind: "retrieval",
            status,
            documentId: index.documentId,
            indexId: index.id,
            profileId: resolved.profileId,
            configuration: snapshot,
            configurationHash,
            fragments,
            tokens: { embedding: embedded.tokens },
            timings,
            createdAt: stored.createdAt.toISOString()
        };
    } finally {
        ticket.release();
    }
};
