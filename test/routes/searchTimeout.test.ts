import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { embeddings, embeddingsFor, holdRequest, startFakeOllama } from "../doubles/fakeOllama.js";

// The time a search may take (MAX_QUESTION_SECONDS, 1 second here): it starts when the search is entered and covers the wait for
// the model's turn and the embedding. A search that cannot get the turn in the time left is a 503 busy; one whose embedding does
// not come in the time left is a 504; neither is stored or counted.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_QUESTION_SECONDS = "1";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { countRows, seedDocument, seedIndex, waitFor } = await import("../documentsFixtures.js");
const { getModelTurnWaitingCount, runWithModelTurnService } = await import("../../src/v1/services/modelTurn.service.js");
const { pool } = await import("../../src/v1/config/db.config.js");

before(resetTestDatabase);

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", embeddings());
});

after(async () => {
    await fake.close();
    await closeTestPools();
});

const search = (token: string, documentId: string, question: string) =>
    request(app).post(`/v1/documents/${documentId}/search`).set("Authorization", `Bearer ${token}`).send({ question });

const seedSearcher = async (email: string) => {
    const user = await createTestUser({ email });
    const document = await seedDocument(user.id, { filename: "notes.txt" });
    await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: ["one", "two", "three"], vectors: [[1, 0], [3, 4], [0, 1]] });

    return { user, documentId: document.id };
};

// fails instead of waiting for ever
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

describe("a search that waits too long for the model's turn", () => {
    it("answers 503 busy within about two seconds when another request holds the turn, and stores nothing and sends nothing to Ollama", { timeout: 30_000 }, async () => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        let releaseTurn: () => void = () => {};
        const turnHeld = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        // the test takes the turn the way an indexing batch does, for as long as it likes: a question's own embedding would time out at one second
        const holder = runWithModelTurnService(() => turnHeld);

        try {
            const startedAt = Date.now();
            const response = await within(10_000, "the answer", Promise.resolve(search(user.token, documentId, "Will anyone answer?")));
            const elapsed = Date.now() - startedAt;

            assert.equal(response.status, 503, JSON.stringify(response.body));
            assert.deepEqual(response.body, { message: "The server is busy, please try again in a few minutes" });
            assert.ok(elapsed >= 800, `it gave up after ${elapsed} ms: it waited for the turn for the time it had`);
            assert.ok(elapsed < 5000, `it gave up after ${elapsed} ms: within about two seconds of MAX_QUESTION_SECONDS`);
            assert.equal(await countRows("runs"), 0);
            assert.equal(await countRows("question_usage"), 0, "a question that never reached the model is not counted");
            assert.deepEqual(fake.requests, []);
        } finally {
            releaseTurn();
            await holder;
        }
    });

    it("can be asked again once the turn is free: the refusal left nothing held", { timeout: 30_000 }, async () => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        let releaseTurn: () => void = () => {};
        const holder = runWithModelTurnService(() => new Promise<void>((resolve) => {
            releaseTurn = resolve;
        }));

        try {
            assert.equal((await within(10_000, "the busy answer", Promise.resolve(search(user.token, documentId, "First?")))).status, 503);
        } finally {
            releaseTurn();
            await holder;
        }

        const second = await within(10_000, "the second answer", Promise.resolve(search(user.token, documentId, "Second?")));

        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(await countRows("runs"), 1);
    });
});

describe("a search whose embedding does not come in time", () => {
    it("answers 504 'The model server did not answer in time', the fake sees the request closed, and nothing is stored", { timeout: 30_000 }, async () => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);

        const startedAt = Date.now();
        const response = await within(10_000, "the answer", Promise.resolve(search(user.token, documentId, "Will the model answer?")));
        const elapsed = Date.now() - startedAt;

        assert.equal(response.status, 504, JSON.stringify(response.body));
        assert.deepEqual(response.body, { message: "The model server did not answer in time" });
        assert.ok(elapsed < 5000, `it gave up after ${elapsed} ms: at the one second of MAX_QUESTION_SECONDS, not at the two minutes of OLLAMA_TIMEOUT_MS`);
        await within(5000, "the request to Ollama to be closed by the API", held.closed);
        assert.equal(await countRows("runs"), 0, "a search that timed out is not a run");
        assert.equal(await countRows("question_usage"), 0, "and a timeout of the model server costs the user nothing");
    });

    it("frees the model's turn and the user's place: the next search is answered", { timeout: 30_000 }, async () => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);

        assert.equal((await within(10_000, "the 504", Promise.resolve(search(user.token, documentId, "Slow?")))).status, 504);
        await within(5000, "the request to Ollama to be closed", held.closed);

        fake.respond("/api/embed", embeddings());
        const next = await within(10_000, "the next answer", Promise.resolve(search(user.token, documentId, "Fast?")));

        assert.equal(next.status, 200, "neither a 409 for a question in progress nor a 503 for a turn that was never given back");
        assert.equal(await countRows("runs"), 1);
    });
});

describe("a search that finds almost no time left when its turn comes (finding F8, the floor of 250 milliseconds)", () => {
    it("answers 504 'The model server did not answer in time' and never calls Ollama: a request with a few milliseconds left cannot be a real embedding", { timeout: 30_000 }, async () => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        let releaseTurn: () => void = () => {};
        const turnHeld = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        const holder = runWithModelTurnService(() => turnHeld);

        try {
            const pending = Promise.resolve(search(user.token, documentId, "Is there time left?"));
            await waitFor("the search to wait for the turn", async () => (getModelTurnWaitingCount() === 1 ? true : undefined), 10_000);

            // the search has about 1000 ms in all and has used a few tens of them: it is given the turn with about 150 ms left, which
            // is more than nothing and less than the 250 ms below which the search does not call the model
            await new Promise((resolve) => setTimeout(resolve, 800));
            releaseTurn();

            const response = await within(10_000, "the answer", pending);

            assert.equal(response.status, 504, JSON.stringify(response.body));
            assert.deepEqual(response.body, { message: "The model server did not answer in time" });
            assert.deepEqual(fake.requests, [], "nothing was sent to Ollama");
            assert.equal(await countRows("runs"), 0);
            assert.equal(await countRows("question_usage"), 0, "the model did no work: nothing is counted");
        } finally {
            releaseTurn();
            await holder;
        }
    });
});

describe("a search whose time is up after the embedding (finding F5)", () => {
    it("answers 504 and stores no run when the matches take longer than the time left, and counts the question: the model did the work", { timeout: 30_000 }, async (t) => {
        const { user, documentId } = await seedSearcher("ana@example.com");
        const question = "Will the matches be late?";
        fake.respond("/api/embed", embeddingsFor({ [question]: [1, 0] }));

        // the search of the chunks is slowed down to more than the one second the question has in all
        const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
        let slowed = 0;
        t.mock.method(pool, "query", (async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("c.embedding <=>")) {
                slowed += 1;
                await new Promise((resolve) => setTimeout(resolve, 1300));
            }

            return query(...args);
        }) as never);

        const response = await within(15_000, "the answer", Promise.resolve(search(user.token, documentId, question)));

        assert.ok(slowed >= 1, "the search of the chunks was the slow step");
        assert.equal(response.status, 504, JSON.stringify(response.body));
        assert.deepEqual(response.body, { message: "The model server did not answer in time" });
        assert.equal(await countRows("runs"), 0, "no run is stored once the time is up");
        assert.equal(await countRows("question_usage"), 1, "the embedding was done, so the question is counted");
    });
});
