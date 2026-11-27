import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ValidationResult } from "joi";
import { createDocumentIndexSchema } from "../../src/v1/validators/documentIndexes.validator.js";

// validated the way validateBodyMiddleware does it (an absent body is read as {}): every problem is collected
const validate = (body: unknown): ValidationResult => createDocumentIndexSchema.validate(body, { abortEarly: false });

const messagesOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.message);

const pathsOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const CHUNK_SIZE_MESSAGE = "Chunk size must be one of 300, 500, 750, 1000, 2000, 5000";
const EMBEDDING_MODEL_MESSAGE = "Embedding model must be one of qwen3-embedding:0.6b";

describe("createDocumentIndexSchema", () => {
    it("accepts an empty body: the size and the model then come from the default profile", () => {
        const result = validate({});

        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, {});
    });

    it("accepts each of the six chunk sizes and the one embedding model, returned unchanged", () => {
        for (const chunkSize of [300, 500, 750, 1000, 2000, 5000]) {
            const result = validate({ chunkSize, embeddingModel: "qwen3-embedding:0.6b" });

            assert.equal(result.error, undefined, `chunk size ${chunkSize}`);
            assert.deepEqual(result.value, { chunkSize, embeddingModel: "qwen3-embedding:0.6b" });
        }

        assert.deepEqual(validate({ chunkSize: 500 }).value, { chunkSize: 500 });
        assert.deepEqual(validate({ embeddingModel: "qwen3-embedding:0.6b" }).value, { embeddingModel: "qwen3-embedding:0.6b" });
    });

    it("refuses a chunk size that is not one of the six, however it is written, with the cap's message", () => {
        for (const [label, chunkSize] of [["400", 400], ["a number as text", "500"], ["500.5", 500.5], ["null", null], ["zero", 0], ["negative", -300], ["a list", [500]], ["true", true]] as [string, unknown][]) {
            const result = validate({ chunkSize });

            assert.deepEqual(messagesOf(result), [CHUNK_SIZE_MESSAGE], label);
            assert.deepEqual(pathsOf(result), ["chunkSize"], label);
        }
    });

    it("refuses an embedding model other than the one the API allows, with the cap's message", () => {
        for (const [label, embeddingModel] of [["another model", "other"], ["a path", "../../api/pull"], ["an empty name", ""], ["a number", 5], ["null", null]] as [string, unknown][]) {
            const result = validate({ embeddingModel });

            assert.deepEqual(messagesOf(result), [EMBEDDING_MODEL_MESSAGE], label);
            assert.deepEqual(pathsOf(result), ["embeddingModel"], label);
        }
    });

    it("refuses a question-time setting, an owner, a status, a hash and an id, each with its own message", () => {
        for (const key of ["topK", "userId", "status", "contentHash", "id", "documentId", "chunkCount", "minScore", "overrides", "profileId"]) {
            const result = validate({ [key]: key === "topK" ? 5 : "x" });

            assert.deepEqual(messagesOf(result), [`"${key}" is not allowed`], key);
        }
    });

    it("refuses the fields of an upload: this route builds an index of a document that is already there", () => {
        for (const key of ["filename", "text"]) {
            assert.deepEqual(messagesOf(validate({ [key]: "x" })), [`"${key}" is not allowed`], key);
        }
    });

    it("refuses a body that is not an object", () => {
        for (const body of ["text", 5, [500], true]) {
            assert.equal(validate(body).error === undefined, false, JSON.stringify(body));
        }
    });

    it("reports every problem of a body, not only the first", () => {
        assert.equal(messagesOf(validate({ chunkSize: 400, embeddingModel: "other", topK: 5 })).length, 3);
    });
});
