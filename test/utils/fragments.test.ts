import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFragments, getNeighborIndexes } from "../../src/v1/utils/fragments.util.js";
import type { ChunkText, ScoredChunk } from "../../src/v1/types/chunks.type.js";

// The fragments of a question: the matches, best score first, then the neighbors of each match, which is what the answer model
// will read. Ported from RAG Web, which cut one chunk on each side of a match; here the window (1 or 2) is a setting of the
// configuration (neighborWindow), so both functions take it. At window 1 the output is RAG Web's, so the first nine tests are
// RAG Web's, with the window written out. At window 2 the neighbors of one match come in document order: m-2, m-1, m+1, m+2
// (decision D7 of the plan; it was never measured, and layer 6 may change it).

const match = (chunkIndex: number, score: number): ScoredChunk => ({ chunkIndex, text: `chunk ${chunkIndex}`, score });

const chunk = (chunkIndex: number): ChunkText => ({ chunkIndex, text: `chunk ${chunkIndex}` });

describe("getNeighborIndexes at window 1 (RAG Web's tests)", () => {
    it("returns the previous and next position of each match", () => {
        assert.deepEqual(getNeighborIndexes([match(5, 0.9), match(10, 0.8)], 1), [4, 6, 9, 11]);
    });

    it("skips negative positions, positions that are matches, and duplicates", () => {
        assert.deepEqual(getNeighborIndexes([match(0, 0.9), match(1, 0.8), match(3, 0.7)], 1), [2, 4]);
    });

    it("returns nothing when there are no matches", () => {
        assert.deepEqual(getNeighborIndexes([], 1), []);
    });
});

describe("buildFragments at window 1 (RAG Web's tests)", () => {
    it("puts matches first in score order, then each match's previous and next chunk", () => {
        const fragments = buildFragments([match(5, 0.9), match(10, 0.8)], [chunk(4), chunk(6), chunk(9), chunk(11)], 1);

        assert.deepEqual(fragments.map((fragment) => [fragment.id, fragment.chunkIndex, fragment.retrieval]), [
            ["F1", 5, "match"],
            ["F2", 10, "match"],
            ["F3", 4, "neighbor"],
            ["F4", 6, "neighbor"],
            ["F5", 9, "neighbor"],
            ["F6", 11, "neighbor"]
        ]);
    });

    it("keeps the score on matches only", () => {
        const [first, neighbor] = buildFragments([match(2, 0.75)], [chunk(1)], 1);

        assert.equal(first.score, 0.75);
        assert.equal(neighbor.score, undefined);
        assert.equal(Object.hasOwn(neighbor, "score"), false, "a neighbor has no score key at all, so the JSON has none");
    });

    it("includes a chunk shared by two matches only once", () => {
        const fragments = buildFragments([match(3, 0.9), match(5, 0.8)], [chunk(2), chunk(4), chunk(6)], 1);

        assert.deepEqual(fragments.map((fragment) => fragment.chunkIndex), [3, 5, 2, 4, 6]);
    });

    it("never adds a match again as a neighbor", () => {
        const fragments = buildFragments([match(4, 0.9), match(5, 0.8)], [chunk(3), chunk(6)], 1);

        assert.deepEqual(fragments.map((fragment) => fragment.chunkIndex), [4, 5, 3, 6]);
    });

    it("skips neighbors that do not exist, such as past the end of the document", () => {
        const fragments = buildFragments([match(0, 0.9)], [], 1);

        assert.deepEqual(fragments.map((fragment) => fragment.id), ["F1"]);
    });

    it("returns no fragments when there are no matches", () => {
        assert.deepEqual(buildFragments([], [chunk(1)], 1), []);
    });
});

describe("getNeighborIndexes at window 2", () => {
    it("returns the two positions before and the two after each match, in document order for each match: m-2, m-1, m+1, m+2", () => {
        assert.deepEqual(getNeighborIndexes([match(5, 0.9)], 2), [3, 4, 6, 7]);
        assert.deepEqual(getNeighborIndexes([match(5, 0.9), match(20, 0.8)], 2), [3, 4, 6, 7, 18, 19, 21, 22]);
    });

    it("skips negative positions, positions that are matches, and duplicates", () => {
        assert.deepEqual(getNeighborIndexes([match(1, 0.9)], 2), [0, 2, 3], "position -1 is skipped");
        assert.deepEqual(getNeighborIndexes([match(0, 0.9), match(2, 0.8)], 2), [1, 3, 4], "0 and 2 are matches; 1 is shared by both and comes once");
    });

    it("lists a position that is a neighbor of two matches once, in its first place", () => {
        assert.deepEqual(getNeighborIndexes([match(5, 0.9), match(7, 0.8)], 2), [3, 4, 6, 8, 9], "6 is next to both, and 5 and 7 are matches");
        assert.deepEqual(getNeighborIndexes([match(5, 0.9), match(8, 0.8)], 2), [3, 4, 6, 7, 9, 10], "7 is within two of 5 and of 8, and comes once");
    });

    it("returns nothing when there are no matches", () => {
        assert.deepEqual(getNeighborIndexes([], 2), []);
    });

    it("does not change what window 1 returns for the same matches", () => {
        assert.deepEqual(getNeighborIndexes([match(5, 0.9), match(10, 0.8)], 1), [4, 6, 9, 11]);
        assert.notDeepEqual(getNeighborIndexes([match(5, 0.9), match(10, 0.8)], 2), [4, 6, 9, 11]);
    });
});

describe("buildFragments at window 2", () => {
    it("puts each match's neighbors after all the matches, in the order m-2, m-1, m+1, m+2", () => {
        const fragments = buildFragments([match(5, 0.9), match(10, 0.8)], [chunk(3), chunk(4), chunk(6), chunk(7), chunk(8), chunk(9), chunk(11), chunk(12)], 2);

        assert.deepEqual(fragments.map((fragment) => [fragment.id, fragment.chunkIndex, fragment.retrieval]), [
            ["F1", 5, "match"],
            ["F2", 10, "match"],
            ["F3", 3, "neighbor"],
            ["F4", 4, "neighbor"],
            ["F5", 6, "neighbor"],
            ["F6", 7, "neighbor"],
            ["F7", 8, "neighbor"],
            ["F8", 9, "neighbor"],
            ["F9", 11, "neighbor"],
            ["F10", 12, "neighbor"]
        ]);
    });

    it("skips negative positions, matches and duplicates, and a chunk that does not exist", () => {
        const fragments = buildFragments([match(1, 0.9), match(3, 0.8)], [chunk(0), chunk(2), chunk(4), chunk(5)], 2);

        assert.deepEqual(fragments.map((fragment) => fragment.chunkIndex), [1, 3, 0, 2, 4, 5], "no position -1, no match again, no chunk twice");
        assert.deepEqual(fragments.map((fragment) => fragment.retrieval), ["match", "match", "neighbor", "neighbor", "neighbor", "neighbor"]);
    });

    it("includes a chunk that is a neighbor of two matches once, in its first place", () => {
        const fragments = buildFragments([match(5, 0.9), match(8, 0.8)], [chunk(3), chunk(4), chunk(6), chunk(7), chunk(9), chunk(10)], 2);

        assert.deepEqual(fragments.map((fragment) => fragment.chunkIndex), [5, 8, 3, 4, 6, 7, 9, 10]);
        assert.equal(fragments.filter((fragment) => fragment.chunkIndex === 7).length, 1, "7 is within two of both matches");
    });

    it("gives consecutive ids F1 to Fn, whatever was skipped", () => {
        const fragments = buildFragments([match(0, 0.9), match(2, 0.8)], [chunk(1), chunk(3), chunk(4)], 2);

        assert.deepEqual(fragments.map((fragment) => fragment.id), fragments.map((_, position) => `F${position + 1}`));
        assert.equal(fragments.length, 5);
    });

    it("keeps the score on the matches only, and the text of each chunk", () => {
        const fragments = buildFragments([match(5, 0.75)], [chunk(3), chunk(4), chunk(6), chunk(7)], 2);

        assert.deepEqual(fragments, [
            { id: "F1", chunkIndex: 5, text: "chunk 5", retrieval: "match", score: 0.75 },
            { id: "F2", chunkIndex: 3, text: "chunk 3", retrieval: "neighbor" },
            { id: "F3", chunkIndex: 4, text: "chunk 4", retrieval: "neighbor" },
            { id: "F4", chunkIndex: 6, text: "chunk 6", retrieval: "neighbor" },
            { id: "F5", chunkIndex: 7, text: "chunk 7", retrieval: "neighbor" }
        ]);
    });

    it("returns no fragments when there are no matches", () => {
        assert.deepEqual(buildFragments([], [chunk(1), chunk(2)], 2), []);
    });

    it("gives at window 1 what it gave before, even when the neighbors given are the ones of window 2", () => {
        const fragments = buildFragments([match(5, 0.9)], [chunk(3), chunk(4), chunk(6), chunk(7)], 1);

        assert.deepEqual(fragments.map((fragment) => fragment.chunkIndex), [5, 4, 6], "the chunks two away are not used at window 1");
    });
});

// Findings F3 and T5: a score that is not a number must never become a fragment. JSON writes NaN and Infinity as null, so a match with
// such a score would be answered, and stored, as a match with no score at all.
describe("buildFragments: a score that is not a finite number", () => {
    for (const [label, score] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]] as const) {
        it(`throws for a match with a score of ${label}, at either window`, () => {
            assert.throws(() => buildFragments([match(5, 0.9), match(7, score)], [chunk(4), chunk(6)], 1), Error);
            assert.throws(() => buildFragments([match(7, score)], [], 2), Error);
        });
    }

    it("throws when only one of several scores is not finite, wherever it is in the list", () => {
        assert.throws(() => buildFragments([match(1, Number.NaN), match(2, 0.5), match(3, 0.4)], [], 1), Error);
        assert.throws(() => buildFragments([match(1, 0.9), match(2, 0.5), match(3, Number.NaN)], [], 1), Error);
    });

    it("accepts scores of 0, a negative number and 1: a finite score is never refused", () => {
        const fragments = buildFragments([match(1, 1), match(2, 0), match(3, -0.5)], [], 1);

        assert.deepEqual(fragments.map((fragment) => fragment.score), [1, 0, -0.5]);
    });
});
