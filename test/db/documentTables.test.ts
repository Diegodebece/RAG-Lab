import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeTestPools, ownerPool, resetTestDatabase } from "./testDatabase.js";
import { sha256Of, vectorLiteral } from "../documentsFixtures.js";

// The tables of documents and indexes (layer 4): documents (the cleaned text a user uploaded), document_indexes (one per
// chunk size and embedding model, which is also the indexing queue), chunks (the pieces with their vectors) and
// index_build_usage (one row per accepted build, what the daily limits count). Everything is done as the owner; what
// the API role may do with them is in apiRole.test.ts.

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

interface Failure {
    code: string;
    message: string;
}

// what the database said when it refused the statement, or undefined when the statement worked
const failureOf = async (statement: string, parameters: unknown[] = []): Promise<Failure | undefined> => {
    try {
        await ownerPool.query(statement, parameters);
        return undefined;
    } catch (error) {
        const details = error as { code?: string; message?: string };
        return { code: details.code ?? "not a database error", message: details.message ?? "" };
    }
};

const codeOf = async (statement: string, parameters: unknown[] = []): Promise<string | undefined> => (await failureOf(statement, parameters))?.code;

const columnsOf = async (table: string): Promise<{ column_name: string; data_type: string; is_nullable: string }[]> => {
    const { rows } = await ownerPool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
        [table]
    );
    return rows;
};

// the columns of each index of a table, in the order the index has them
const indexColumnsOf = async (table: string): Promise<string[][]> => {
    const { rows } = await ownerPool.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY k.position) AS columns
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = $1::regclass
         GROUP BY i.indexrelid`,
        [`public.${table}`]
    );
    return rows.map((row) => row.columns);
};

const seedUser = async (email: string): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    return rows[0].id;
};

const HASH = sha256Of("some invented text");

const insertDocument = async (userId: string, overrides: { filename?: string; text?: string; characterCount?: number; contentHash?: string } = {}): Promise<string> => {
    const text = overrides.text ?? `invented text ${randomUUID()}`;
    const { rows } = await ownerPool.query<{ id: string }>(
        "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [userId, overrides.filename ?? "notes.txt", text, overrides.characterCount ?? Math.max(text.length, 1), overrides.contentHash ?? sha256Of(text)]
    );
    return rows[0].id;
};

const insertIndex = async (documentId: string, columns: Record<string, unknown> = {}): Promise<string> => {
    const values: Record<string, unknown> = { document_id: documentId, chunk_size: 1000, embedding_model: "qwen3-embedding:0.6b", chunk_count: 3, ...columns };
    const names = Object.keys(values);
    const { rows } = await ownerPool.query<{ id: string }>(
        `INSERT INTO document_indexes (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
        names.map((name) => values[name])
    );
    return rows[0].id;
};

const count = async (table: string): Promise<number> => (await ownerPool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;

describe("the documents table", () => {
    it("has the columns id, user_id, filename, text, character_count, content_hash and created_at, all required, with these types", async () => {
        assert.deepEqual(await columnsOf("documents"), [
            { column_name: "character_count", data_type: "integer", is_nullable: "NO" },
            { column_name: "content_hash", data_type: "text", is_nullable: "NO" },
            { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "filename", data_type: "text", is_nullable: "NO" },
            { column_name: "id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "text", data_type: "text", is_nullable: "NO" },
            { column_name: "user_id", data_type: "uuid", is_nullable: "NO" }
        ]);
    });

    it("gives a new row a UUID and a creation date", async () => {
        const userId = await seedUser("ana@example.com");

        const { rows } = await ownerPool.query<{ id: string; created_at: Date }>(
            "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', 'abc', 3, $2) RETURNING id, created_at",
            [userId, HASH]
        );

        assert.match(rows[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.ok(rows[0].created_at instanceof Date);
    });

    it("refuses an empty filename and one of 256 characters (23514), and accepts one of 255 and one of a single character", async () => {
        const userId = await seedUser("ana@example.com");
        const insert = (filename: string) => failureOf(
            "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, $2, $3, 1, $4)",
            [userId, filename, `text ${filename.length}`, sha256Of(`text ${filename.length}`)]
        );

        assert.equal((await insert(""))?.code, "23514", "empty");
        assert.equal((await insert("a".repeat(256)))?.code, "23514", "256 characters");
        assert.equal(await insert("a".repeat(255)), undefined, "255 characters");
        assert.equal(await insert("a"), undefined, "one character");
    });

    it("refuses empty text and a character count of 0 (23514)", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await codeOf("INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', '', 1, $2)", [userId, HASH]), "23514", "empty text");
        assert.equal(await codeOf("INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', 'abc', 0, $2)", [userId, HASH]), "23514", "character count 0");
        assert.equal(await codeOf("INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', 'abc', -3, $2)", [userId, HASH]), "23514", "negative character count");
        assert.equal(await count("documents"), 0, "nothing was stored");
    });

    it("refuses a content hash that is not 64 lowercase hexadecimal digits (23514), and accepts one that is", async () => {
        const userId = await seedUser("ana@example.com");
        const insert = (hash: string) => failureOf(
            "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', $2, 3, $3)",
            [userId, `text ${hash}`, hash]
        );

        const refused: Record<string, string> = {
            "empty": "",
            "63 digits": HASH.slice(1),
            "65 digits": `${HASH}0`,
            "upper case": HASH.toUpperCase(),
            "not hexadecimal": `${HASH.slice(0, 63)}g`,
            "with spaces around": ` ${HASH.slice(2)} `
        };

        for (const [label, hash] of Object.entries(refused)) {
            assert.equal((await insert(hash))?.code, "23514", label);
        }

        assert.equal(await insert(HASH), undefined, "a real SHA-256");
    });

    it("refuses the same text twice for one user (23505), and lets another user store it", async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        await insertDocument(ana, { text: "the same words", contentHash: HASH });

        assert.equal(await codeOf("INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'other.txt', 'the same words', 14, $2)", [ana, HASH]), "23505");
        assert.equal(await count("documents"), 1);

        await insertDocument(bob, { text: "the same words", contentHash: HASH });
        assert.equal(await count("documents"), 2);
    });

    it("refuses a document of a user that does not exist (23503)", async () => {
        assert.equal(await codeOf("INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', 'abc', 3, $2)", [randomUUID(), HASH]), "23503");
    });

    it("has an index whose first column is user_id", async () => {
        assert.ok((await indexColumnsOf("documents")).some((columns) => columns[0] === "user_id"), "an index starts with user_id: the foreign key is indexed");
    });
});

describe("the document_indexes table", () => {
    it("has the columns of an index and its build, with these types, and only error, started_at and finished_at optional", async () => {
        assert.deepEqual(await columnsOf("document_indexes"), [
            { column_name: "attempts", data_type: "integer", is_nullable: "NO" },
            { column_name: "chunk_count", data_type: "integer", is_nullable: "NO" },
            { column_name: "chunk_size", data_type: "integer", is_nullable: "NO" },
            { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "document_id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "embedded_count", data_type: "integer", is_nullable: "NO" },
            { column_name: "embedding_model", data_type: "text", is_nullable: "NO" },
            { column_name: "embedding_tokens", data_type: "integer", is_nullable: "NO" },
            { column_name: "error", data_type: "text", is_nullable: "YES" },
            { column_name: "finished_at", data_type: "timestamp with time zone", is_nullable: "YES" },
            { column_name: "id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "queued_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "started_at", data_type: "timestamp with time zone", is_nullable: "YES" },
            { column_name: "status", data_type: "text", is_nullable: "NO" }
        ]);
    });

    it("gives a new index a UUID, the status queued, nothing embedded, no attempts, no error and both dates", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));

        const { rows } = await ownerPool.query(
            `INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'm:1', 4)
             RETURNING id, status, embedded_count, embedding_tokens, attempts, error, started_at, finished_at, created_at, queued_at`,
            [documentId]
        );

        assert.match(rows[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(rows[0].status, "queued");
        assert.equal(rows[0].embedded_count, 0);
        assert.equal(rows[0].embedding_tokens, 0);
        assert.equal(rows[0].attempts, 0);
        assert.equal(rows[0].error, null);
        assert.equal(rows[0].started_at, null);
        assert.equal(rows[0].finished_at, null);
        assert.ok(rows[0].created_at instanceof Date);
        assert.ok(rows[0].queued_at instanceof Date);
    });

    it("accepts the four statuses and refuses any other, such as cancelled or done (23514)", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));

        for (const [index, status] of ["queued", "indexing", "failed"].entries()) {
            await insertIndex(documentId, { chunk_size: 300 + index, status });
        }
        await insertIndex(documentId, { chunk_size: 400, status: "ready", embedded_count: 3 });

        for (const status of ["cancelled", "done", "pending", "processing", "READY", ""]) {
            assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, status) VALUES ($1, 700, 'm:1', 3, $2)", [documentId, status]), "23514", `status "${status}"`);
        }
    });

    it("refuses a second index of the same document with the same chunk size and model (23505), and accepts another size or another model", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));
        await insertIndex(documentId, { chunk_size: 1000, embedding_model: "m:1" });

        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'm:1', 3)", [documentId]), "23505");

        await insertIndex(documentId, { chunk_size: 500, embedding_model: "m:1" });
        await insertIndex(documentId, { chunk_size: 1000, embedding_model: "m:2" });
        assert.equal(await count("document_indexes"), 3);
    });

    it("lets two documents each have an index of the same size and model", async () => {
        const userId = await seedUser("ana@example.com");

        await insertIndex(await insertDocument(userId), { chunk_size: 1000 });
        await insertIndex(await insertDocument(userId), { chunk_size: 1000 });

        assert.equal(await count("document_indexes"), 2);
    });

    it("refuses a chunk size of 1 (23514) and accepts 2 and any other size such as 400: the list of sizes the API allows is in the code only", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));

        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1, 'm:1', 3)", [documentId]), "23514", "1");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 0, 'm:1', 3)", [documentId]), "23514", "0");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, -300, 'm:1', 3)", [documentId]), "23514", "negative");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 2, 'm:1', 3)", [documentId]), undefined, "2");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 400, 'm:1', 3)", [documentId]), undefined, "400");
    });

    it("refuses an empty model name and one of 201 characters (23514), and accepts one of 200", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));
        const insert = (model: string) => codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, $2, 3)", [documentId, model]);

        assert.equal(await insert(""), "23514", "empty");
        assert.equal(await insert("m".repeat(201)), "23514", "201 characters");
        assert.equal(await insert("m".repeat(200)), undefined, "200 characters");
    });

    it("refuses a chunk count below 1, and an embedded count that is negative or above the chunk count (23514)", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));
        const insert = (chunkSize: number, chunkCount: number, embeddedCount: number) => codeOf(
            "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, embedded_count) VALUES ($1, $2, 'm:1', $3, $4)",
            [documentId, chunkSize, chunkCount, embeddedCount]
        );

        assert.equal(await insert(1000, 0, 0), "23514", "no chunks");
        assert.equal(await insert(1001, -1, 0), "23514", "negative chunk count");
        assert.equal(await insert(1002, 3, 4), "23514", "embedded above chunk count");
        assert.equal(await insert(1003, 3, -1), "23514", "negative embedded count");
        assert.equal(await insert(1004, 3, 3), undefined, "all embedded, still queued");
        assert.equal(await insert(1005, 3, 0), undefined, "none embedded");
    });

    it("refuses, on update too, an embedded count above the chunk count (23514)", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));
        const indexId = await insertIndex(documentId, { chunk_count: 3 });

        assert.equal(await codeOf("UPDATE document_indexes SET embedded_count = 4 WHERE id = $1", [indexId]), "23514");
        assert.equal(await codeOf("UPDATE document_indexes SET embedded_count = 3 WHERE id = $1", [indexId]), undefined);
    });

    it("refuses an index that is ready with fewer vectors than chunks (23514), on insert and on update, and accepts one that has them all", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));

        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, embedded_count, status) VALUES ($1, 500, 'm:1', 3, 2, 'ready')", [documentId]), "23514", "insert");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, embedded_count, status) VALUES ($1, 500, 'm:1', 3, 3, 'ready')", [documentId]), undefined, "insert with all of them");

        const indexId = await insertIndex(documentId, { chunk_size: 750, embedded_count: 2 });
        assert.equal(await codeOf("UPDATE document_indexes SET status = 'ready' WHERE id = $1", [indexId]), "23514", "update");
        assert.equal(await codeOf("UPDATE document_indexes SET status = 'ready', embedded_count = 3 WHERE id = $1", [indexId]), undefined, "update with all of them");
    });

    it("refuses negative token and attempt counts (23514)", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));

        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, embedding_tokens) VALUES ($1, 500, 'm:1', 3, -1)", [documentId]), "23514", "tokens");
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count, attempts) VALUES ($1, 500, 'm:1', 3, -1)", [documentId]), "23514", "attempts");
    });

    it("refuses an error message of 501 characters (23514), and accepts one of 500 or none", async () => {
        const documentId = await insertDocument(await seedUser("ana@example.com"));
        const indexId = await insertIndex(documentId);

        assert.equal(await codeOf("UPDATE document_indexes SET error = $2 WHERE id = $1", [indexId, "e".repeat(501)]), "23514");
        assert.equal(await codeOf("UPDATE document_indexes SET error = $2 WHERE id = $1", [indexId, "e".repeat(500)]), undefined);
        assert.equal(await codeOf("UPDATE document_indexes SET error = NULL WHERE id = $1", [indexId]), undefined);
    });

    it("refuses an index of a document that does not exist (23503)", async () => {
        assert.equal(await codeOf("INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'm:1', 3)", [randomUUID()]), "23503");
    });

    it("has an index whose first column is document_id", async () => {
        assert.ok((await indexColumnsOf("document_indexes")).some((columns) => columns[0] === "document_id"), "an index starts with document_id: the foreign key is indexed");
    });

    it("has an index on status, queued_at and id, which finds the next build of the queue", async () => {
        assert.ok((await indexColumnsOf("document_indexes")).some((columns) => columns.join(",") === "status,queued_at,id"));
    });
});

describe("the chunks table", () => {
    it("has the columns index_id, chunk_index, text and embedding, and only the embedding may be empty", async () => {
        assert.deepEqual(await columnsOf("chunks"), [
            { column_name: "chunk_index", data_type: "integer", is_nullable: "NO" },
            { column_name: "embedding", data_type: "USER-DEFINED", is_nullable: "YES" },
            { column_name: "index_id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "text", data_type: "text", is_nullable: "NO" }
        ]);
    });

    it("stores a vector of 1024 dimensions and a chunk without one", async () => {
        const indexId = await insertIndex(await insertDocument(await seedUser("ana@example.com")));

        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text, embedding) VALUES ($1, 0, 'with a vector', $2::vector)", [indexId, vectorLiteral(0.25)]);
        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 1, 'without one')", [indexId]);

        const { rows } = await ownerPool.query<{ chunk_index: number; dimensions: number | null }>("SELECT chunk_index, vector_dims(embedding) AS dimensions FROM chunks ORDER BY chunk_index");
        assert.deepEqual(rows, [{ chunk_index: 0, dimensions: 1024 }, { chunk_index: 1, dimensions: null }]);
    });

    it("refuses a vector of 3 dimensions: the column holds 1024 and pgvector says so", async () => {
        const indexId = await insertIndex(await insertDocument(await seedUser("ana@example.com")));

        const failure = await failureOf("INSERT INTO chunks (index_id, chunk_index, text, embedding) VALUES ($1, 0, 'short', '[1,2,3]'::vector)", [indexId]);

        assert.ok(failure, "the insert was refused");
        assert.match(failure.message, /1024/);
        assert.equal(await count("chunks"), 0);
    });

    it("refuses the same chunk number twice in one index (23505), and lets another index use it", async () => {
        const userId = await seedUser("ana@example.com");
        const first = await insertIndex(await insertDocument(userId));
        const second = await insertIndex(await insertDocument(userId));
        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'one')", [first]);

        assert.equal(await codeOf("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'again')", [first]), "23505");

        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'one')", [second]);
        assert.equal(await count("chunks"), 2);
    });

    it("refuses a negative chunk number and empty text (23514)", async () => {
        const indexId = await insertIndex(await insertDocument(await seedUser("ana@example.com")));

        assert.equal(await codeOf("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, -1, 'text')", [indexId]), "23514", "chunk -1");
        assert.equal(await codeOf("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, '')", [indexId]), "23514", "empty text");
    });

    it("refuses a chunk of an index that does not exist (23503)", async () => {
        assert.equal(await codeOf("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'orphan')", [randomUUID()]), "23503");
    });

    it("has a primary key that starts with index_id, so the chunks of an index are found by it", async () => {
        const { rows } = await ownerPool.query<{ columns: string[] }>(
            `SELECT array_agg(a.attname::text ORDER BY k.position) AS columns
             FROM pg_index i
             CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = 'public.chunks'::regclass AND i.indisprimary
             GROUP BY i.indexrelid`
        );

        assert.deepEqual(rows.map((row) => row.columns), [["index_id", "chunk_index"]]);
    });
});

describe("the index_build_usage table", () => {
    it("has the columns id, user_id and accepted_at, all required, with these types", async () => {
        assert.deepEqual(await columnsOf("index_build_usage"), [
            { column_name: "accepted_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "id", data_type: "bigint", is_nullable: "NO" },
            { column_name: "user_id", data_type: "uuid", is_nullable: "NO" }
        ]);
    });

    it("numbers its rows itself and dates them when they are written", async () => {
        const userId = await seedUser("ana@example.com");

        const { rows } = await ownerPool.query<{ id: string; accepted_at: Date }>("INSERT INTO index_build_usage (user_id) VALUES ($1), ($1) RETURNING id, accepted_at", [userId]);

        assert.equal(rows.length, 2);
        assert.notEqual(rows[0].id, rows[1].id);
        assert.ok(rows[0].accepted_at instanceof Date);
        assert.ok(Math.abs(Date.now() - rows[0].accepted_at.getTime()) < 60_000);
    });

    it("refuses a row of a user that does not exist (23503)", async () => {
        assert.equal(await codeOf("INSERT INTO index_build_usage (user_id) VALUES ($1)", [randomUUID()]), "23503");
    });

    it("has an index on user_id and accepted_at, which counts one user's builds of the last day", async () => {
        assert.ok((await indexColumnsOf("index_build_usage")).some((columns) => columns.join(",") === "user_id,accepted_at"));
    });

    it("has an index on accepted_at alone, which counts the builds of every user in the last day", async () => {
        assert.ok((await indexColumnsOf("index_build_usage")).some((columns) => columns.join(",") === "accepted_at"));
    });
});

describe("what goes when something is deleted", () => {
    const seedEverything = async (email: string) => {
        const userId = await seedUser(email);
        const documentId = await insertDocument(userId);
        const indexId = await insertIndex(documentId);
        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'one'), ($1, 1, 'two')", [indexId]);
        await ownerPool.query("INSERT INTO index_build_usage (user_id) VALUES ($1), ($1)", [userId]);

        return { userId, documentId, indexId };
    };

    it("deleting a user removes their documents, indexes, chunks and usage rows, and leaves another user's", async () => {
        const ana = await seedEverything("ana@example.com");
        await seedEverything("bob@example.com");

        await ownerPool.query("DELETE FROM users WHERE id = $1", [ana.userId]);

        assert.equal(await count("documents"), 1);
        assert.equal(await count("document_indexes"), 1);
        assert.equal(await count("chunks"), 2);
        assert.equal(await count("index_build_usage"), 2);
        assert.equal((await ownerPool.query("SELECT 1 FROM documents WHERE user_id = $1", [ana.userId])).rowCount, 0);
    });

    it("deleting a document removes its indexes and their chunks, keeps the others', and keeps the usage rows: the day's builds are not given back", async () => {
        const ana = await seedEverything("ana@example.com");
        const other = await insertDocument(ana.userId);
        const otherIndex = await insertIndex(other);
        await ownerPool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'kept')", [otherIndex]);

        await ownerPool.query("DELETE FROM documents WHERE id = $1", [ana.documentId]);

        assert.equal(await count("documents"), 1);
        assert.equal(await count("document_indexes"), 1);
        assert.equal(await count("chunks"), 1);
        assert.equal(await count("index_build_usage"), 2, "the usage rows stay");
    });

    it("deleting an index removes its chunks and nothing else", async () => {
        const ana = await seedEverything("ana@example.com");

        await ownerPool.query("DELETE FROM document_indexes WHERE id = $1", [ana.indexId]);

        assert.equal(await count("chunks"), 0);
        assert.equal(await count("documents"), 1);
        assert.equal(await count("index_build_usage"), 2);
    });
});
