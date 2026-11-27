import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropConnection, embeddings, modelList, neverAnswer, startFakeOllama } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// OLLAMA_TIMEOUT_MS is read when the Ollama configuration loads, so the case of a model server that does not answer has
// a file (and a process) of its own, with the shortest timeout the setting accepts (one second). The other tests of the
// queue keep the default of two minutes, which is what lets them tell an abort from a timeout.
//
// A request that times out is a failure of the model server like a dropped connection is, and is handled the same way: the
// worker asks /api/tags whether the server is up (the probe has its own timeout, two seconds). Away: the index waits in the
// queue and no attempt is counted. Up: an attempt is counted, and after three the index fails.
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

const embedRequests = () => fake.requests.filter((request) => request.path === "/api/embed");

const tagRequests = () => fake.requests.filter((request) => request.path === "/api/tags");

// ends the test with an error instead of waiting for ever for a run that does not end
const run = (): Promise<unknown> => Promise.race([
    queue.processQueuedIndexesService(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the run did not end")), 20_000).unref())
]);

const seedWaiting = async (label: string, chunks: number, queuedAt: Date) =>
    (await seedDocumentWithIndex(await seedUser(`${label}@example.com`), {}, { chunks: chunkTexts(label, chunks), queuedAt })).index;

describe("processQueuedIndexesService: a request to the model server that times out, with /api/tags up", () => {
    it("counts an attempt and puts the index back in the queue, and stops: the next index is not tried until a later run", { timeout: 30_000 }, async () => {
        const hanging = await seedWaiting("hanging", 15, new Date(Date.now() - 60_000));
        const next = await seedWaiting("next", 3, new Date());
        fake.respond("/api/embed", neverAnswer);

        await run();

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "queued", "it is not failed at once: the server answers, so it may do better next time");
        assert.equal(row?.attempts, 1);
        assert.equal(row?.error, null);
        assert.equal(tagRequests().length, 1, "after the timeout Ollama was asked if it is up");
        assert.equal(embedRequests().length, 1, "no second request in the same run");
        assert.ok(!events.some((event) => event.type === "failed"));
        assert.equal((await readIndex(next.id))?.status, "queued", "the next one was not tried");
    });

    it("fails the index with 'Indexing failed' after 3 attempts, one per timeout, with a probe after each", { timeout: 40_000 }, async () => {
        const hanging = await seedWaiting("always hanging", 15, new Date());
        fake.respond("/api/embed", neverAnswer);

        for (let attempt = 0; attempt < 6 && (await readIndex(hanging.id))?.status !== "failed"; attempt++) {
            await run();
        }

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "failed");
        assert.equal(row?.error, "Indexing failed");
        assert.equal(row?.attempts, 3);
        assert.ok(row?.finishedAt instanceof Date);
        assert.equal(embedRequests().length, 3, "three attempts and no more");
        assert.equal(tagRequests().length, 3, "one probe after each");
        assert.equal(events.at(-1)?.type, "failed");
        assert.equal(events.at(-1)?.error, "Indexing failed");
    });

    it("finishes the index when the server answers after one timeout, with the attempt counted", { timeout: 30_000 }, async () => {
        const slowOnce = await seedWaiting("slow once", 15, new Date());
        let calls = 0;
        const hangTheFirst: FakeOllamaHandler = (req, res, body) => (++calls === 1 ? neverAnswer : embeddings())(req, res, body);
        fake.respond("/api/embed", hangTheFirst);

        for (let attempt = 0; attempt < 3 && (await readIndex(slowOnce.id))?.status !== "ready"; attempt++) {
            await run();
        }

        const row = await readIndex(slowOnce.id);
        assert.equal(row?.status, "ready");
        assert.equal(row?.attempts, 1, "the timeout was one attempt");
    });

    it("fails the index at once, as the model not being installed, when the probe answers and the model is not among its models", { timeout: 30_000 }, async () => {
        const hanging = await seedWaiting("no model", 15, new Date());
        fake.respond("/api/embed", neverAnswer);
        fake.respond("/api/tags", modelList(["qwen3.5:4b"]));

        await run();

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "failed");
        assert.equal(row?.error, "The embedding model is not installed on the model server");
        assert.equal(embedRequests().length, 1, "no retry");
    });
});

describe("processQueuedIndexesService: a request to the model server that times out, with /api/tags down", () => {
    it("puts the index back in the queue with its attempts unchanged when the probe cannot connect, and the next index is not tried", { timeout: 30_000 }, async () => {
        const hanging = await seedWaiting("away", 15, new Date(Date.now() - 60_000));
        const next = await seedWaiting("after away", 3, new Date());
        fake.respond("/api/embed", neverAnswer);
        fake.respond("/api/tags", dropConnection);

        await run();

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "queued");
        assert.equal(row?.attempts, 0, "the server being away is not the index's fault");
        assert.equal(row?.error, null);
        assert.equal(tagRequests().length, 1);
        assert.ok(!events.some((event) => event.type === "failed"));
        assert.equal((await readIndex(next.id))?.status, "queued", "the next one was not tried");
    });

    it("puts the index back in the queue with its attempts unchanged when the probe times out too", { timeout: 30_000 }, async () => {
        const hanging = await seedWaiting("away and silent", 15, new Date());
        fake.respond("/api/embed", neverAnswer);
        fake.respond("/api/tags", neverAnswer);

        await run();

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "queued");
        assert.equal(row?.attempts, 0);
        assert.equal(row?.error, null);
        assert.ok(!events.some((event) => event.type === "failed"));
    });

    it("builds the index when the server is back: nothing was counted against it", { timeout: 40_000 }, async () => {
        const hanging = await seedWaiting("comes back", 15, new Date());
        fake.respond("/api/embed", neverAnswer);
        fake.respond("/api/tags", dropConnection);
        await run();

        fake.respond("/api/embed", embeddings());
        fake.respond("/api/tags", modelList([DEFAULT_EMBEDDING_MODEL]));
        await run();

        const row = await readIndex(hanging.id);
        assert.equal(row?.status, "ready");
        assert.equal(row?.attempts, 0);
    });
});
