import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeTestPools, resetTestDatabase } from "./testDatabase.js";
import { padVector } from "../doubles/fakeOllama.js";
import { seedDocument, seedIndex, seedUser, vectorLiteral } from "../documentsFixtures.js";

// The premise of the retrieval tests: with integer vectors, pgvector's cosine similarity is exact in the number the search reads back
// (1 - cosine distance, as a float8), so a test can put a score right on a threshold. A question (1, 0, ...) against a chunk (3, 4, ...)
// is exactly 0.6, and a chunk (3, 4.01, ...) is just below it. It covers behavior that exists today: the `vectors` option of seedIndex
// and the query RAG Web ran, which layer 5's retrieval service adapts.
const { pool } = await import("../../src/v1/config/db.config.js");

before(resetTestDatabase);

after(closeTestPools);

describe("scores of integer vectors", () => {
    it("are exact: 0, 0.6, 0.8 and 1, and a score of exactly 0.6 passes a minimum of 0.6 while 0.599 does not", async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, {
            status: "ready",
            chunks: ["zero", "six tenths", "eight tenths", "one", "also one", "just below six tenths"],
            vectors: [[0, 1], [3, 4], [4, 3], [1, 0], [1, 0], [3, 4.01]]
        });
        const question = vectorLiteral(padVector([1, 0]));

        const { rows: all } = await pool.query<{ chunkIndex: number; score: number }>(
            "SELECT chunk_index AS \"chunkIndex\", (1 - (embedding <=> $2::vector))::float8 AS score FROM chunks WHERE index_id = $1 ORDER BY chunk_index",
            [index.id, question]
        );

        assert.deepEqual(all.slice(0, 5).map((row) => row.score), [0, 0.6, 0.8, 1, 1]);
        assert.ok(all[5].score < 0.6 && all[5].score > 0.59);

        const { rows: kept } = await pool.query<{ chunkIndex: number }>(
            `SELECT chunk_index AS "chunkIndex" FROM chunks WHERE index_id = $1 AND embedding IS NOT NULL AND 1 - (embedding <=> $2::vector) >= $3
             ORDER BY embedding <=> $2::vector, chunk_index`,
            [index.id, question, 0.6]
        );

        assert.deepEqual(kept.map((row) => row.chunkIndex), [3, 4, 2, 1], "the tie of 3 and 4 goes by position, and 0.6 itself is kept");
    });
});
