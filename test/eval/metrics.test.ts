import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyMinScore, contextAtK, findRank, fullAtK, hitAtK, nearestRankPercentile, topScore } from "../../src/eval/metrics.js";

// The numbers of a sweep (D14): where the evidence of a question ranks among the matches, whether it is inside the top k, and whether
// the whole of it is inside what the answer model would read (the top k plus their neighbors).
//
// The contract this file gives the implementation (src/eval/metrics.ts):
//   a match is { chunkIndex, score }, and matches come in the order the API gave them: best first, so the first is rank 1
//   a passage is { occurrences: number[][] }: each occurrence of the quote in the text is the list of the chunks it touches
//   findRank(matches, passages)                    the rank (1 is the first match) of the first match that is a chunk of any occurrence of any
//                                                  passage; null when none is
//   hitAtK(matches, passages, k)                   whether that rank is k or better
//   fullAtK(matches, passages, k)                  whether every passage has an occurrence whose chunks are all among the first k matches
//   contextAtK(matches, passages, k, window)       the same, with the chunks of the first k matches and their neighbors up to `window` away
//   applyMinScore(matches, minScore)               the matches whose score is at least minScore, in order
//   nearestRankPercentile(values, percent)         the value at rank ceil(percent / 100 * n) of the values sorted up; the input is not changed
//   topScore(matches)                              the highest score, or null for no matches

const matchesOf = (...chunkIndexes: number[]) => chunkIndexes.map((chunkIndex, position) => ({ chunkIndex, score: 1 - position / 100 }));

describe("applyMinScore", () => {
    it("keeps a score equal to the minimum, drops one below it, and keeps the order", () => {
        const matches = [{ chunkIndex: 4, score: 0.9 }, { chunkIndex: 1, score: 0.3 }, { chunkIndex: 7, score: 0.29 }, { chunkIndex: 2, score: 0 }];

        assert.deepEqual(applyMinScore(matches, 0.3), [{ chunkIndex: 4, score: 0.9 }, { chunkIndex: 1, score: 0.3 }]);
        assert.deepEqual(applyMinScore(matches, 0), matches, "a minimum of 0 keeps a score of 0");
        assert.deepEqual(applyMinScore(matches, 0.95), []);
    });

    it("does not change the list it is given", () => {
        const matches = [{ chunkIndex: 4, score: 0.9 }, { chunkIndex: 1, score: 0.1 }];

        applyMinScore(matches, 0.5);

        assert.equal(matches.length, 2);
    });
});

describe("findRank and hitAtK", () => {
    const passage = { occurrences: [[6]] };

    it("gives the place of the first match that is a chunk of the evidence, counting from 1", () => {
        assert.equal(findRank(matchesOf(6, 2, 9), [passage]), 1);
        assert.equal(findRank(matchesOf(2, 9, 6, 1), [passage]), 3);
    });

    it("gives null when no match is a chunk of the evidence", () => {
        assert.equal(findRank(matchesOf(1, 2, 3), [passage]), null);
        assert.equal(findRank([], [passage]), null);
    });

    it("takes a match on any chunk of an occurrence that crosses two chunks, and on any occurrence when the quote is there more than once", () => {
        assert.equal(findRank(matchesOf(1, 5, 9), [{ occurrences: [[4, 5]] }]), 2, "the second chunk of a quote that crosses a cut");
        assert.equal(findRank(matchesOf(1, 30, 9), [{ occurrences: [[4], [30]] }]), 2, "the second occurrence");
    });

    it("takes the first match that touches any of the passages of a case with several", () => {
        const passages = [{ occurrences: [[5]] }, { occurrences: [[8]] }];

        assert.equal(findRank(matchesOf(1, 8, 5), passages), 2);
    });

    it("says hit@k when the rank is k or better, and not when it is worse or there is none", () => {
        const matches = matchesOf(2, 9, 6, 1);

        assert.equal(hitAtK(matches, [passage], 2), false);
        assert.equal(hitAtK(matches, [passage], 3), true, "rank 3 is a hit at k = 3");
        assert.equal(hitAtK(matches, [passage], 30), true);
        assert.equal(hitAtK(matchesOf(1, 2), [passage], 30), false);
    });
});

describe("fullAtK", () => {
    it("needs every chunk of a quote that crosses a cut: one of the two chunks is a hit and is not full", () => {
        const passages = [{ occurrences: [[4, 5]] }];

        assert.equal(hitAtK(matchesOf(4, 9), passages, 2), true);
        assert.equal(fullAtK(matchesOf(4, 9), passages, 2), false, "chunk 5 is not among the matches");
        assert.equal(fullAtK(matchesOf(4, 9, 5), passages, 2), false, "chunk 5 is a match, but after the first two");
        assert.equal(fullAtK(matchesOf(4, 9, 5), passages, 3), true);
    });

    it("is satisfied by any one occurrence of a quote that is in the text more than once", () => {
        const passages = [{ occurrences: [[2], [7, 8]] }];

        assert.equal(fullAtK(matchesOf(2), passages, 1), true, "the first occurrence is there whole");
        assert.equal(fullAtK(matchesOf(7), passages, 1), false, "the second occurrence needs 7 and 8");
        assert.equal(fullAtK(matchesOf(7, 8), passages, 2), true);
    });

    it("needs every passage of a case with several: the whole evidence, and not one passage of it", () => {
        const passages = [{ occurrences: [[2]] }, { occurrences: [[9]] }];

        assert.equal(fullAtK(matchesOf(2, 5), passages, 2), false);
        assert.equal(hitAtK(matchesOf(2, 5), passages, 2), true, "but one of them is a hit");
        assert.equal(fullAtK(matchesOf(2, 5, 9), passages, 3), true);
        assert.equal(fullAtK(matchesOf(2, 5, 9), passages, 2), false);
    });

    it("counts only the first k matches, and uses all the matches when k is larger than their number", () => {
        assert.equal(fullAtK(matchesOf(1, 2, 3), [{ occurrences: [[3]] }], 2), false);
        assert.equal(fullAtK(matchesOf(1, 2, 3), [{ occurrences: [[3]] }], 30), true);
    });
});

describe("contextAtK", () => {
    it("reads the chunks the answer model would read: the first k matches and the chunks up to `window` away from each", () => {
        const matches = matchesOf(4, 20);

        assert.equal(fullAtK(matches, [{ occurrences: [[5]] }], 1), false, "chunk 5 is not a match");
        assert.equal(contextAtK(matches, [{ occurrences: [[5]] }], 1, 1), true, "but it is next to the match 4");
        assert.equal(contextAtK(matches, [{ occurrences: [[3]] }], 1, 1), true, "on either side");
        assert.equal(contextAtK(matches, [{ occurrences: [[6]] }], 1, 1), false, "two away is not in a window of 1");
        assert.equal(contextAtK(matches, [{ occurrences: [[6]] }], 1, 2), true, "but it is in a window of 2");
        assert.equal(contextAtK(matches, [{ occurrences: [[2]] }], 1, 2), true);
        assert.equal(contextAtK(matches, [{ occurrences: [[7]] }], 1, 2), false);
    });

    it("counts only the neighbors of the first k matches", () => {
        assert.equal(contextAtK(matchesOf(4, 20), [{ occurrences: [[21]] }], 1, 1), false, "21 is next to the second match");
        assert.equal(contextAtK(matchesOf(4, 20), [{ occurrences: [[21]] }], 2, 1), true);
    });

    it("needs the whole passage and all the passages, covered by matches and neighbors together", () => {
        const matches = matchesOf(4, 20);

        assert.equal(contextAtK(matches, [{ occurrences: [[4, 5]] }], 1, 1), true, "a match and its neighbor");
        assert.equal(contextAtK(matches, [{ occurrences: [[5, 6]] }], 1, 1), false, "6 is out of the window");
        assert.equal(contextAtK(matches, [{ occurrences: [[5]] }, { occurrences: [[21]] }], 2, 1), true);
        assert.equal(contextAtK(matches, [{ occurrences: [[5]] }, { occurrences: [[40]] }], 2, 1), false);
    });

    it("is at least as good as fullAtK, and the same with no neighbors in play", () => {
        const matches = matchesOf(3, 9, 12);
        const passages = [{ occurrences: [[9]] }];

        assert.equal(fullAtK(matches, passages, 2), true);
        assert.equal(contextAtK(matches, passages, 2, 1), true);
        assert.equal(contextAtK(matches, [{ occurrences: [[100]] }], 3, 2), false);
    });
});

describe("nearestRankPercentile", () => {
    const upTo = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

    it("gives the only value, for p50 and for p95, of one value", () => {
        assert.equal(nearestRankPercentile([7], 50), 7);
        assert.equal(nearestRankPercentile([7], 95), 7);
    });

    it("gives the lower value for p50 and the higher for p95 of two values", () => {
        assert.equal(nearestRankPercentile([10, 20], 50), 10);
        assert.equal(nearestRankPercentile([10, 20], 95), 20);
    });

    it("gives the 10th and the 19th of 20 values", () => {
        assert.equal(nearestRankPercentile(upTo(20), 50), 10);
        assert.equal(nearestRankPercentile(upTo(20), 95), 19);
    });

    it("gives the 50th and the 95th of 100 values", () => {
        assert.equal(nearestRankPercentile(upTo(100), 50), 50);
        assert.equal(nearestRankPercentile(upTo(100), 95), 95);
    });

    it("sorts the values itself, numbers and not text, and leaves the list it was given as it was", () => {
        const values = [30, 4, 100, 25, 9, 1, 77, 5, 60, 2];
        const copy = [...values];

        assert.equal(nearestRankPercentile(values, 50), 9, "the 5th of 1, 2, 4, 5, 9, 25, 30, 60, 77, 100; sorted as text 100 would come before 2");
        assert.equal(nearestRankPercentile(values, 95), 100);
        assert.deepEqual(values, copy);
    });

    it("works with decimals, the way latencies are", () => {
        assert.equal(nearestRankPercentile([0.5, 0.25, 0.75, 0.125], 50), 0.25);
    });
});

describe("topScore", () => {
    it("gives the highest score of the matches, whatever their order, and null for none", () => {
        assert.equal(topScore([{ chunkIndex: 1, score: 0.2 }, { chunkIndex: 2, score: 0.61 }, { chunkIndex: 3, score: 0.4 }]), 0.61);
        assert.equal(topScore([{ chunkIndex: 1, score: -0.5 }]), -0.5);
        assert.equal(topScore([]), null);
    });
});
