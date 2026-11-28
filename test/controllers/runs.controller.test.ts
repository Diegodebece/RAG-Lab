import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { embeddingsFor, startFakeOllama } from "../doubles/fakeOllama.js";

// The search controller (finding F9, round 2): it aborts the search when the client goes away, through res.on("close"). A request whose
// socket is already closed when the controller starts (the client hung up while the request waited in the middleware before it) never
// gets a "close" event again, so nothing would abort the search: it would embed the question, store a run and count it for nobody. The
// controller aborts at once when req.destroyed or res.closed is already true. The request and the response are small stand-ins (the
// controller reads req.user, req.params.id, req.validatedBody, req.destroyed and res.closed / res.writableFinished / res.on / res.status /
// res.json); the service behind them is the real one, with the real database and the fake Ollama.
//
// Contract chosen: a closed request is not answered at all (res.json is never called); what the controller does with the
// cancellation (next(error) or nothing) is not asserted.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { searchDocument } = await import("../../src/v1/controllers/runs.controller.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("../routes/testUsers.js");
const { countRows, seedDocument, seedIndex } = await import("../documentsFixtures.js");

const QUESTION = "What colour is the sky?";

before(resetTestDatabase);

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", embeddingsFor({ [QUESTION]: [1, 0] }));
});

after(async () => {
    await fake.close();
    await closeTestPools();
});

const embedRequests = () => fake.requests.filter((entry) => entry.path === "/api/embed");

interface FakeResponse extends EventEmitter {
    closed: boolean;
    writableFinished: boolean;
    statusCode: number | undefined;
    body: unknown;
    status: (code: number) => FakeResponse;
    json: (body: unknown) => FakeResponse;
}

const makeResponse = (closed: boolean): FakeResponse => {
    const response = new EventEmitter() as FakeResponse;

    response.closed = closed;
    response.writableFinished = false;
    response.statusCode = undefined;
    response.body = undefined;
    response.status = (code) => {
        response.statusCode = code;
        return response;
    };
    response.json = (body) => {
        response.body = body;
        return response;
    };

    return response;
};

const makeRequest = (userId: string, documentId: string, destroyed: boolean): Request<{ id: string }> =>
    ({
        user: { id: userId, role: "user", expiresAt: 0 },
        params: { id: documentId },
        validatedBody: { question: QUESTION },
        destroyed
    }) as unknown as Request<{ id: string }>;

const seedSearcher = async () => {
    const user = await createTestUser({ email: "ana@example.com" });
    const document = await seedDocument(user.id, { filename: "notes.txt" });
    await seedIndex(document.id, { status: "ready", chunkSize: 1000, chunks: ["one", "two", "three"], vectors: [[1, 0], [3, 4], [0, 1]] });

    return { user, documentId: document.id };
};

// runs the controller and gives back what it did with the response and with next
const run = async (request: Request<{ id: string }>, response: FakeResponse): Promise<{ errors: unknown[] }> => {
    const errors: unknown[] = [];
    const next: NextFunction = (error?: unknown) => {
        if (error !== undefined) {
            errors.push(error);
        }
    };

    await searchDocument(request, response as unknown as Response, next);

    return { errors };
};

describe("searchDocument: a client that is already gone when the controller starts", () => {
    it("does not embed the question, store a run or count the question when the response is already closed", { timeout: 20_000 }, async () => {
        const { user, documentId } = await seedSearcher();
        const response = makeResponse(true);

        await run(makeRequest(user.id, documentId, false), response);

        assert.deepEqual(embedRequests(), [], "nothing was sent to Ollama for a client that is not there");
        assert.equal(await countRows("runs"), 0);
        assert.equal(await countRows("question_usage"), 0, "the question never reached the model, so it is free");
        assert.equal(response.body, undefined, "nobody is answered");
    });

    it("does not embed the question, store a run or count the question when the request is already destroyed", { timeout: 20_000 }, async () => {
        const { user, documentId } = await seedSearcher();
        const response = makeResponse(false);

        await run(makeRequest(user.id, documentId, true), response);

        assert.deepEqual(embedRequests(), []);
        assert.equal(await countRows("runs"), 0);
        assert.equal(await countRows("question_usage"), 0);
        assert.equal(response.body, undefined);
    });

    it("frees the user's place: a live request of the same user is answered right after, not refused with 409", { timeout: 20_000 }, async () => {
        const { user, documentId } = await seedSearcher();

        await run(makeRequest(user.id, documentId, true), makeResponse(false));
        const live = makeResponse(false);
        const outcome = await run(makeRequest(user.id, documentId, false), live);

        assert.deepEqual(outcome.errors, []);
        assert.equal(live.statusCode, 200);
    });
});

// the control: the same stand-ins with a client that is there, so the tests above fail for the closed socket and not for the stand-ins
describe("searchDocument: a client that is there", () => {
    it("answers 200 with the run, sends one embedding to Ollama and stores the run", { timeout: 20_000 }, async () => {
        const { user, documentId } = await seedSearcher();
        const response = makeResponse(false);

        const outcome = await run(makeRequest(user.id, documentId, false), response);

        assert.deepEqual(outcome.errors, []);
        assert.equal(response.statusCode, 200);
        assert.equal((response.body as { success: boolean }).success, true);
        assert.equal(embedRequests().length, 1);
        assert.equal(await countRows("runs"), 1);
    });

    it("still aborts a search when the connection closes later, before the response is finished: nothing is stored for a question that was never sent", { timeout: 20_000 }, async () => {
        const { user, documentId } = await seedSearcher();
        const response = makeResponse(false);
        // a client that hangs up as soon as the controller is running
        const outcome = run(makeRequest(user.id, documentId, false), response);
        response.closed = true;
        response.emit("close");
        await outcome;

        // the abort came before the question reached the model, so nothing was sent, stored or counted, and nobody was answered
        assert.equal(response.body, undefined);
        assert.deepEqual(embedRequests(), []);
        assert.equal(await countRows("runs"), 0);
    });
});
