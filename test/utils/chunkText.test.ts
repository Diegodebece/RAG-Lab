import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../../src/v1/utils/chunkText.util.js";

// half of a surrogate pair without its other half, i.e. an emoji cut in two
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The size is a required argument in RAG Lab: the chunk size is a setting of the index, so no size is ever picked by default.
describe("chunkText", () => {
    it("returns no chunks for empty or whitespace-only text", () => {
        assert.deepEqual(chunkText("", 1000), []);
        assert.deepEqual(chunkText(" \n\t ", 1000), []);
    });

    it("keeps short text in a single chunk with whitespace collapsed", () => {
        assert.deepEqual(chunkText("  one\n\ntwo\tthree  ", 1000), ["one two three"]);
    });

    it("packs whole words without exceeding the limit", () => {
        assert.deepEqual(chunkText("aaa bbb ccc ddd", 7), ["aaa bbb", "ccc ddd"]);
        assert.deepEqual(chunkText("aaa bbb ccc", 8), ["aaa bbb", "ccc"]);
    });

    it("fills a chunk up to exactly the limit", () => {
        assert.deepEqual(chunkText("ab cd ef", 5), ["ab cd", "ef"]);
    });

    it("throws a RangeError when it is called without a size: there is no default", () => {
        // a caller written in JavaScript, or a cast, can leave the size out; it must not fall back on 1,000
        const withoutSize = chunkText as unknown as (text: string) => string[];

        assert.throws(() => withoutSize("some words to chunk"), RangeError);
        assert.throws(() => chunkText("some words to chunk", undefined as unknown as number), RangeError);
    });

    it("cuts a word longer than the limit into pieces instead of failing", () => {
        assert.deepEqual(chunkText("ab abcdefghij cd", 4), ["ab", "abcd", "efgh", "ij", "cd"]);
    });

    it("never splits a surrogate pair when cutting a long word", () => {
        const chunks = chunkText("😀😀😀", 3);

        assert.deepEqual(chunks, ["😀", "😀", "😀"]);
    });

    it("fits a two-unit character such as an emoji in the smallest allowed limit", () => {
        assert.deepEqual(chunkText("😀", 2), ["😀"]);
        assert.deepEqual(chunkText("a😀b", 2), ["a", "😀", "b"]);
    });

    it("keeps every chunk non-empty, within the limit and free of split surrogate pairs", () => {
        const inputs = ["😀", "a😀", "😀😀😀", "ab😀cd ef", "x 😀 y", "aaaa bbbb 😀😀 cc"];

        for (const maxChars of [2, 3, 4, 5]) {
            for (const input of inputs) {
                const chunks = chunkText(input, maxChars);
                const label = `${JSON.stringify(input)} with limit ${maxChars}`;

                assert.ok(chunks.every((chunk) => chunk !== "" && chunk.length <= maxChars), label);
                assert.ok(chunks.every((chunk) => !LONE_SURROGATE.test(chunk)), label);
                // nothing lost or duplicated: same characters in the same order, ignoring whitespace
                assert.equal(chunks.join("").replace(/\s/g, ""), input.replace(/\s/g, ""), label);
            }
        }
    });

    it("chunks a document of 200,000 characters quickly, with or without spaces", () => {
        const started = performance.now();

        chunkText("palabra ".repeat(25000), 1000);
        chunkText("x".repeat(200000), 1000);

        assert.ok(performance.now() - started < 1000);
    });

    it("rejects a limit below 2, which a two-unit character could not fit", () => {
        assert.throws(() => chunkText("😀", 1), RangeError);
        assert.throws(() => chunkText("text", 1), RangeError);
        assert.throws(() => chunkText("text", 0), RangeError);
        assert.throws(() => chunkText("text", -5), RangeError);
    });

    it("rejects a limit that is not an integer", () => {
        assert.throws(() => chunkText("text", 2.5), RangeError);
        assert.throws(() => chunkText("text", Number.NaN), RangeError);
    });
});

// the chunk sizes the API allows (design section 4)
describe("chunkText at every chunk size the API allows", () => {
    // paragraphs of different lengths, with line breaks, blank lines, tabs and a few words longer than the smallest size
    const paragraph = (label: string, words: number): string => Array.from({ length: words }, (_, index) => `${label}${index}`).join(" ");
    const text = [
        paragraph("alpha", 120),
        "",
        paragraph("bravo", 900),
        "\n\n",
        `${paragraph("charlie", 40)}\n${"x".repeat(350)}\n`,
        paragraph("delta", 2200),
        "\t  \t",
        paragraph("echo", 5)
    ].join("\n");

    for (const size of [300, 500, 750, 1000, 2000, 5000]) {
        it(`size ${size}: every chunk fits, none holds a line break, and the chunks joined with spaces are the text with its whitespace collapsed`, () => {
            const chunks = chunkText(text, size);

            assert.ok(chunks.length > 1, "a text this long takes more than one chunk");
            assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= size), "every chunk is non-empty and at most the size");
            assert.ok(chunks.every((chunk) => !/[\r\n]/.test(chunk)), "no chunk holds a line break");
            // the long word (350 letters) is cut only where it is longer than the size, so for the larger sizes the text is whole
            const collapsed = text.trim().split(/\s+/).join(" ");

            if (size >= 350) {
                assert.equal(chunks.join(" "), collapsed);
            } else {
                assert.equal(chunks.join("").replace(/\s/g, ""), collapsed.replace(/\s/g, ""), "nothing lost or repeated, the cut word aside");
            }
        });
    }

    it("makes fewer, larger chunks as the size grows", () => {
        const counts = [300, 500, 750, 1000, 2000, 5000].map((size) => chunkText(text, size).length);

        for (let index = 1; index < counts.length; index++) {
            assert.ok(counts[index] < counts[index - 1], `sizes ${index - 1} and ${index}: ${counts[index - 1]} chunks, then ${counts[index]}`);
        }
    });
});
