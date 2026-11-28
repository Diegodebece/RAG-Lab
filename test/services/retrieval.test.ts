import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { padVector } from "../doubles/fakeOllama.js";

// findFragmentsService(userId, indexId, questionVector, { topK, minScore, neighborWindow }): the closest chunks of ONE index of the
// user's (cosine similarity, exact search over the index's chunks) and their neighbors. Ported from RAG Web's query, which searched
// a document; here it searches an index, takes topK and minScore from the configuration, and checks the owner and the status again
// (the caller already did: this is defence in depth). The vectors are integer vectors, whose cosine similarities are exact: the
// question is (1, 0, ...), a chunk (3, 4, ...) scores exactly 0.6 and (4, 3, ...) exactly 0.8.
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { findFragmentsService } = await import("../../src/v1/services/retrieval.service.js");
const { seedDocument, seedIndex, seedUser } = await import("../documentsFixtures.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const QUESTION = padVector([1, 0]);

const OPTIONS = { topK: 10, minScore: 0, neighborWindow: 1 } as const;

// one short invented text per chunk
const textsOf = (label: string, count: number): string[] => Array.from({ length: count }, (_, position) => `${label} ${position}`);

// the positions, the kind and the score of each fragment, in order, which is all a ranking is
const summary = (fragments: { chunkIndex: number; retrieval: string; score?: number }[]) =>
    fragments.map((fragment) => [fragment.chunkIndex, fragment.retrieval, fragment.score]);

describe("findFragmentsService: the ranking", () => {
    it("ranks the chunks by cosine similarity, highest first, with the exact scores, and breaks a tie by the position in the document", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, {
            status: "ready",
            chunks: textsOf("rank", 6),
            // scores: 0, 0.6, 0.8, 1, 1, -1
            vectors: [[0, 1], [3, 4], [4, 3], [1, 0], [1, 0], [-1, 0]]
        });

        const fragments = await findFragmentsService(userId, index.id, QUESTION, { topK: 10, minScore: 0.5, neighborWindow: 1 });

        assert.deepEqual(summary(fragments), [
            [3, "match", 1],
            [4, "match", 1],
            [2, "match", 0.8],
            [1, "match", 0.6],
            [5, "neighbor", undefined],
            [0, "neighbor", undefined]
        ]);
        assert.deepEqual(fragments.map((fragment) => fragment.id), ["F1", "F2", "F3", "F4", "F5", "F6"]);
        assert.deepEqual(fragments.map((fragment) => fragment.text), [3, 4, 2, 1, 5, 0].map((position) => `rank ${position}`));
    });

    it("returns the score as a number, and none at all on a neighbor", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("score", 3), vectors: [[0, 1], [3, 4], [0, 1]] });

        const [match, ...neighbors] = await findFragmentsService(userId, index.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 1 });

        assert.equal(typeof match.score, "number");
        assert.equal(match.score, 0.6);
        assert.equal(neighbors.length, 2);

        for (const neighbor of neighbors) {
            assert.equal(Object.hasOwn(neighbor, "score"), false);
        }
    });

    it("keeps a chunk whose score is equal to minScore, and drops one just below it", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, {
            status: "ready",
            chunks: textsOf("edge", 4),
            // exactly 0.6, just below 0.6 (about 0.599), exactly 1, and 0
            vectors: [[3, 4], [3, 4.01], [1, 0], [0, 1]]
        });

        const fragments = await findFragmentsService(userId, index.id, QUESTION, { topK: 10, minScore: 0.6, neighborWindow: 1 });
        const matches = fragments.filter((fragment) => fragment.retrieval === "match");

        assert.deepEqual(matches.map((match) => [match.chunkIndex, match.score]), [[2, 1], [0, 0.6]], "0.6 is kept, 0.599 is not");
    });

    it("returns at most topK matches, the best ones", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, {
            status: "ready",
            chunks: textsOf("top", 6),
            vectors: [[1, 0], [4, 3], [1, 0], [3, 4], [1, 0], [0, 1]]
        });

        for (const topK of [1, 2, 3]) {
            const matches = (await findFragmentsService(userId, index.id, QUESTION, { topK, minScore: 0.3, neighborWindow: 1 })).filter((fragment) => fragment.retrieval === "match");

            assert.equal(matches.length, topK, `topK ${topK}`);
        }

        const best = (await findFragmentsService(userId, index.id, QUESTION, { topK: 3, minScore: 0.3, neighborWindow: 1 })).filter((fragment) => fragment.retrieval === "match");
        assert.deepEqual(best.map((match) => match.chunkIndex), [0, 2, 4], "the three chunks that score 1, in document order");
    });

    it("takes topK and minScore from its argument and never from a constant: the same index answers differently with other options", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("params", 4), vectors: [[1, 0], [4, 3], [3, 4], [0, 1]] });
        const matchesOf = async (topK: number, minScore: number) =>
            (await findFragmentsService(userId, index.id, QUESTION, { topK, minScore, neighborWindow: 1 })).filter((fragment) => fragment.retrieval === "match").map((fragment) => fragment.chunkIndex);

        assert.deepEqual(await matchesOf(10, 0), [0, 1, 2, 3], "everything, with a score of 0 included");
        assert.deepEqual(await matchesOf(10, 0.7), [0, 1]);
        assert.deepEqual(await matchesOf(1, 0.7), [0]);
        assert.deepEqual(await matchesOf(10, 1), [0], "a score of exactly 1 passes a minimum of 1");
    });
});

// Findings F3 and T5. PostgreSQL treats NaN as greater than every number, so a chunk whose score is NaN passes "score >= minScore" and
// sorts after every real score: it would be returned as a match (its score would be null in the JSON). The cosine similarity of the
// question (1, 1) and a chunk (3e38, 3e38) overflows float4 (the products are infinite: infinity over infinity), and a chunk (0, 1e-30)
// against the question (1, 0) underflows (0 over 0): both give NaN in this database's pgvector, and only the owner can store such a
// chunk (the API refuses a vector like that from a model).
describe("findFragmentsService: a chunk whose score is NaN", () => {
    const matchesOf = (fragments: { chunkIndex: number; retrieval: string }[]): number[] => fragments.filter((fragment) => fragment.retrieval === "match").map((fragment) => fragment.chunkIndex);

    it("does not return a chunk whose norm overflows float4 as a match, whatever topK and minScore are", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, {
            status: "ready",
            chunks: textsOf("overflow", 5),
            // scores against (1, 1): 1, 0.707, 0.707, 0.707, NaN
            vectors: [[1, 1], [0, 1], [0, 1], [0, 1], [3e38, 3e38]]
        });

        const fragments = await findFragmentsService(userId, index.id, padVector([1, 1]), { topK: 10, minScore: 0, neighborWindow: 1 });

        assert.deepEqual(matchesOf(fragments), [0, 1, 2, 3], "the chunk of position 4 is not among the matches");

        for (const fragment of fragments) {
            assert.ok(fragment.score === undefined || Number.isFinite(fragment.score), `chunk ${fragment.chunkIndex} has a score of ${String(fragment.score)}`);
        }
    });

    it("does not return a chunk whose norm underflows float4 as a match", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("underflow", 5), vectors: [[3, 4], [0, 1], [0, 1], [0, 1], [0, 1e-30]] });

        const fragments = await findFragmentsService(userId, index.id, QUESTION, { topK: 10, minScore: 0.3, neighborWindow: 1 });

        assert.deepEqual(summary(fragments), [[0, "match", 0.6], [1, "neighbor", undefined]]);
    });

    it("does not let it take a place among the topK, and returns an empty list when nothing else reaches minScore", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const only = await seedIndex(document.id, { status: "ready", chunkSize: 300, chunks: textsOf("only", 3), vectors: [[0, 1], [0, 1], [0, 1e-30]] });

        assert.deepEqual(await findFragmentsService(userId, only.id, QUESTION, { topK: 3, minScore: 0.3, neighborWindow: 1 }), []);
    });

    it("can still return a chunk that scores NaN as a neighbor of a match: it is text next to a match and has no score", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("next", 3), vectors: [[3, 4], [0, 1e-30], [0, 1]] });

        const fragments = await findFragmentsService(userId, index.id, QUESTION, { topK: 3, minScore: 0.3, neighborWindow: 1 });

        assert.deepEqual(summary(fragments), [[0, "match", 0.6], [1, "neighbor", undefined]]);
    });
});

describe("findFragmentsService: the neighbors", () => {
    it("adds one neighbor on each side at window 1, and two at window 2, in the order m-2, m-1, m+1, m+2", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("window", 7), vectors: [[0, 1], [0, 1], [0, 1], [1, 0], [0, 1], [0, 1], [0, 1]] });

        const one = await findFragmentsService(userId, index.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 1 });
        const two = await findFragmentsService(userId, index.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 2 });

        assert.deepEqual(summary(one), [[3, "match", 1], [2, "neighbor", undefined], [4, "neighbor", undefined]]);
        assert.deepEqual(summary(two), [[3, "match", 1], [1, "neighbor", undefined], [2, "neighbor", undefined], [4, "neighbor", undefined], [5, "neighbor", undefined]]);
        assert.deepEqual(two.map((fragment) => fragment.text), [3, 1, 2, 4, 5].map((position) => `window ${position}`));
    });

    it("never goes before the first chunk or past the last one", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const atTheStart = await seedIndex(document.id, { status: "ready", chunkSize: 300, chunks: textsOf("start", 4), vectors: [[1, 0], [0, 1], [0, 1], [0, 1]] });
        const atTheEnd = await seedIndex(document.id, { status: "ready", chunkSize: 500, chunks: textsOf("end", 4), vectors: [[0, 1], [0, 1], [0, 1], [1, 0]] });

        const first = await findFragmentsService(userId, atTheStart.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 2 });
        const last = await findFragmentsService(userId, atTheEnd.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 2 });

        assert.deepEqual(first.map((fragment) => fragment.chunkIndex), [0, 1, 2]);
        assert.deepEqual(last.map((fragment) => fragment.chunkIndex), [3, 1, 2]);
    });

    it("never adds a match again as a neighbor, and a chunk next to two matches comes once", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("pair", 6), vectors: [[0, 1], [0, 1], [1, 0], [1, 0], [0, 1], [0, 1]] });

        const one = await findFragmentsService(userId, index.id, QUESTION, { topK: 2, minScore: 0.3, neighborWindow: 1 });
        const two = await findFragmentsService(userId, index.id, QUESTION, { topK: 2, minScore: 0.3, neighborWindow: 2 });

        assert.deepEqual(one.map((fragment) => fragment.chunkIndex), [2, 3, 1, 4]);
        assert.deepEqual(two.map((fragment) => fragment.chunkIndex), [2, 3, 0, 1, 4, 5]);

        for (const fragments of [one, two]) {
            assert.equal(new Set(fragments.map((fragment) => fragment.chunkIndex)).size, fragments.length, "no chunk twice");
        }
    });
});

describe("findFragmentsService: which chunks it searches", () => {
    it("searches only the index it is given: another index of the same document is never mixed in, neighbors included", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        // the other index has chunks at the same positions with better vectors and other texts
        const other = await seedIndex(document.id, { status: "ready", chunkSize: 500, chunks: textsOf("other", 5), vectors: [[1, 0], [1, 0], [1, 0], [1, 0], [1, 0]] });
        const wanted = await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: textsOf("wanted", 5), vectors: [[0, 1], [3, 4], [0, 1], [0, 1], [0, 1]] });

        const fragments = await findFragmentsService(userId, wanted.id, QUESTION, { topK: 3, minScore: 0.3, neighborWindow: 1 });

        assert.deepEqual(fragments.map((fragment) => fragment.text), ["wanted 1", "wanted 0", "wanted 2"]);
        assert.ok(fragments.every((fragment) => !fragment.text.startsWith("other")));
        assert.deepEqual((await findFragmentsService(userId, other.id, QUESTION, { topK: 1, minScore: 0.3, neighborWindow: 1 })).map((fragment) => fragment.text), ["other 0", "other 1"]);
    });

    it("returns nothing for another user's index, even one that is ready and has the best matches", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        const document = await seedDocument(ana);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("private", 3), vectors: [[1, 0], [1, 0], [1, 0]] });

        assert.deepEqual(await findFragmentsService(bob, index.id, QUESTION, OPTIONS), []);
        assert.equal((await findFragmentsService(ana, index.id, QUESTION, OPTIONS)).length, 3, "the owner finds them");
    });

    it("returns nothing for an index that is not ready, whatever vectors it already holds, and for an index that does not exist", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);

        for (const [position, status] of (["queued", "indexing", "failed"] as const).entries()) {
            const index = await seedIndex(document.id, { status, chunkSize: [300, 500, 750][position], chunks: textsOf(status, 3), vectors: [[1, 0], [1, 0], [1, 0]] });

            assert.deepEqual(await findFragmentsService(userId, index.id, QUESTION, OPTIONS), [], status);
        }

        assert.deepEqual(await findFragmentsService(userId, randomUUID(), QUESTION, OPTIONS), [], "an unknown index");
    });

    it("returns an empty list, and not neighbors, when no chunk reaches minScore", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        const index = await seedIndex(document.id, { status: "ready", chunks: textsOf("far", 4), vectors: [[0, 1], [0, 0, 1], [-1, 0], [1, 4]] });

        assert.deepEqual(await findFragmentsService(userId, index.id, QUESTION, { topK: 10, minScore: 0.3, neighborWindow: 2 }), []);
    });
});
