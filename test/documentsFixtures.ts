import { createHash, randomUUID } from "node:crypto";

// Helpers for the tests of documents and indexes (layer 4). They put rows straight into the tables as the database
// owner, the way a seed would, so a test can start from any state (an index half built, a failed one, another user's
// full queue) without going through the API. They never use the app's own services: a test that seeded through the
// code under test would agree with its mistakes. Everything is invented text.

export const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:0.6b";

export const sha256Of = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// pgvector reads '[0.1,0.2,...]', which is what JSON.stringify makes of a number array
export const vectorLiteral = (value: number | number[], dimensions = 1024): string =>
    JSON.stringify(Array.isArray(value) ? value : new Array<number>(dimensions).fill(value));

// the vector every seeded chunk gets when it is seeded as already embedded: a test that finds it again after a run knows
// the chunk was not embedded a second time
export const SEEDED_VECTOR_VALUE = 0.5;

// n short invented chunk texts, each different from the others and from those of another label
export const chunkTexts = (label: string, count: number): string[] =>
    Array.from({ length: count }, (_, index) => `${label} chunk ${index} of ${count}`);

type IndexStatus = "queued" | "indexing" | "ready" | "failed";

export interface SeedDocumentOptions {
    filename?: string;
    // stored as given: the text of a seeded document is not cleaned
    text?: string;
    createdAt?: string | Date;
}

export interface SeededDocument {
    id: string;
    filename: string;
    text: string;
    contentHash: string;
}

export interface SeedIndexOptions {
    chunkSize?: number;
    embeddingModel?: string;
    status?: IndexStatus;
    // the chunk texts, or how many invented ones to make
    chunks?: string[] | number;
    // how many of the first chunks already hold a vector; a ready index has all of them
    embeddedCount?: number;
    embeddingTokens?: number;
    attempts?: number;
    error?: string | null;
    createdAt?: string | Date;
    queuedAt?: string | Date;
    startedAt?: string | Date | null;
    finishedAt?: string | Date | null;
}

export interface SeededIndex {
    id: string;
    documentId: string;
    chunkSize: number;
    embeddingModel: string;
    chunks: string[];
}

const owner = async () => (await import("./db/testDatabase.js")).ownerPool;

export const seedUser = async (email: string): Promise<string> => {
    const { rows } = await (await owner()).query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    return rows[0].id;
};

export const seedDocument = async (userId: string, options: SeedDocumentOptions = {}): Promise<SeededDocument> => {
    const text = options.text ?? `A seeded document ${randomUUID()}.`;
    const filename = options.filename ?? "seeded.txt";
    const { rows } = await (await owner()).query<{ id: string }>(
        `INSERT INTO documents (user_id, filename, text, character_count, content_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id`,
        [userId, filename, text, text.length, sha256Of(text), options.createdAt ?? null]
    );

    return { id: rows[0].id, filename, text, contentHash: sha256Of(text) };
};

// An index of a document with its chunks, in the state the test asks for. The defaults are a queued index of 3 chunks at
// 1,000 characters with the default model, none embedded yet.
export const seedIndex = async (documentId: string, options: SeedIndexOptions = {}): Promise<SeededIndex> => {
    const status = options.status ?? "queued";
    const chunkSize = options.chunkSize ?? 1000;
    const embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    const chunks = Array.isArray(options.chunks) ? options.chunks : chunkTexts(`index ${randomUUID().slice(0, 8)}`, options.chunks ?? 3);
    const embeddedCount = options.embeddedCount ?? (status === "ready" ? chunks.length : 0);
    const startedAt = options.startedAt !== undefined ? options.startedAt : (status === "indexing" || status === "ready" || status === "failed" ? new Date() : null);
    const finishedAt = options.finishedAt !== undefined ? options.finishedAt : (status === "ready" || status === "failed" ? new Date() : null);
    const pool = await owner();

    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO document_indexes
             (document_id, chunk_size, embedding_model, status, chunk_count, embedded_count, embedding_tokens, attempts, error, created_at, queued_at, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()), $12::timestamptz, $13::timestamptz)
         RETURNING id`,
        [documentId, chunkSize, embeddingModel, status, chunks.length, embeddedCount, options.embeddingTokens ?? 0, options.attempts ?? 0, options.error ?? null,
            options.createdAt ?? null, options.queuedAt ?? null, startedAt, finishedAt]
    );
    const id = rows[0].id;

    await pool.query(
        `INSERT INTO chunks (index_id, chunk_index, text, embedding)
         SELECT $1::uuid, c.position - 1, c.chunk_text, CASE WHEN c.position <= $3 THEN $4::vector END
         FROM unnest($2::text[]) WITH ORDINALITY AS c(chunk_text, position)`,
        [id, chunks, embeddedCount, vectorLiteral(SEEDED_VECTOR_VALUE)]
    );

    return { id, documentId, chunkSize, embeddingModel, chunks };
};

// a user with one document that has one index, the most common start
export const seedDocumentWithIndex = async (userId: string, document: SeedDocumentOptions = {}, index: SeedIndexOptions = {}): Promise<{ document: SeededDocument; index: SeededIndex }> => {
    const seededDocument = await seedDocument(userId, document);

    return { document: seededDocument, index: await seedIndex(seededDocument.id, index) };
};

// `count` accepted builds of the user, each `hoursAgo` hours old (index_build_usage is what the daily limits count)
export const seedUsage = async (userId: string, count: number, hoursAgo = 0): Promise<void> => {
    await (await owner()).query(
        "INSERT INTO index_build_usage (user_id, accepted_at) SELECT $1::uuid, now() - ($3::numeric * interval '1 hour') FROM generate_series(1, $2::int)",
        [userId, count, hoursAgo]
    );
};

export const countRows = async (table: "documents" | "document_indexes" | "chunks" | "index_build_usage", where = "true", parameters: unknown[] = []): Promise<number> =>
    (await (await owner()).query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE ${where}`, parameters)).rows[0].count;

export interface IndexRow {
    id: string;
    documentId: string;
    chunkSize: number;
    embeddingModel: string;
    status: IndexStatus;
    chunkCount: number;
    embeddedCount: number;
    embeddingTokens: number;
    attempts: number;
    error: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
}

export const readIndex = async (indexId: string): Promise<IndexRow | undefined> =>
    (await (await owner()).query<IndexRow>(
        `SELECT id, document_id AS "documentId", chunk_size AS "chunkSize", embedding_model AS "embeddingModel", status,
                chunk_count AS "chunkCount", embedded_count AS "embeddedCount", embedding_tokens AS "embeddingTokens", attempts, error,
                queued_at AS "queuedAt", started_at AS "startedAt", finished_at AS "finishedAt"
         FROM document_indexes WHERE id = $1`,
        [indexId]
    )).rows[0];

export interface ChunkRow {
    chunkIndex: number;
    text: string;
    // null while the chunk has no vector
    vector: number[] | null;
}

export const readChunks = async (indexId: string): Promise<ChunkRow[]> => {
    const { rows } = await (await owner()).query<{ chunkIndex: number; text: string; vector: string | null }>(
        `SELECT chunk_index AS "chunkIndex", text, embedding::text AS vector FROM chunks WHERE index_id = $1 ORDER BY chunk_index`,
        [indexId]
    );

    return rows.map((row) => ({ chunkIndex: row.chunkIndex, text: row.text, vector: row.vector === null ? null : (JSON.parse(row.vector) as number[]) }));
};

// two vectors are the same when every number agrees to float4 precision, which is what pgvector stores
export const sameVector = (actual: number[] | null, expected: number[]): boolean =>
    actual !== null && actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) < 1e-5);

// resolves with the value once the check returns one, failing with the last thing seen when it takes longer than timeoutMs
export const waitFor = async <T>(description: string, check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const result = await check();

        if (result !== undefined && result !== false) {
            return result;
        }

        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};
