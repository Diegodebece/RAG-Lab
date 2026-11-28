import "./relaxedLimits.js";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropConnection, embeddings, holdRequest, startFakeOllama, waitForRequests } from "../doubles/fakeOllama.js";

// The caps of a search that are not a per-minute count (layer 5): the questions of the day (3 here, counted from the question_usage
// rows the user has in the last 24 hours), one question at a time for each user, and at most 2 questions waiting for the model's turn. The
// model server is the double, and a question can be held there: the model serves one request at a time for the whole API, so a held
// question is what makes the others wait. The requests are made over a real HTTP server, because some of the tests hang up.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_QUESTIONS_PER_DAY = "3";
process.env.MAX_WAITING_QUESTIONS = "2";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { countRows, seedDocument, seedIndex, seedQuestionUsage, seedRun, waitFor } = await import("../documentsFixtures.js");
const { getModelTurnWaitingCount } = await import("../../src/v1/services/modelTurn.service.js");

const DAILY = { message: "You have reached the daily limit of questions, please try again later" };
const IN_PROGRESS = { message: "You already have a question in progress, please wait for it to finish" };
const BUSY = { message: "The server is busy, please try again in a few minutes" };

let server: Server;
let baseUrl = "";

// a question that the model server holds until the test opens its gate, found by the text of the question
const gates = new Map<string, () => void>();
const holds = new Map<string, Promise<void>>();

const holdQuestion = (question: string): void => {
    holds.set(question, new Promise<void>((resolve) => gates.set(question, resolve)));
};

const releaseQuestion = (question: string): void => {
    gates.get(question)?.();
};

const answerEmbeddings = () => embeddings({ beforeAnswer: async (input) => { await holds.get(input[0]); } });

before(async () => {
    await resetTestDatabase();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", answerEmbeddings());
});

// whatever a test held is let go, so nothing outlives it and the next test finds the model's turn free
afterEach(async () => {
    for (const question of [...gates.keys()]) {
        releaseQuestion(question);
    }

    gates.clear();
    holds.clear();
    await waitFor("the model's line to be empty", async () => (getModelTurnWaitingCount() === 0 ? true : undefined), 10_000);
});

after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake.close();
    await closeTestPools();
});

interface Answer {
    status: number;
    body: Record<string, unknown>;
}

type Caller = { token: string };

const post = async (caller: Caller, documentId: string, question: string, signal?: AbortSignal): Promise<Answer> => {
    const response = await fetch(`${baseUrl}/v1/documents/${documentId}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${caller.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: signal ?? AbortSignal.timeout(25_000)
    });

    return { status: response.status, body: await response.json() as Record<string, unknown> };
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

const embedInputs = (): string[][] => fake.requests.filter((entry) => entry.path === "/api/embed").map((entry) => (entry.body as { input: string[] }).input);

// a user with a document that has a ready index of three chunks
const seedSearcher = async (email: string, withIndex = true) => {
    const user = await createTestUser({ email });
    const document = await seedDocument(user.id, { filename: "notes.txt" });

    if (withIndex) {
        await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: ["one", "two", "three"], vectors: [[1, 0], [3, 4], [0, 1]] });
    }

    return { user, token: user.token, documentId: document.id };
};

const ago = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

// The day's count reads question_usage (round 2, finding F6): one row for every embedding that was done for a question, written when
// the embedding comes back (or when the client hangs up after the request was sent to Ollama), whether or not the run is stored
// afterwards. A refusal, a cancel while waiting for the turn, a 503 and a 504 of the model server cost nothing.
describe("the questions of the day (MAX_QUESTIONS_PER_DAY, 3 here)", () => {
    it("answers 429 to a user with 3 counted questions in the last 24 hours, sends nothing to Ollama and stores nothing", { timeout: 20_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        await seedQuestionUsage(ana.user.id, 1, 1);
        await seedQuestionUsage(ana.user.id, 1, 2);
        await seedQuestionUsage(ana.user.id, 1, 3);

        const response = await post(ana, ana.documentId, "A question?");

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, DAILY);
        assert.deepEqual(embedInputs(), []);
        assert.equal(await countRows("runs"), 0, "the refused question stored no run");
        assert.equal(await countRows("question_usage"), 3, "and was not counted");
    });

    it("does not count questions older than 24 hours, counts the ones that searches wrote, and lets the third question of the day in and refuses the fourth", { timeout: 40_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        const bob = await seedSearcher("bob@example.com");
        await seedQuestionUsage(bob.user.id, 3, 25);
        await seedQuestionUsage(ana.user.id, 1, 2);

        assert.equal((await post(bob, bob.documentId, "Bob's question?")).status, 200, "three questions from 25 hours ago are not counted");

        assert.equal((await post(ana, ana.documentId, "First of today?")).status, 200, "the second question of the day");
        assert.equal((await post(ana, ana.documentId, "Second of today?")).status, 200, "the third question of the day");
        const fourth = await post(ana, ana.documentId, "Third of today?");

        assert.equal(fourth.status, 429, "the seeded question and the two asked by searches make three");
        assert.deepEqual(fourth.body, DAILY);
        assert.equal(await countRows("question_usage", "user_id = $1", [ana.user.id]), 3);
        assert.equal(await countRows("runs", "user_id = $1", [ana.user.id]), 2, "the seeded question has no run: only the searches stored one");
    });

    it("does not count another user's questions", { timeout: 20_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        const bob = await seedSearcher("bob@example.com");
        await seedQuestionUsage(bob.user.id, 5);

        assert.equal((await post(ana, ana.documentId, "Ana's question?")).status, 200);
        assert.equal((await post(bob, bob.documentId, "Bob's question?")).status, 429);
    });

    it("counts the questions that were embedded and not the runs that are stored: three stored runs are not a day's limit", { timeout: 20_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        for (let run = 0; run < 3; run++) {
            await seedRun(ana.user.id, { createdAt: ago(1 + run) });
        }

        assert.equal((await post(ana, ana.documentId, "A question?")).status, 200);
        assert.equal(await countRows("question_usage", "user_id = $1", [ana.user.id]), 1);
    });

    it("does not count a search that failed because Ollama was down: three failures write no usage and the next three searches are accepted", { timeout: 40_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        fake.respond("/api/embed", dropConnection);

        for (let attempt = 1; attempt <= 3; attempt++) {
            const failed = await post(ana, ana.documentId, `Failing question ${attempt}?`);

            assert.equal(failed.status, 503, `attempt ${attempt}`);
            assert.deepEqual(failed.body, { message: "The model server is not available" });
        }

        assert.equal(await countRows("runs"), 0, "no failure stored a run");
        assert.equal(await countRows("question_usage"), 0, "and no failure was counted");
        fake.respond("/api/embed", answerEmbeddings());

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await post(ana, ana.documentId, `Question ${attempt}?`)).status, 200, `search ${attempt} after the failures`);
        }

        assert.equal((await post(ana, ana.documentId, "One too many?")).status, 429, "only the three that ran are counted");
        assert.equal(await countRows("question_usage"), 3);
    });

    it("answers 409 for a document without a ready index before it looks at the day: a user over the limit hears about the index", { timeout: 20_000 }, async () => {
        const ana = await seedSearcher("ana@example.com", false);
        await seedQuestionUsage(ana.user.id, 3);

        const response = await post(ana, ana.documentId, "A question?");

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { message: "This document has no ready index for chunk size 1000" });
    });
});

// Finding F6 (it changes decision D5) and T1: a client that hangs up while Ollama is embedding its question still used the model, so
// the question is counted (a row of question_usage), although no run is stored. Hanging up before the request was sent to Ollama, while
// waiting for the turn, is free (the test of "a client that hangs up" below). The embed connection is closed, and the user's place
// is freed, so the user can ask again right away.
describe("a client that hangs up during the embedding", () => {
    it("counts the question: the usage row is written and no run is stored, the connection to Ollama is closed, and with the day's other questions used up the next one is a 429", { timeout: 60_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        await seedQuestionUsage(ana.user.id, 2, 1);
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);

        const controller = new AbortController();
        const leaving = post(ana, ana.documentId, "ana hangs up", controller.signal);
        leaving.catch(() => {});
        await within(10_000, "the embedding to reach Ollama", held.arrived);

        controller.abort();
        await assert.rejects(leaving);
        await within(10_000, "the API to close its request to Ollama", held.closed);
        await waitFor("the question to be counted", async () => (await countRows("question_usage", "user_id = $1", [ana.user.id]) === 3 ? true : undefined), 10_000);

        assert.equal(await countRows("runs"), 0, "no run is stored for a question nobody was told the answer to");

        fake.respond("/api/embed", answerEmbeddings());
        const next = await post(ana, ana.documentId, "ana asks again");

        assert.equal(next.status, 429, "two seeded questions and the one that was lost are the three of the day");
        assert.deepEqual(next.body, DAILY);
        assert.ok(!embedInputs().some((input) => input[0] === "ana asks again"), "and it never reached Ollama");
    });

    it("frees the user's place at once: the user can ask again right away, without a 409, and both questions are counted", { timeout: 60_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);

        const controller = new AbortController();
        const leaving = post(ana, ana.documentId, "ana hangs up", controller.signal);
        leaving.catch(() => {});
        await within(10_000, "the embedding to reach Ollama", held.arrived);

        controller.abort();
        await assert.rejects(leaving);
        await within(10_000, "the API to close its request to Ollama", held.closed);
        await waitFor("the question to be counted", async () => (await countRows("question_usage", "user_id = $1", [ana.user.id]) === 1 ? true : undefined), 10_000);

        fake.respond("/api/embed", answerEmbeddings());
        const next = await post(ana, ana.documentId, "ana asks again");

        assert.equal(next.status, 200, `neither a 409 for a question in progress nor a 503: ${JSON.stringify(next.body)}`);
        assert.equal(await countRows("runs", "user_id = $1", [ana.user.id]), 1, "only the second question was stored");
        assert.equal(await countRows("question_usage", "user_id = $1", [ana.user.id]), 2, "the lost question and the answered one");
    });
});

describe("one question at a time for each user", () => {
    it("answers 409 to a second question of a user whose first is in progress, serves another user, and lets the user ask again when the first is done", { timeout: 40_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        const bob = await seedSearcher("bob@example.com");
        holdQuestion("ana first");

        const first = post(ana, ana.documentId, "ana first");
        await waitForRequests(fake, "/api/embed", 1);

        const second = await post(ana, ana.documentId, "ana second");
        assert.equal(second.status, 409);
        assert.deepEqual(second.body, IN_PROGRESS);
        assert.equal(await countRows("runs"), 0, "nothing is stored while the first is held, and the refused second stored nothing");
        assert.deepEqual(embedInputs(), [["ana first"]], "the second never reached Ollama");

        // another user is not told to wait for ana: the request is taken and waits for the model like any other
        const others = post(bob, bob.documentId, "bob first");
        await waitFor("bob's question to wait for the model", async () => (getModelTurnWaitingCount() === 1 ? true : undefined), 10_000);

        releaseQuestion("ana first");

        assert.equal((await within(15_000, "the first answer", first)).status, 200);
        assert.equal((await within(15_000, "bob's answer", others)).status, 200, "another user was served");
        assert.deepEqual(embedInputs(), [["ana first"], ["bob first"]], "the model served them one at a time, in order");

        assert.equal((await post(ana, ana.documentId, "ana third")).status, 200, "once the first finished, the user can ask again");
        assert.equal(await countRows("runs", "user_id = $1", [ana.user.id]), 2);
    });

    it("frees the user's place when the question fails: the next one is not refused with 409", { timeout: 40_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        fake.respond("/api/embed", dropConnection);

        assert.equal((await post(ana, ana.documentId, "fails")).status, 503);

        fake.respond("/api/embed", answerEmbeddings());
        assert.equal((await post(ana, ana.documentId, "works")).status, 200);
    });
});

describe("the questions waiting for the model's turn (MAX_WAITING_QUESTIONS, 2 here)", () => {
    it("answers 503 busy to a third question that would have to wait, and the waiting ones finish when the turn is released", { timeout: 60_000 }, async () => {
        const [ana, bob, cara, dan] = [await seedSearcher("ana@example.com"), await seedSearcher("bob@example.com"), await seedSearcher("cara@example.com"), await seedSearcher("dan@example.com")];
        holdQuestion("ana holds the turn");

        const holder = post(ana, ana.documentId, "ana holds the turn");
        await waitForRequests(fake, "/api/embed", 1);

        const waitingOne = post(bob, bob.documentId, "bob waits");
        const waitingTwo = post(cara, cara.documentId, "cara waits");
        await waitFor("two questions to wait for the model", async () => (getModelTurnWaitingCount() === 2 ? true : undefined), 10_000);

        const refused = await post(dan, dan.documentId, "dan is too many");

        assert.equal(refused.status, 503);
        assert.deepEqual(refused.body, BUSY);
        assert.equal(await countRows("runs", "user_id = $1", [dan.user.id]), 0, "nothing stored for the refused one");
        assert.ok(!embedInputs().some((input) => input[0] === "dan is too many"), "it never reached Ollama");

        releaseQuestion("ana holds the turn");

        for (const [name, pending] of [["ana", holder], ["bob", waitingOne], ["cara", waitingTwo]] as const) {
            assert.equal((await within(20_000, `${name}'s answer`, pending)).status, 200, name);
        }

        assert.equal((await post(dan, dan.documentId, "dan again")).status, 200, "with the line empty, dan is served");
    });

    it("lets a question in as soon as the one that held the turn is on its way: a started question is no longer waiting", { timeout: 40_000 }, async () => {
        const [ana, bob, cara, dan] = [await seedSearcher("ana@example.com"), await seedSearcher("bob@example.com"), await seedSearcher("cara@example.com"), await seedSearcher("dan@example.com")];
        holdQuestion("ana is running");

        const running = post(ana, ana.documentId, "ana is running");
        await waitForRequests(fake, "/api/embed", 1);

        // the question that holds the turn is not one of the two waiting places
        const waiting = [post(bob, bob.documentId, "bob waits"), post(cara, cara.documentId, "cara waits")];
        await waitFor("two questions to wait", async () => (getModelTurnWaitingCount() === 2 ? true : undefined), 10_000);
        assert.equal((await post(dan, dan.documentId, "dan is refused")).status, 503);

        releaseQuestion("ana is running");
        await within(20_000, "the end of the three questions", Promise.all([running, ...waiting]));
    });
});

describe("a client that hangs up", () => {
    it("leaves the line while it waits: its question is never sent to Ollama, nothing is stored for it, and the user can ask again at once", { timeout: 60_000 }, async () => {
        const ana = await seedSearcher("ana@example.com");
        const bob = await seedSearcher("bob@example.com");
        holdQuestion("ana holds the turn");

        const holder = post(ana, ana.documentId, "ana holds the turn");
        await waitForRequests(fake, "/api/embed", 1);

        const controller = new AbortController();
        const leaving = post(bob, bob.documentId, "bob leaves", controller.signal);
        leaving.catch(() => {});
        await waitFor("bob's question to wait for the model", async () => (getModelTurnWaitingCount() === 1 ? true : undefined), 10_000);

        controller.abort();
        await assert.rejects(leaving);
        await waitFor("bob's question to leave the line", async () => (getModelTurnWaitingCount() === 0 ? true : undefined), 10_000);

        // bob is not told he has a question in progress, and the line has a place for him
        const again = post(bob, bob.documentId, "bob again");
        await waitFor("bob's second question to wait", async () => (getModelTurnWaitingCount() === 1 ? true : undefined), 10_000);

        releaseQuestion("ana holds the turn");

        assert.equal((await within(20_000, "ana's answer", holder)).status, 200);
        assert.equal((await within(20_000, "bob's second answer", again)).status, 200);
        assert.deepEqual(embedInputs(), [["ana holds the turn"], ["bob again"]], "no embedding was ever sent for the question bob gave up");
        assert.equal(await countRows("runs", "user_id = $1", [bob.user.id]), 1, "only the second question of bob was stored");
        assert.equal(await countRows("question_usage", "user_id = $1", [bob.user.id]), 1, "and only the second was counted: leaving the line before the request was sent is free");
    });
});
