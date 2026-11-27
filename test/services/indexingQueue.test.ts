import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { dropConnection, embeddings, fakeTokenCount, fakeVectorFor, holdRequest, httpError, modelList, startFakeOllama, waitForRequests } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// The indexing queue (layer 4): the rows of document_indexes are the queue, one worker builds one index at a time, and
// every request to Ollama goes through the double of test/doubles/fakeOllama.ts. The rows are seeded as the owner, so
// each test starts from the state it needs; the routes are used only where the route is what the test is about.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
// the worker tests upload through the API, and no limit may get in the way
process.env.UPLOAD_REQUESTS_PER_MINUTE = "1000";
process.env.MAX_ACTIVE_INDEX_BUILDS_PER_USER = "100";
process.env.MAX_QUEUED_INDEX_BUILDS = "1000";
process.env.MAX_INDEX_BUILDS_PER_DAY = "1000";
process.env.MAX_INDEX_BUILDS_PER_DAY_TOTAL = "10000";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "100000";
process.env.REQUESTS_PER_ADDRESS_PER_MINUTE = "100000";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("../routes/testUsers.js");
const { DEFAULT_EMBEDDING_MODEL, SEEDED_VECTOR_VALUE, chunkTexts, countRows, readChunks, readIndex, sameVector, seedDocument, seedDocumentWithIndex, seedIndex, seedUser, waitFor } = await import("../documentsFixtures.js");
const queue = await import("../../src/v1/services/indexingQueue.service.js");
const { subscribeToEvents } = await import("../../src/v1/services/events.service.js");
const { getModelTurnWaitingCount, runWithModelTurnService } = await import("../../src/v1/services/modelTurn.service.js");
// what the tests read of an indexing event: its type, the index it is about, its owner, and the other fields it carries
type Logged = Record<string, unknown> & { type: string };

before(resetTestDatabase);

let events: Logged[] = [];
let unsubscribe: () => void = () => {};

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", embeddings());
    fake.respond("/api/tags", modelList([DEFAULT_EMBEDDING_MODEL, "qwen3.5:4b"]));
    events = [];
    unsubscribe = subscribeToEvents((event) => events.push(event as unknown as Logged));
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

// the texts of each request to /api/embed, in order
const batchesSent = (): string[][] => embedRequests().map((request) => (request.body as { input: string[] }).input);

const tagRequests = () => fake.requests.filter((request) => request.path === "/api/tags");

const tokensOf = (texts: string[]): number => texts.reduce((sum, text) => sum + fakeTokenCount(text), 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// fails the test instead of waiting for ever for something that does not happen
const within = async <T>(milliseconds: number, what: string, promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} did not happen within ${milliseconds} ms`)), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
};

// a build of `chunks` chunks for a new user, queued as of now unless the options say otherwise
const seedBuild = async (label: string, chunks: number, options: Parameters<typeof seedIndex>[1] = {}) => {
    const userId = await seedUser(`${label.replaceAll(" ", ".")}@example.com`);
    const seeded = await seedDocumentWithIndex(userId, { filename: `${label}.txt` }, { chunks: chunkTexts(label, chunks), ...options });

    return { userId, document: seeded.document, index: seeded.index };
};

const statusOf = async (indexId: string): Promise<string | undefined> => (await readIndex(indexId))?.status;

describe("processQueuedIndexesService: a build", () => {
    it("embeds the chunks in batches of 10 with the index's model and truncate: false, and ends ready with the counts stored", { timeout: 30_000 }, async () => {
        const { index } = await seedBuild("normal", 25);

        await within(20_000, "the build", queue.processQueuedIndexesService());

        const batches = batchesSent();
        assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 5]);
        assert.deepEqual(batches.flat(), index.chunks, "every chunk, in order, once");

        for (const request of embedRequests()) {
            assert.equal(request.method, "POST");
            assert.equal((request.body as { model: string }).model, DEFAULT_EMBEDDING_MODEL);
            assert.equal((request.body as { truncate: boolean }).truncate, false);
        }

        const row = await readIndex(index.id);
        assert.equal(row?.status, "ready");
        assert.equal(row?.embeddedCount, 25);
        assert.equal(row?.chunkCount, 25);
        assert.equal(row?.embeddingTokens, tokensOf(index.chunks), "the sum of the counts Ollama reported for the batches");
        assert.ok(row?.startedAt instanceof Date, "started_at is set");
        assert.ok(row?.finishedAt instanceof Date, "finished_at is set");
        assert.equal(row?.attempts, 0, "a build that went well used no retry");
        assert.equal(row?.error, null);
    });

    it("stores the vectors Ollama answered, each on its own chunk", { timeout: 30_000 }, async () => {
        const { index } = await seedBuild("vectors", 12);

        await within(20_000, "the build", queue.processQueuedIndexesService());

        const chunks = await readChunks(index.id);
        assert.equal(chunks.length, 12);

        for (const chunk of chunks) {
            assert.ok(sameVector(chunk.vector, fakeVectorFor(chunk.text)), `chunk ${chunk.chunkIndex} holds the vector of its own text`);
        }
    });

    it("sends the model of the index, whatever it is, as long as today's caps allow it", { timeout: 30_000 }, async () => {
        const { index } = await seedBuild("model", 3);

        await within(20_000, "the build", queue.processQueuedIndexesService());

        assert.equal((embedRequests()[0].body as { model: string }).model, (await readIndex(index.id))?.embeddingModel);
    });

    it("reports started, progress after each batch, and ready, and no event carries the text of a chunk", { timeout: 30_000 }, async () => {
        const { userId, index } = await seedBuild("events", 25);

        await within(20_000, "the build", queue.processQueuedIndexesService());

        assert.deepEqual(events.map((event) => event.type), ["started", "progress", "progress", "progress", "ready"]);

        for (const event of events) {
            assert.equal(event.indexId, index.id, `${event.type} names the index`);
            assert.equal(event.userId, userId, `${event.type} goes to the owner`);
        }

        assert.deepEqual(events.filter((event) => event.type === "progress").map((event) => [event.embeddedCount, event.chunkCount]), [[10, 25], [20, 25], [25, 25]]);

        const written = JSON.stringify(events);
        assert.ok(index.chunks.every((text) => !written.includes(text)), "no chunk text in any event");
        assert.doesNotMatch(written, /"text"\s*:/);
    });

    it("continues where it stopped: chunks that already have a vector are not sent again, and only the new batches add tokens", { timeout: 30_000 }, async () => {
        const { index } = await seedBuild("resume", 25, { embeddedCount: 10, embeddingTokens: 100 });

        await within(20_000, "the build", queue.processQueuedIndexesService());

        const batches = batchesSent();
        assert.deepEqual(batches.map((batch) => batch.length), [10, 5]);
        assert.deepEqual(batches.flat(), index.chunks.slice(10), "only the chunks without a vector");

        const row = await readIndex(index.id);
        assert.equal(row?.status, "ready");
        assert.equal(row?.embeddedCount, 25);
        assert.equal(row?.embeddingTokens, 100 + tokensOf(index.chunks.slice(10)));

        const chunks = await readChunks(index.id);
        assert.ok(chunks.slice(0, 10).every((chunk) => sameVector(chunk.vector, new Array<number>(1024).fill(SEEDED_VECTOR_VALUE))), "the first ten vectors are the ones that were there");
        assert.ok(chunks.slice(10).every((chunk) => sameVector(chunk.vector, fakeVectorFor(chunk.text))));
        assert.deepEqual(events.filter((event) => event.type === "progress").map((event) => event.embeddedCount), [20, 25]);
    });

    it("builds one index at a time, oldest queue time first, even when started twice at once, and embeds every chunk exactly once", { timeout: 40_000 }, async () => {
        // the newer one is made first: the order is the queue time, not the order the rows were made in
        const newer = await seedBuild("newer", 25, { queuedAt: new Date() });
        const older = await seedBuild("older", 25, { queuedAt: new Date(Date.now() - 3_600_000) });

        await within(30_000, "both builds", Promise.all([queue.processQueuedIndexesService(), queue.processQueuedIndexesService()]));

        const sent = batchesSent().flat();
        assert.equal(sent.length, 50, "every chunk is embedded exactly once");
        assert.equal(new Set(sent).size, 50);
        assert.deepEqual(sent.slice(0, 25), older.index.chunks, "the older build runs first, in chunk order");
        assert.deepEqual(sent.slice(25), newer.index.chunks);
        assert.equal(await statusOf(older.index.id), "ready");
        assert.equal(await statusOf(newer.index.id), "ready");
    });

    it("breaks a tie of queue times by the id of the index", { timeout: 40_000 }, async () => {
        const sameTime = new Date(Date.now() - 60_000);
        const first = await seedBuild("tie one", 2, { queuedAt: sameTime });
        const second = await seedBuild("tie two", 2, { queuedAt: sameTime });
        const [early, late] = [first, second].sort((a, b) => (a.index.id < b.index.id ? -1 : 1));

        await within(20_000, "both builds", queue.processQueuedIndexesService());

        assert.deepEqual(batchesSent().flat(), [...early.index.chunks, ...late.index.chunks]);
    });

    it("takes a turn with the model for every batch: a task that asks for the turn during a batch waits for it, and goes before the next batch", { timeout: 30_000 }, async () => {
        const { index } = await seedBuild("turns", 25);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let firstBatch = true;
        fake.respond("/api/embed", embeddings({
            beforeAnswer: async () => {
                if (firstBatch) {
                    firstBatch = false;
                    await gate;
                }
            }
        }));

        const draining = queue.processQueuedIndexesService();
        await waitForRequests(fake, "/api/embed", 1);

        let batchesWhenItRan = -1;
        const otherTask = runWithModelTurnService(async () => {
            batchesWhenItRan = embedRequests().length;
        });
        await sleep(200);
        assert.equal(batchesWhenItRan, -1, "it has not run: the first batch holds the turn");
        assert.equal(getModelTurnWaitingCount(), 1);

        release();
        await within(20_000, "the other task", otherTask);
        await within(20_000, "the build", draining);

        assert.equal(batchesWhenItRan, 1, "it ran between the first batch and the second");
        assert.equal(await statusOf(index.id), "ready");
    });

    it("keeps going when an event listener throws", { timeout: 30_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const unsubscribeBroken = subscribeToEvents(() => {
            throw new Error("broken listener");
        });
        const { index } = await seedBuild("listener", 15);

        try {
            await within(20_000, "the build", queue.processQueuedIndexesService());
        } finally {
            unsubscribeBroken();
        }

        assert.equal(await statusOf(index.id), "ready");
        assert.ok(events.some((event) => event.type === "ready"), "the other listener still heard everything");
    });
});

describe("processQueuedIndexesService: when Ollama cannot be reached", () => {
    it("puts the index back in the queue with its attempts unchanged and its vectors kept, and stops: the next index is not tried until a later run", { timeout: 40_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const first = await seedBuild("down first", 25, { embeddedCount: 10, embeddingTokens: 30, queuedAt: new Date(Date.now() - 120_000) });
        const second = await seedBuild("down second", 3, { queuedAt: new Date(Date.now() - 60_000) });
        fake.respond("/api/embed", dropConnection);
        fake.respond("/api/tags", dropConnection);

        await within(20_000, "the run", queue.processQueuedIndexesService());

        const row = await readIndex(first.index.id);
        assert.equal(row?.status, "queued");
        assert.equal(row?.attempts, 0, "Ollama being away is not the index's fault");
        assert.equal(row?.error, null);
        assert.equal(row?.embeddedCount, 10);
        assert.equal(row?.embeddingTokens, 30);
        assert.deepEqual((await readChunks(first.index.id)).map((chunk) => chunk.vector !== null), Array.from({ length: 25 }, (_, position) => position < 10), "the ten vectors are kept");
        assert.ok(!events.some((event) => event.type === "failed"));

        assert.equal(await statusOf(second.index.id), "queued", "the next one was not tried");
        assert.equal(embedRequests().length, 1, "the run stopped after the first failure");

        // Ollama is back: a later run finishes both, the older one first
        fake.respond("/api/embed", embeddings());
        fake.respond("/api/tags", modelList([DEFAULT_EMBEDDING_MODEL]));
        fake.requests.splice(0);

        await within(20_000, "the later run", queue.processQueuedIndexesService());

        assert.equal(await statusOf(first.index.id), "ready");
        assert.equal(await statusOf(second.index.id), "ready");
        assert.deepEqual([...batchesSent().flat()].sort(), [...first.index.chunks.slice(10), ...second.index.chunks].sort(), "the chunks without a vector, once each");
    });

    it("counts an attempt, and queues the index again, when a batch drops the connection while Ollama answers /api/tags", { timeout: 40_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { index } = await seedBuild("flaky", 15);
        let calls = 0;
        const dropTheFirst: FakeOllamaHandler = (req, res, body) => (++calls === 1 ? dropConnection : embeddings())(req, res, body);
        fake.respond("/api/embed", dropTheFirst);

        for (let run = 0; run < 3 && (await statusOf(index.id)) !== "ready"; run++) {
            await within(20_000, "a run", queue.processQueuedIndexesService());
        }

        const row = await readIndex(index.id);
        assert.equal(row?.status, "ready", "it was retried and finished");
        assert.equal(row?.attempts, 1, "the dropped batch used one attempt");
        assert.equal(row?.embeddedCount, 15);
        assert.equal(tagRequests().length, 1, "Ollama was asked once if it is up, after the failed batch");
        assert.ok(!events.some((event) => event.type === "failed"));
    });

    it("fails the index with 'Indexing failed' after 3 attempts, one per dropped batch, with a probe of /api/tags after each", { timeout: 40_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { index } = await seedBuild("always flaky", 15);
        fake.respond("/api/embed", dropConnection);

        for (let run = 0; run < 6 && (await statusOf(index.id)) !== "failed"; run++) {
            await within(20_000, "a run", queue.processQueuedIndexesService());
        }

        const row = await readIndex(index.id);
        assert.equal(row?.status, "failed");
        assert.equal(row?.error, "Indexing failed");
        assert.equal(row?.attempts, 3);
        assert.ok(row?.finishedAt instanceof Date);
        assert.equal(embedRequests().length, 3, "three attempts and no more");
        assert.equal(tagRequests().length, 3, "one probe after each");
        const last = events.at(-1);
        assert.equal(last?.type, "failed", "the last event says it failed");
        assert.equal(last?.indexId, index.id);
        assert.equal(last?.error, "Indexing failed");
    });
});

describe("processQueuedIndexesService: when the build cannot succeed", () => {
    it("fails with 'The embedding model is not installed on the model server' when the model is missing from /api/tags and the embed answers 404", { timeout: 30_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { index } = await seedBuild("missing model", 15);
        fake.respond("/api/embed", httpError(404));
        fake.respond("/api/tags", modelList(["qwen3.5:4b"]));

        await within(20_000, "the run", queue.processQueuedIndexesService());

        const row = await readIndex(index.id);
        assert.equal(row?.status, "failed");
        assert.equal(row?.error, "The embedding model is not installed on the model server");
        assert.equal(embedRequests().length, 1, "no retry: it would fail the same way");
        assert.equal(events.at(-1)?.error, "The embedding model is not installed on the model server");
    });

    const damaged: Record<string, () => FakeOllamaHandler> = {
        "vectors of the wrong size": () => embeddings({ dimensions: 3 }),
        "an all-zero vector": () => embeddings({ zeroVector: true }),
        "no token count": () => embeddings({ omitTokenCount: true })
    };

    for (const [label, makeHandler] of Object.entries(damaged)) {
        it(`fails at once with 'Indexing failed', logs it, and goes on with the next index, when Ollama answers with ${label}`, { timeout: 30_000 }, async (t) => {
            const logged = t.mock.method(console, "error", () => {});
            const broken = await seedBuild(`broken ${label}`, 15, { queuedAt: new Date(Date.now() - 60_000) });
            const healthy = await seedBuild(`healthy ${label}`, 3);
            let calls = 0;
            fake.respond("/api/embed", (req, res, body) => (++calls === 1 ? makeHandler() : embeddings())(req, res, body));

            await within(20_000, "the run", queue.processQueuedIndexesService());

            const row = await readIndex(broken.index.id);
            assert.equal(row?.status, "failed");
            assert.equal(row?.error, "Indexing failed");
            assert.equal(row?.embeddedCount, 0, "nothing the bad answer held was stored");
            assert.equal((await readChunks(broken.index.id)).filter((chunk) => chunk.vector !== null).length, 0);
            assert.ok(logged.mock.callCount() > 0, "it was logged");
            assert.equal(events.find((event) => event.type === "failed" && event.indexId === broken.index.id)?.error, "Indexing failed");
            assert.equal(await statusOf(healthy.index.id), "ready", "the next index ran");
        });
    }

    it("fails an index whose model is outside today's caps, without any call to Ollama, and goes on with the next one", { timeout: 30_000 }, async () => {
        const stale = await seedBuild("stale model", 3, { embeddingModel: "old-model:1b", queuedAt: new Date(Date.now() - 60_000) });
        const healthy = await seedBuild("healthy", 3);

        await within(20_000, "the run", queue.processQueuedIndexesService());

        const row = await readIndex(stale.index.id);
        assert.equal(row?.status, "failed");
        assert.equal(typeof row?.error, "string");
        assert.ok(row && row.error !== null && row.error.length > 0 && row.error.length <= 500);
        assert.ok(!batchesSent().flat().some((text) => stale.index.chunks.includes(text)), "none of its chunks went to Ollama");
        assert.equal(embedRequests().length, 1, "only the healthy index was sent");
        assert.equal(tagRequests().length, 0, "and Ollama was not even asked what it has");
        assert.equal(await statusOf(healthy.index.id), "ready");
    });
});

describe("processQueuedIndexesService: an index or a document deleted while it is built", () => {
    for (const [what, deletion] of [
        ["index", "DELETE FROM document_indexes WHERE id = $1"],
        ["document", "DELETE FROM documents WHERE id = (SELECT document_id FROM document_indexes WHERE id = $1)"]
    ] as const) {
        it(`stops quietly when the ${what} is deleted during a batch, and the next index runs`, { timeout: 30_000 }, async (t) => {
            const logged = t.mock.method(console, "error", () => {});
            const doomed = await seedBuild(`doomed ${what}`, 25, { queuedAt: new Date(Date.now() - 60_000) });
            const next = await seedBuild(`next ${what}`, 3);
            let first = true;
            fake.respond("/api/embed", embeddings({
                beforeAnswer: async () => {
                    if (first) {
                        first = false;
                        await ownerPool.query(deletion, [doomed.index.id]);
                    }
                }
            }));

            await within(20_000, "the run", queue.processQueuedIndexesService());

            assert.equal(await readIndex(doomed.index.id), undefined, "it is gone");
            assert.equal(await countRows("chunks", "index_id = $1", [doomed.index.id]), 0);
            assert.equal(batchesSent().flat().filter((text) => doomed.index.chunks.includes(text)).length, 10, "only the batch that was in flight was sent");
            assert.equal(logged.mock.callCount(), 0, "nothing was logged as an error");
            assert.ok(!events.some((event) => event.indexId === doomed.index.id && (event.type === "ready" || event.type === "failed")), "no ready, no failed");
            assert.equal(await statusOf(next.index.id), "ready", "the next index ran");
        });
    }

    for (const what of ["index", "document"] as const) {
        it(`aborts the request in flight, within moments and not at the timeout, when the ${what} being built is deleted through the API, and frees the turn with the model`, { timeout: 40_000 }, async () => {
            const ana = await createTestUser({ email: "ana@example.com" });
            const document = await seedDocument(ana.id, { text: "A document that is being indexed right now." });
            const running = await seedIndex(document.id, { chunks: chunkTexts(`running ${what}`, 25), queuedAt: new Date(Date.now() - 60_000) });
            const next = await seedBuild(`after ${what}`, 3);
            const held = holdRequest();
            let first = true;
            fake.respond("/api/embed", (req, res, body) => {
                if (first) {
                    first = false;
                    held.handler(req, res, body);
                } else {
                    embeddings()(req, res, body);
                }
            });

            const draining = queue.processQueuedIndexesService();
            await within(10_000, "the request to arrive", held.arrived);
            assert.equal(await statusOf(running.id), "indexing");

            const deleted = what === "index"
                ? await request(app).delete(`/v1/documents/${document.id}/indexes/${running.id}`).set(...ana.auth)
                : await request(app).delete(`/v1/documents/${document.id}`).set(...ana.auth);
            assert.equal(deleted.status, 200);

            // the timeout of a request is 120 seconds: only an abort ends it within these few
            await within(5_000, "the hang-up", held.closed);
            await within(10_000, "the run to end", draining);

            assert.equal(await readIndex(running.id), undefined);
            assert.equal(await statusOf(next.index.id), "ready", "the next index ran");
            assert.equal(await within(3_000, "a free turn", runWithModelTurnService(async () => "free")), "free", "the model turn is free again");
        });
    }
});

describe("the worker", () => {
    const uploadText = (label: string): string => Array.from({ length: 300 }, (_, position) => `${label} sentence ${position} about the document.`).join(" ");

    it("does not start on its own: importing the app leaves an upload queued, and Ollama receives nothing", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await request(app).post("/v1/documents").set(...ana.auth).send({ filename: "a.txt", text: uploadText("idle") });
        assert.equal(response.status, 202);

        await sleep(500);

        assert.equal(await statusOf(response.body.data.indexes[0].id), "queued");
        assert.equal(fake.requests.length, 0, "nothing reached the double");
    });

    it("builds new uploads by itself once started", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await queue.startIndexingWorkerService();

        const response = await request(app).post("/v1/documents").set(...ana.auth).send({ filename: "a.txt", text: uploadText("active") });
        assert.equal(response.status, 202);
        const indexId: string = response.body.data.indexes[0].id;

        await waitFor("the index to be ready", async () => ((await statusOf(indexId)) === "ready" ? true : undefined), 25_000);

        const row = await readIndex(indexId);
        assert.equal(row?.embeddedCount, row?.chunkCount);
        assert.ok((row?.embeddingTokens ?? 0) > 0);

        const polled = await request(app).get(`/v1/documents/${response.body.data.id}/indexes/${indexId}`).set(...ana.auth);
        assert.equal(polled.body.data.status, "ready");
        assert.equal(polled.body.data.queuePosition, null);
    });

    it("builds the indexes that were already queued when it starts", { timeout: 40_000 }, async () => {
        const { index } = await seedBuild("waiting", 12);

        await queue.startIndexingWorkerService();

        await waitFor("the index to be ready", async () => ((await statusOf(index.id)) === "ready" ? true : undefined), 25_000);
    });

    it("aborts the request in flight when it is stopped, and leaves the index queued, not failed, with its vectors", { timeout: 40_000 }, async () => {
        const { index } = await seedBuild("stopping", 25);
        const held = holdRequest();
        let calls = 0;
        fake.respond("/api/embed", (req, res, body) => {
            if (++calls === 2) {
                held.handler(req, res, body);
            } else {
                embeddings()(req, res, body);
            }
        });

        await queue.startIndexingWorkerService();
        await within(15_000, "the second batch to arrive", held.arrived);

        await within(8_000, "the worker to stop", queue.stopIndexingWorkerService());
        await within(3_000, "the hang-up", held.closed);

        const row = await readIndex(index.id);
        assert.equal(row?.status, "queued", "not failed, not stuck in indexing");
        assert.equal(row?.attempts, 0);
        assert.equal(row?.error, null);
        assert.equal(row?.embeddedCount, 10, "the first batch was stored");
        assert.deepEqual((await readChunks(index.id)).map((chunk) => chunk.vector !== null), Array.from({ length: 25 }, (_, position) => position < 10));
        assert.ok(!events.some((event) => event.type === "failed"));

        const requestsAtStop = fake.requests.length;
        await sleep(300);
        assert.equal(fake.requests.length, requestsAtStop, "a stopped worker sends nothing more");
    });

    it("can be stopped when it is idle, and more than once", { timeout: 15_000 }, async () => {
        await within(5_000, "a stop with no worker", queue.stopIndexingWorkerService());
        await queue.startIndexingWorkerService();
        await within(5_000, "the stop", queue.stopIndexingWorkerService());
        await within(5_000, "a second stop", queue.stopIndexingWorkerService());
    });
});

describe("recoverIndexBuildsService", () => {
    it("moves the builds that were running when the API stopped back to the queue, keeping their vectors and tokens, and returns how many", { timeout: 20_000 }, async () => {
        const running = await seedBuild("running", 12, { status: "indexing", embeddedCount: 4, embeddingTokens: 20, attempts: 1 });
        const alsoRunning = await seedBuild("also running", 3, { status: "indexing" });
        const ready = await seedBuild("ready", 3, { status: "ready", embeddingTokens: 15 });
        const failed = await seedBuild("failed", 3, { status: "failed", attempts: 3, error: "Indexing failed" });
        const queued = await seedBuild("queued", 3);
        const untouched = [ready.index.id, failed.index.id, queued.index.id];
        const before = await Promise.all(untouched.map((id) => readIndex(id)));

        assert.equal(await queue.recoverIndexBuildsService(), 2);

        for (const index of [running.index, alsoRunning.index]) {
            assert.equal(await statusOf(index.id), "queued");
        }

        const row = await readIndex(running.index.id);
        assert.equal(row?.embeddedCount, 4);
        assert.equal(row?.embeddingTokens, 20);
        assert.equal(row?.attempts, 1, "an interrupted build is not a failed attempt");
        assert.equal(row?.error, null);
        assert.deepEqual((await readChunks(running.index.id)).map((chunk) => chunk.vector !== null), Array.from({ length: 12 }, (_, position) => position < 4));
        assert.deepEqual(await Promise.all(untouched.map((id) => readIndex(id))), before, "ready, failed and queued are as they were");
    });

    it("returns 0, and changes nothing, when no build was running", { timeout: 20_000 }, async () => {
        const queued = await seedBuild("queued only", 3);
        const before = await readIndex(queued.index.id);

        assert.equal(await queue.recoverIndexBuildsService(), 0);
        assert.deepEqual(await readIndex(queued.index.id), before);
    });
});

describe("requeueStuckIndexBuildsService", () => {
    it("queues a build stuck in indexing for over a minute again, keeping its vectors, and leaves a recent one alone", { timeout: 20_000 }, async () => {
        const stuck = await seedBuild("stuck", 12, { status: "indexing", embeddedCount: 4, startedAt: new Date(Date.now() - 120_000) });
        const recent = await seedBuild("recent", 3, { status: "indexing", startedAt: new Date() });
        const ready = await seedBuild("ready", 3, { status: "ready" });
        const before = await Promise.all([recent.index.id, ready.index.id].map((id) => readIndex(id)));

        await queue.requeueStuckIndexBuildsService();

        assert.equal(await statusOf(stuck.index.id), "queued");
        assert.equal((await readIndex(stuck.index.id))?.embeddedCount, 4);
        assert.deepEqual((await readChunks(stuck.index.id)).map((chunk) => chunk.vector !== null), Array.from({ length: 12 }, (_, position) => position < 4), "the vectors are kept");
        assert.deepEqual(await Promise.all([recent.index.id, ready.index.id].map((id) => readIndex(id))), before, "the recent and the ready ones are as they were");
    });

    it("leaves alone the build this process is running, however long ago it started", { timeout: 40_000 }, async () => {
        const stuck = await seedBuild("stuck", 3, { status: "indexing", startedAt: new Date(Date.now() - 120_000) });
        const running = await seedBuild("running", 25, { queuedAt: new Date(Date.now() - 60_000) });
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);

        const draining = queue.processQueuedIndexesService();
        await within(10_000, "the request to arrive", held.arrived);
        await ownerPool.query("UPDATE document_indexes SET started_at = now() - interval '2 minutes' WHERE id = $1", [running.index.id]);

        await queue.requeueStuckIndexBuildsService();

        assert.equal(await statusOf(running.index.id), "indexing", "the running build is not stuck");
        assert.equal(await statusOf(stuck.index.id), "queued", "the other one is");

        // end the run: the index goes, and the abort the API makes when it deletes one ends the request in flight
        await ownerPool.query("DELETE FROM document_indexes WHERE id = $1", [running.index.id]);
        fake.respond("/api/embed", embeddings());
        queue.abortIndexBuildService({ indexId: running.index.id });
        await within(15_000, "the run to end", draining);
    });
});

describe("abortIndexBuildService", () => {
    it("does nothing when no build is running, for an index or for a document", { timeout: 10_000 }, async () => {
        const { index, document } = await seedBuild("not running", 3);

        queue.abortIndexBuildService({ indexId: index.id });
        queue.abortIndexBuildService({ documentId: document.id });

        assert.equal(await statusOf(index.id), "queued");
    });
});
