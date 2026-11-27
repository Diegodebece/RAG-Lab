import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startFakeOllama } from "../doubles/fakeOllama.js";

// Question routes (layer 5 and later) choose an index of a document through findReadyIndexService, which never builds
// one: only the two document endpoints build, and they are capped per user. The model server is a double that records
// every request, so "no request to Ollama" can be checked.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { findReadyIndexService } = await import("../../src/v1/services/documentIndexes.service.js");
const { AppError } = await import("../../src/v1/utils/appError.util.js");
const { DEFAULT_EMBEDDING_MODEL, countRows, seedDocument, seedIndex, seedUser } = await import("../documentsFixtures.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(async () => {
    await fake.close();
    await closeTestPools();
});

const isAppError = (status: number, message: string) => (error: unknown): boolean =>
    error instanceof AppError && error.status === status && error.message === message;

const rowsOfEverything = async (): Promise<number[]> => [
    await countRows("documents"), await countRows("document_indexes"), await countRows("chunks"), await countRows("index_build_usage")
];

describe("findReadyIndexService", () => {
    it("returns the caller's ready index for the document, the chunk size and the model", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        await seedIndex(document.id, { status: "ready", chunkSize: 1000 });
        const wanted = await seedIndex(document.id, { status: "ready", chunkSize: 500 });
        await seedIndex(document.id, { status: "ready", chunkSize: 500, embeddingModel: "other-model:1" });

        const index = await findReadyIndexService(userId, document.id, { chunkSize: 500, embeddingModel: DEFAULT_EMBEDDING_MODEL });

        assert.equal(index.id, wanted.id);
        assert.equal(index.documentId, document.id);
        assert.equal(index.chunkSize, 500);
        assert.equal(index.embeddingModel, DEFAULT_EMBEDDING_MODEL);
        assert.equal(index.status, "ready");
    });

    it("throws 409 'This document has no ready index for chunk size 500' when the document has no index of that size, and creates nothing", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        await seedIndex(document.id, { status: "ready", chunkSize: 1000 });
        const before = await rowsOfEverything();

        await assert.rejects(
            findReadyIndexService(userId, document.id, { chunkSize: 500, embeddingModel: DEFAULT_EMBEDDING_MODEL }),
            isAppError(409, "This document has no ready index for chunk size 500")
        );

        assert.deepEqual(await rowsOfEverything(), before, "no index, no chunk, no usage row");
        assert.equal(fake.requests.length, 0, "no request reached Ollama");
    });

    it("throws the same 409 for an index that is queued, indexing or failed, and creates nothing", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        await seedIndex(document.id, { status: "queued", chunkSize: 300 });
        await seedIndex(document.id, { status: "indexing", chunkSize: 500 });
        await seedIndex(document.id, { status: "failed", chunkSize: 750, error: "Indexing failed" });
        const before = await rowsOfEverything();

        for (const chunkSize of [300, 500, 750]) {
            await assert.rejects(
                findReadyIndexService(userId, document.id, { chunkSize, embeddingModel: DEFAULT_EMBEDDING_MODEL }),
                isAppError(409, `This document has no ready index for chunk size ${chunkSize}`),
                `chunk size ${chunkSize}`
            );
        }

        assert.deepEqual(await rowsOfEverything(), before);
        assert.equal(fake.requests.length, 0);
    });

    it("throws the 409 when the only ready index of that size is for another model", { timeout: 15_000 }, async () => {
        const userId = await seedUser("ana@example.com");
        const document = await seedDocument(userId);
        await seedIndex(document.id, { status: "ready", chunkSize: 500, embeddingModel: "other-model:1" });

        await assert.rejects(
            findReadyIndexService(userId, document.id, { chunkSize: 500, embeddingModel: DEFAULT_EMBEDDING_MODEL }),
            isAppError(409, "This document has no ready index for chunk size 500")
        );
    });

    it("throws 404 'Document not found' for another user's document, an unknown document and a malformed id, and creates nothing", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        const document = await seedDocument(ana);
        await seedIndex(document.id, { status: "ready", chunkSize: 500 });
        const before = await rowsOfEverything();

        for (const documentId of [document.id, randomUUID(), "not-a-uuid"]) {
            await assert.rejects(
                findReadyIndexService(bob, documentId, { chunkSize: 500, embeddingModel: DEFAULT_EMBEDDING_MODEL }),
                isAppError(404, "Document not found"),
                documentId
            );
        }

        assert.deepEqual(await rowsOfEverything(), before);
        assert.equal(fake.requests.length, 0);
    });
});
