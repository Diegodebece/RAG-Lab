import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ValidationResult } from "joi";

// The longest text is read when the limits load, so a small one is set before the validator is imported: the tests below
// write the texts at the edge of it without making a megabyte of them.
process.env.MAX_DOCUMENT_CHARACTERS = "50";

const { createDocumentSchema } = await import("../../src/v1/validators/documents.validator.js");

const VALID_TEXT = "A short invented text.";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (body: unknown): ValidationResult => createDocumentSchema.validate(body, { abortEarly: false });

const messagesOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.message);

const pathsOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const CHUNK_SIZE_MESSAGE = "Chunk size must be one of 300, 500, 750, 1000, 2000, 5000";
const EMBEDDING_MODEL_MESSAGE = "Embedding model must be one of qwen3-embedding:0.6b";

describe("createDocumentSchema: a valid body", () => {
    it("accepts a filename and a text, and nothing else is needed", () => {
        const result = validate({ filename: "notes.txt", text: VALID_TEXT });

        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, { filename: "notes.txt", text: VALID_TEXT });
    });

    it("accepts every chunk size the API allows and the embedding model it allows, and returns them unchanged", () => {
        for (const chunkSize of [300, 500, 750, 1000, 2000, 5000]) {
            const result = validate({ filename: "notes.txt", text: VALID_TEXT, chunkSize, embeddingModel: "qwen3-embedding:0.6b" });

            assert.equal(result.error, undefined, `chunk size ${chunkSize}: ${JSON.stringify(messagesOf(result))}`);
            assert.deepEqual(result.value, { filename: "notes.txt", text: VALID_TEXT, chunkSize, embeddingModel: "qwen3-embedding:0.6b" });
        }
    });

    it("normalizes the filename to NFC and trims it, and leaves the text as it was written (the service cleans it)", () => {
        const result = validate({ filename: "  Café.txt  ", text: `  ${VALID_TEXT}\r\n` });

        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, { filename: "Café.txt", text: `  ${VALID_TEXT}\r\n` });
    });
});

describe("createDocumentSchema: the filename", () => {
    it("refuses a filename that is missing, not a string, empty or only spaces", () => {
        const cases: [string, unknown, string][] = [
            ["missing", undefined, "Filename is required"],
            ["a number", 5, "Filename must be a string"],
            ["null", null, "Filename must be a string"],
            ["a list", ["a.txt"], "Filename must be a string"],
            ["empty", "", "Filename cannot be empty"],
            ["only spaces", "   ", "Filename cannot be empty"]
        ];

        for (const [label, filename, message] of cases) {
            const result = validate({ filename, text: VALID_TEXT });

            assert.deepEqual(messagesOf(result), [message], label);
            assert.deepEqual(pathsOf(result), ["filename"], label);
        }
    });

    it("refuses a filename of 256 characters and accepts one of 255 and one of a single character", () => {
        assert.deepEqual(messagesOf(validate({ filename: "x".repeat(256), text: VALID_TEXT })), ["Filename cannot have more than 255 characters"]);
        assert.equal(validate({ filename: "x".repeat(255), text: VALID_TEXT }).error, undefined);
        assert.equal(validate({ filename: "x", text: VALID_TEXT }).error, undefined);
    });

    it("refuses control and text-direction characters in a filename", () => {
        const names: Record<string, string> = {
            "null byte": `notes${String.fromCodePoint(0)}.txt`,
            "new line": `notes${String.fromCodePoint(0x0a)}.txt`,
            "tab": `notes${String.fromCodePoint(0x09)}.txt`,
            "delete": `notes${String.fromCodePoint(0x7f)}.txt`,
            "a C1 control": `notes${String.fromCodePoint(0x85)}.txt`,
            "right-to-left override": `invoice${String.fromCodePoint(0x202e)}txt.exe`,
            "left-to-right override": `invoice${String.fromCodePoint(0x202d)}txt.exe`,
            "right-to-left isolate": `invoice${String.fromCodePoint(0x2067)}txt.exe`,
            "pop directional isolate": `invoice${String.fromCodePoint(0x2069)}txt.exe`,
            "left-to-right mark": `invoice${String.fromCodePoint(0x200e)}txt.exe`,
            "right-to-left mark": `invoice${String.fromCodePoint(0x200f)}txt.exe`,
            "arabic letter mark": `invoice${String.fromCodePoint(0x061c)}txt.exe`
        };

        for (const [label, filename] of Object.entries(names)) {
            const result = validate({ filename, text: VALID_TEXT });

            assert.deepEqual(messagesOf(result), ["Filename contains control or text-direction characters"], label);
        }
    });

    it("accepts accents, Hebrew, emoji and spaces in a filename", () => {
        const names = [
            `Informe a${String.fromCodePoint(0xf1)}o 2026.txt`,
            `${String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd)}.txt`,
            "notes 😀.txt",
            "two  spaces inside.txt"
        ];

        for (const filename of names) {
            assert.equal(validate({ filename, text: VALID_TEXT }).error, undefined, filename);
        }
    });
});

describe("createDocumentSchema: the text", () => {
    it("refuses a text that is missing, empty or not a string", () => {
        for (const [label, text] of [["missing", undefined], ["empty", ""], ["a number", 5], ["null", null], ["a list", ["a", "b"]], ["an object", { a: 1 }]] as [string, unknown][]) {
            const result = validate({ filename: "a.txt", text });

            assert.equal(result.error === undefined, false, `${label}: refused`);
            assert.deepEqual(pathsOf(result), ["text"], label);
        }
    });

    it("refuses a text one character over MAX_DOCUMENT_CHARACTERS (50 here) and accepts one of exactly that length", () => {
        const over = validate({ filename: "a.txt", text: "x".repeat(51) });
        const exactly = validate({ filename: "a.txt", text: "x".repeat(50) });

        assert.equal(over.error === undefined, false, "51 characters");
        assert.deepEqual(pathsOf(over), ["text"]);
        assert.equal(exactly.error, undefined, "50 characters");
    });

    it("counts the length in UTF-16 units, like the database's character count: an emoji takes two", () => {
        assert.equal(validate({ filename: "a.txt", text: "😀".repeat(25) }).error, undefined, "25 emoji are 50 units");
        assert.equal(validate({ filename: "a.txt", text: "😀".repeat(26) }).error === undefined, false, "26 emoji are 52 units");
    });

    it("accepts a text that is only whitespace: it is the service that finds nothing readable in it", () => {
        assert.equal(validate({ filename: "a.txt", text: "   \n\t  " }).error, undefined);
    });
});

describe("createDocumentSchema: chunkSize and embeddingModel", () => {
    it("refuses a chunk size that is not one of the six, however it is written, with the cap's message", () => {
        for (const [label, chunkSize] of [["400", 400], ["a number as text", "500"], ["500.5", 500.5], ["null", null], ["zero", 0], ["negative", -300], ["a list", [500]], ["true", true], ["a very large number", 1e21]] as [string, unknown][]) {
            const result = validate({ filename: "a.txt", text: VALID_TEXT, chunkSize });

            assert.deepEqual(messagesOf(result), [CHUNK_SIZE_MESSAGE], label);
            assert.deepEqual(pathsOf(result), ["chunkSize"], label);
        }
    });

    it("refuses an embedding model other than the one the API allows, with the cap's message", () => {
        for (const [label, embeddingModel] of [["another model", "other"], ["the name without its tag", "qwen3-embedding"], ["a path", "../../api/pull"], ["an empty name", ""], ["a number", 5], ["null", null]] as [string, unknown][]) {
            const result = validate({ filename: "a.txt", text: VALID_TEXT, embeddingModel });

            assert.deepEqual(messagesOf(result), [EMBEDDING_MODEL_MESSAGE], label);
            assert.deepEqual(pathsOf(result), ["embeddingModel"], label);
        }
    });
});

describe("createDocumentSchema: fields that are not the client's to give", () => {
    it("refuses a question-time setting, an owner, a status, a hash and an id, each with its own message", () => {
        for (const key of ["topK", "userId", "status", "contentHash", "id", "characterCount", "createdAt", "indexes", "minScore", "overrides", "profileId"]) {
            const result = validate({ filename: "a.txt", text: VALID_TEXT, [key]: key === "topK" ? 5 : "x" });

            assert.deepEqual(messagesOf(result), [`"${key}" is not allowed`], key);
        }
    });

    it("reports every problem of a body, not only the first", () => {
        const result = validate({ filename: "", text: "", chunkSize: 400, topK: 5 });

        assert.equal(messagesOf(result).length, 4, JSON.stringify(messagesOf(result)));
    });
});
