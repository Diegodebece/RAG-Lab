import "./relaxedLimits.js";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { embeddingsFor, startFakeOllama } from "../doubles/fakeOllama.js";

// The model serves one request at a time for the whole API: the batches of an index being built and the embeddings of searches
// take turns in one line, first come first served. A search that arrives while a build is on its second batch waits for that batch
// and not for the whole build: it gets the turn right after the batch in flight, before the next batch. The worker is running here,
// with a build of three batches (25 chunks, 10 to a batch), and the model server double holds each request until the test lets
// it go, so the order of the requests at the double is the order of the turns.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { chunkTexts, countRows, readIndex, seedDocument, seedIndex, waitFor } = await import("../documentsFixtures.js");
const { getModelTurnWaitingCount } = await import("../../src/v1/services/modelTurn.service.js");
const queue = await import("../../src/v1/services/indexingQueue.service.js");

const QUESTION = "Which batch will this question wait for?";

before(resetTestDatabase);

// every request the double received, in order, and the way to let each one go; how many were in the double at once
interface Arrival {
    input: string[];
    release: () => void;
}

let arrivals: Arrival[] = [];
let inFlight = 0;
let mostInFlight = 0;

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    arrivals = [];
    inFlight = 0;
    mostInFlight = 0;
    fake.respond("/api/embed", embeddingsFor({ [QUESTION]: [1, 0] }, {
        beforeAnswer: async (input) => {
            inFlight += 1;
            mostInFlight = Math.max(mostInFlight, inFlight);

            await new Promise<void>((resolve) => {
                arrivals.push({ input, release: resolve });
            });

            inFlight -= 1;
        }
    }));
});

// whatever is still held is let go, and the worker is stopped, so nothing runs on into the next test
afterEach(async () => {
    for (const arrival of arrivals) {
        arrival.release();
    }

    await queue.stopIndexingWorkerService();
});

after(async () => {
    await fake.close();
    await closeTestPools();
});

const arrivalNumber = async (number: number): Promise<Arrival> =>
    waitFor(`request ${number} to reach the model server`, async () => arrivals[number - 1], 15_000);

describe("the model's line, shared by the batches of an index and the searches", () => {
    it("gives a search the turn right after the batch in flight and before the next batch, one request at a time at the model server", { timeout: 90_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id, { filename: "notes.txt" });
        // the index the search reads, and the index of three batches that is being built
        await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: ["one", "two", "three"], vectors: [[1, 0], [3, 4], [0, 1]] });
        const building = await seedIndex(document.id, { status: "queued", chunkSize: 500, chunks: chunkTexts("build", 25) });

        queue.startIndexingWorkerService();

        const firstBatch = await arrivalNumber(1);
        assert.deepEqual(firstBatch.input, building.chunks.slice(0, 10), "the worker is on its first batch");

        // the search arrives while that batch is held at the model server
        const searching = Promise.resolve(request(app).post(`/v1/documents/${document.id}/search`).set(...ana.auth).send({ question: QUESTION }));
        await waitFor("the search to wait for the model's turn", async () => (getModelTurnWaitingCount() >= 1 ? true : undefined), 15_000);
        assert.equal(arrivals.length, 1, "the search is waiting: the model server has only the batch");

        firstBatch.release();

        const second = await arrivalNumber(2);
        assert.deepEqual(second.input, [QUESTION], "the next request at the model server is the question, and not the second batch");
        second.release();

        const response = await searching;
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.status, "matched");

        const secondBatch = await arrivalNumber(3);
        assert.deepEqual(secondBatch.input, building.chunks.slice(10, 20), "the build goes on with its second batch after the question");
        secondBatch.release();

        const thirdBatch = await arrivalNumber(4);
        assert.deepEqual(thirdBatch.input, building.chunks.slice(20), "and with its third");
        thirdBatch.release();

        await waitFor("the build to be ready", async () => ((await readIndex(building.id))?.status === "ready" ? true : undefined), 15_000);

        assert.deepEqual(arrivals.map((arrival) => arrival.input.length), [10, 1, 10, 5]);
        assert.equal(mostInFlight, 1, "the model server never had two requests at once");
        assert.equal(await countRows("runs"), 1, "the search stored its run");
    });

    it("does not make a search wait for the whole build: it is answered while the build still has batches left", { timeout: 90_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id, { filename: "notes.txt" });
        await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: ["one", "two", "three"], vectors: [[1, 0], [3, 4], [0, 1]] });
        const building = await seedIndex(document.id, { status: "queued", chunkSize: 500, chunks: chunkTexts("long build", 25) });

        queue.startIndexingWorkerService();
        const firstBatch = await arrivalNumber(1);
        const searching = Promise.resolve(request(app).post(`/v1/documents/${document.id}/search`).set(...ana.auth).send({ question: QUESTION }));
        await waitFor("the search to wait for the model's turn", async () => (getModelTurnWaitingCount() >= 1 ? true : undefined), 15_000);

        firstBatch.release();
        (await arrivalNumber(2)).release();

        assert.equal((await searching).status, 200);
        assert.notEqual((await readIndex(building.id))?.status, "ready", "two batches of three are still to come");
    });
});
