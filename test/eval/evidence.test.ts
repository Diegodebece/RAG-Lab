import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../../src/v1/utils/chunkText.util.js";
import { chunksOverlapping, computeChunkSpans, findEvidenceOccurrences, normalizeForMatching } from "../../src/eval/evidence.js";

// Where the annotated evidence of a question sits in the chunks of an index (D14). The harness cuts the document with the server's own
// chunker, finds the quote in the text with its whitespace collapsed (the chunker's own split), and asks which chunks the quote
// touches. The matching is exact and case-sensitive: a passage that is not found is listed and left out, never matched loosely.
//
// The contract this file gives the implementation (src/eval/evidence.ts; offsets count UTF-16 code units in the collapsed text, and an
// end is exclusive):
//   normalizeForMatching(text)                NFC, trimmed, every run of whitespace one space
//   computeChunkSpans(text, chunkSize)        [{ start, end }] of each chunk that chunkText(text, chunkSize) makes, in the collapsed text
//   findEvidenceOccurrences(text, quote)      [{ start, end }] of every occurrence of the normalized quote in the normalized text, in order
//   chunksOverlapping(spans, occurrence)      the indexes of the chunks whose span shares at least one character with the occurrence
// Every text here is invented.

describe("normalizeForMatching", () => {
    it("turns every run of whitespace, line breaks and tabs included, into one space, and trims the ends", () => {
        assert.equal(normalizeForMatching("  alpha   beta\n\ngamma\t\tdelta \r\n"), "alpha beta gamma delta");
    });

    it("treats the no-break space and the line separator as whitespace, as the chunker's split does", () => {
        assert.equal(normalizeForMatching(`alpha${String.fromCodePoint(0xa0)}beta${String.fromCodePoint(0x2028)}gamma`), "alpha beta gamma");
    });

    it("writes a letter with its accent as one character (NFC): 'e' and a combining accent become the precomposed letter", () => {
        const decomposed = `caf${String.fromCodePoint(0x65, 0x301)}`;
        const composed = `caf${String.fromCodePoint(0xe9)}`;

        assert.notEqual(decomposed, composed);
        assert.equal(normalizeForMatching(decomposed), composed);
    });

    it("keeps the case and everything that is not whitespace", () => {
        assert.equal(normalizeForMatching("Alpha-BETA, (gamma)!"), "Alpha-BETA, (gamma)!");
    });

    it("gives an empty text for a text of only whitespace", () => {
        assert.equal(normalizeForMatching(" \n\t "), "");
        assert.equal(normalizeForMatching(""), "");
    });
});

// a text of invented words with the given lengths, joined by the given separators in turn
const synthetic = (seed: number, words: number): string => {
    let state = seed;
    const next = (modulus: number): number => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state % modulus;
    };
    const separators = [" ", " ", " ", "  ", "\n", " \t "];
    let text = "";

    for (let index = 0; index < words; index++) {
        const length = next(12) === 0 ? 25 + next(30) : 1 + next(13);
        text += Array.from({ length }, (_, position) => String.fromCharCode(97 + ((index * 7 + position * 3 + next(5)) % 26))).join("");
        text += separators[next(separators.length)];
    }

    return text;
};

describe("computeChunkSpans", () => {
    it("gives the span of each chunk in the collapsed text, for a text whose words all fit: the chunks 'aaa bbb', 'ccc ddd' and 'eee'", () => {
        assert.deepEqual(computeChunkSpans("aaa bbb ccc ddd eee", 7), [{ start: 0, end: 7 }, { start: 8, end: 15 }, { start: 16, end: 19 }]);
    });

    it("counts the text as the chunker does, with its whitespace collapsed: line breaks, runs of spaces and ends do not move a span", () => {
        const spans = computeChunkSpans("\n  aaa\n\nbbb   ccc \t ddd\neee  ", 7);

        assert.deepEqual(spans, [{ start: 0, end: 7 }, { start: 8, end: 15 }, { start: 16, end: 19 }]);
    });

    it("handles a word longer than a chunk, which the chunker cuts into pieces with no space between them", () => {
        const text = "short abcdefghijklmnopqrstuvwxyz tail";
        const spans = computeChunkSpans(text, 10);

        assert.deepEqual(chunkText(text, 10), ["short", "abcdefghij", "klmnopqrst", "uvwxyz", "tail"]);
        assert.deepEqual(spans, [{ start: 0, end: 5 }, { start: 6, end: 16 }, { start: 16, end: 26 }, { start: 26, end: 32 }, { start: 33, end: 37 }]);
    });

    it("gives no span for a text that has no words", () => {
        assert.deepEqual(computeChunkSpans("  \n ", 10), []);
    });

    it("gives one span for a text that fits in one chunk", () => {
        assert.deepEqual(computeChunkSpans("just three words", 100), [{ start: 0, end: 16 }]);
    });

    it("agrees with chunkText on synthetic texts: each span, read from the collapsed text, is exactly its chunk, and the spans cover the text", () => {
        let checked = 0;

        for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
            const text = synthetic(seed, 60 + seed);
            const collapsed = normalizeForMatching(text);

            for (const size of [10, 25, 100, 300]) {
                const chunks = chunkText(text, size);
                const spans = computeChunkSpans(text, size);

                assert.equal(spans.length, chunks.length, `seed ${seed}, size ${size}: one span for each chunk`);

                for (const [position, span] of spans.entries()) {
                    assert.equal(collapsed.slice(span.start, span.end), chunks[position], `seed ${seed}, size ${size}, chunk ${position}`);

                    if (position > 0) {
                        const gap = span.start - spans[position - 1].end;
                        assert.ok(gap === 0 || gap === 1, `seed ${seed}, size ${size}: the chunks are next to each other, or a space apart`);
                        assert.equal(collapsed.slice(spans[position - 1].end, span.start), gap === 1 ? " " : "");
                    }
                }

                assert.equal(spans[0].start, 0);
                assert.equal(spans.at(-1)?.end, collapsed.length);
                checked += 1;
            }
        }

        assert.equal(checked, 48);
    });

    it("agrees with chunkText on a long word made of characters that take two code units, which the chunker never splits in the middle", () => {
        const wide = String.fromCodePoint(0x1f600);
        const text = `before ${wide.repeat(15)} after`;
        const spans = computeChunkSpans(text, 10);
        const collapsed = normalizeForMatching(text);

        assert.deepEqual(spans.map((span) => collapsed.slice(span.start, span.end)), chunkText(text, 10));
    });
});

describe("findEvidenceOccurrences", () => {
    const TEXT = "The alpha station records tides at dawn. The bravo lighthouse keeps a copper lantern burning. The charlie harbour stores nets.";

    it("finds a quote that is in the text, with its start and its exclusive end in the collapsed text", () => {
        const quote = "The bravo lighthouse keeps a copper lantern burning.";

        const occurrences = findEvidenceOccurrences(TEXT, quote);

        assert.equal(occurrences.length, 1);
        assert.equal(TEXT.slice(occurrences[0].start, occurrences[0].end), quote);
        assert.equal(occurrences[0].start, TEXT.indexOf(quote));
    });

    it("finds a quote at the very start of the text and one at the very end", () => {
        const first = findEvidenceOccurrences(TEXT, "The alpha station");
        const last = findEvidenceOccurrences(TEXT, "stores nets.");

        assert.deepEqual(first, [{ start: 0, end: 17 }]);
        assert.deepEqual(last, [{ start: TEXT.length - 12, end: TEXT.length }]);
    });

    it("finds every occurrence of a quote that is in the text more than once, in order", () => {
        const text = "red door. blue door. red door. green door. red door.";

        const occurrences = findEvidenceOccurrences(text, "red door.");

        assert.deepEqual(occurrences.map((occurrence) => occurrence.start), [0, 21, 43]);
        assert.ok(occurrences.every((occurrence) => text.slice(occurrence.start, occurrence.end) === "red door."));
    });

    it("does not match a different case: the matching is exact", () => {
        assert.deepEqual(findEvidenceOccurrences(TEXT, "the bravo lighthouse"), [], "a lower case 'the' is not 'The'");
        assert.deepEqual(findEvidenceOccurrences(TEXT, "THE BRAVO LIGHTHOUSE"), []);
    });

    it("matches a quote whose whitespace differs from the text's, since both are collapsed, and counts offsets in the collapsed text", () => {
        const text = "first line\n\nThe alpha   station\trecords tides\nat dawn.";
        const collapsed = normalizeForMatching(text);

        const occurrences = findEvidenceOccurrences(text, "The alpha station records   tides at\n dawn.");

        assert.equal(occurrences.length, 1);
        assert.equal(collapsed.slice(occurrences[0].start, occurrences[0].end), "The alpha station records tides at dawn.");
    });

    it("matches a quote and a text that write an accented letter differently, since both are NFC", () => {
        const text = `Le caf${String.fromCodePoint(0xe9)} ouvre tôt.`;

        assert.equal(findEvidenceOccurrences(text, `caf${String.fromCodePoint(0x65, 0x301)} ouvre`).length, 1);
    });

    it("finds nothing for a quote that is not in the text, for one that is only part of a longer sentence it paraphrases, and for an empty quote", () => {
        assert.deepEqual(findEvidenceOccurrences(TEXT, "The delta mill grinds wheat."), []);
        assert.deepEqual(findEvidenceOccurrences(TEXT, "The alpha station always records tides at dawn."), []);
        assert.deepEqual(findEvidenceOccurrences(TEXT, ""), []);
        assert.deepEqual(findEvidenceOccurrences(TEXT, "   \n "), []);
    });

    it("finds a quote that crosses the place where the chunker cut the text, because it looks at the whole text", () => {
        const text = "aaa bbb ccc ddd eee";

        assert.deepEqual(findEvidenceOccurrences(text, "bbb ccc"), [{ start: 4, end: 11 }]);
    });
});

describe("chunksOverlapping", () => {
    // 'aaa bbb' [0,7)  'ccc ddd' [8,15)  'eee' [16,19)
    const TEXT = "aaa bbb ccc ddd eee";
    const spans = computeChunkSpans(TEXT, 7);

    const chunksOf = (quote: string): number[][] => findEvidenceOccurrences(TEXT, quote).map((occurrence) => chunksOverlapping(spans, occurrence));

    it("gives the one chunk that holds a quote inside it, at the start, in the middle and at the end of the text", () => {
        assert.deepEqual(chunksOf("aaa"), [[0]], "at the start of the text");
        assert.deepEqual(chunksOf("ddd"), [[1]], "at the end of a chunk");
        assert.deepEqual(chunksOf("eee"), [[2]], "at the end of the text");
        assert.deepEqual(chunksOf("bbb"), [[0]], "the chunk next to it is not touched: its first character is a space away");
    });

    it("gives both chunks for a quote that crosses the cut between two chunks, in order", () => {
        assert.deepEqual(chunksOf("bbb ccc"), [[0, 1]]);
        assert.deepEqual(chunksOf("ddd eee"), [[1, 2]]);
        assert.deepEqual(chunksOf("bbb ccc ddd eee"), [[0, 1, 2]]);
    });

    it("gives the one chunk for a quote that is exactly its whole text", () => {
        assert.deepEqual(chunksOf("ccc ddd"), [[1]]);
        assert.deepEqual(chunksOf("aaa bbb"), [[0]]);
    });

    it("gives the chunks of each occurrence of a quote that is in the text more than once", () => {
        const repeated = "red door. red door.";
        const repeatedSpans = computeChunkSpans(repeated, 9);

        assert.deepEqual(findEvidenceOccurrences(repeated, "red door.").map((occurrence) => chunksOverlapping(repeatedSpans, occurrence)), [[0], [1]]);
    });

    it("gives both chunks for a quote inside a long word that the chunker cut in pieces with no space between them", () => {
        const text = "short abcdefghijklmnopqrstuvwxyz tail";
        const wordSpans = computeChunkSpans(text, 10);

        // 'ghijklmn' is at [12, 20): the end of the first piece and the start of the second
        const [occurrence] = findEvidenceOccurrences(text, "ghijklmn");

        assert.deepEqual(occurrence, { start: 12, end: 20 });
        assert.deepEqual(chunksOverlapping(wordSpans, occurrence), [1, 2]);
        assert.deepEqual(chunksOverlapping(wordSpans, { start: 14, end: 16 }), [1], "ending where the next piece starts does not touch it");
        assert.deepEqual(chunksOverlapping(wordSpans, { start: 16, end: 18 }), [2], "starting where the piece starts does not touch the one before");
    });

    it("gives no chunk for an occurrence that is outside every span", () => {
        assert.deepEqual(chunksOverlapping(spans, { start: 100, end: 110 }), []);
    });
});
