import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { embeddings, modelList, neverAnswer, startFakeOllama } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// OLLAMA_TIMEOUT_MS is read when the Ollama configuration loads, so the case of a model server that does not answer has
// a file (and a process) of its own, with the shortest timeout the setting accepts (one second). The other tests of the
// queue keep the default of two minutes, which is what lets them tell an abort from a timeout.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;
process.env.OLLAMA_TIMEOUT_MS = "1000";

const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { DEFAULT_EMBEDDING_MODEL, chunkTexts, readIndex, seedDocumentWithIndex, seedUser } = await import("../documentsFixtures.js");
const queue = await import("../../src/v1/services/indexingQueue.service.js");
const { subscribeToEvents } = await import("../../src/v1/services/events.service.js");

before(resetTestDatabase);

let events: Record<string, unknown>[] = [];
let unsubscribe: () => void = () => {};

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/tags", modelList([DEFAULT_EMBEDDING_MODEL]));
    events = [];
    unsubscribe = subscribeToEvents((event) => events.push(event as unknown as Record<string, unknown>));
});

afterEach(async () => {
    unsubscribe();
    await queue.stopIndexingWorkerService();
});

after(async () => {
    await fake.close();
    await closeTestPools();
});

describe("processQueuedIndexesService: a model server that does not answer", () => {
    it("fails the index at once with 'The model server did not answer in time' (no retry), and goes on with the next index", { timeout: 30_000 }, async () => {
        const hanging = await seedDocumentWithIndex(await seedUser("hanging@example.com"), {}, { chunks: chunkTexts("hanging", 15), queuedAt: new Date(Date.now() - 60_000) });
        const healthy = await seedDocumentWithIndex(await seedUser("healthy@example.com"), {}, { chunks: chunkTexts("healthy", 3) });
        let calls = 0;
        const hangTheFirst: FakeOllamaHandler = (req, res, body) => (++calls === 1 ? neverAnswer : embeddings())(req, res, body);
        fake.respond("/api/embed", hangTheFirst);

        await Promise.race([
            queue.processQueuedIndexesService(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("the run did not end")), 20_000).unref())
        ]);

        const row = await readIndex(hanging.index.id);
        assert.equal(row?.status, "failed");
        assert.equal(row?.error, "The model server did not answer in time");
        assert.equal(fake.requests.filter((request) => request.path === "/api/embed").length, 2, "one request that timed out, one for the next index: no retry of the first");
        assert.equal(events.find((event) => event.type === "failed" && event.indexId === hanging.index.id)?.error, "The model server did not answer in time");
        assert.equal((await readIndex(healthy.index.id))?.status, "ready", "the next index ran");
    });
});
