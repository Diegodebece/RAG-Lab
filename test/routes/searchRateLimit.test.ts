import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// The questions a user may send per minute (QUESTIONS_PER_MINUTE, 3 here). A search costs the model server work, so every request
// counts, the refused ones too, and the count comes before the body is read: a client cannot make the server read a large body for
// nothing. The counter is the search's own, in memory, one per user (not per token version: a logout and a login do not reset it). The other per-minute limits are out of the
// way (the upload limit stays at its default of 5, which some tests use up on purpose).
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.QUESTIONS_PER_MINUTE = "3";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "100000";
process.env.REQUESTS_PER_ADDRESS_PER_MINUTE = "100000";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const TOO_MANY = { message: "Too many requests, please try again later" };

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const search = (auth: Auth, documentId: string, body: unknown) => request(app).post(`/v1/documents/${documentId}/search`).set(...auth).send(body as object);

describe("the search requests per minute of one user (QUESTIONS_PER_MINUTE)", () => {
    it("answers the fourth request within a minute with 429, even when the first three were refused for their body: the request is counted before the body is read", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const documentId = randomUUID();

        for (let attempt = 1; attempt <= 3; attempt++) {
            const response = await search(ana.auth, documentId, {});

            assert.equal(response.status, 400, `request ${attempt}`);
            assert.equal(response.body.message, "Validation error", `request ${attempt}`);
        }

        const fourth = await search(ana.auth, documentId, { question: "A valid question?" });

        assert.equal(fourth.status, 429);
        assert.deepEqual(fourth.body, TOO_MANY);
    });

    it("counts a request whose body is over 16 kB and one that is not JSON at all, and refuses the fourth with 429 before reading it", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const documentId = randomUUID();

        assert.equal((await search(ana.auth, documentId, { question: "a".repeat(17_000) })).status, 413, "the first, too large");
        assert.equal((await request(app).post(`/v1/documents/${documentId}/search`).set(...ana.auth).set("Content-Type", "application/json").send("{\"question\": ")).status, 400, "the second, broken JSON");
        assert.equal((await search(ana.auth, documentId, {})).status, 400, "the third");

        const fourth = await search(ana.auth, documentId, { question: "a".repeat(17_000) });

        assert.equal(fourth.status, 429, "the three refused requests counted");
        assert.deepEqual(fourth.body, TOO_MANY);
    });

    it("keeps a count of its own: the searches do not use up the uploads or the index builds of the user, and they do not use up the searches", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const documentId = randomUUID();

        // ana uses up her searches...
        for (let attempt = 1; attempt <= 3; attempt++) {
            await search(ana.auth, documentId, {});
        }
        assert.equal((await search(ana.auth, documentId, {})).status, 429, "her searches are used up");

        // ...and can still upload a document and ask for an index
        const upload = await request(app).post("/v1/documents").set(...ana.auth).send({ filename: "notes.txt", text: "A short invented text about nothing." });
        assert.equal(upload.status, 202, JSON.stringify(upload.body));
        // the upload queued the index of the default size (1000) and no worker runs here, so asking for it again is the 200
        // "already there": a new size would be the 409 of builds in progress (layer 4), which says nothing about this counter
        const build = await request(app).post(`/v1/documents/${upload.body.data.id}/indexes`).set(...ana.auth).send({ chunkSize: 1000 });
        assert.equal(build.status, 200, `an index request is not counted with the searches: ${build.status} ${JSON.stringify(build.body)}`);

        // bob uses up his uploads (5 a minute) and his index builds (5 a minute): his searches are untouched
        for (let attempt = 1; attempt <= 5; attempt++) {
            assert.equal((await request(app).post("/v1/documents").set(...bob.auth).send({})).status, 400, `upload ${attempt}`);
            assert.equal((await request(app).post(`/v1/documents/${randomUUID()}/indexes`).set(...bob.auth).send({})).status, 404, `index build ${attempt}`);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await search(bob.auth, documentId, {})).status, 400, `search ${attempt}: not 429, the other counters are separate`);
        }

        assert.equal((await search(bob.auth, documentId, {})).status, 429);
    });

    // Finding F7: the search limiter was keyed by the user and the token version, so a logout (which raises the version) and a login gave
    // the user a new counter, and QUESTIONS_PER_MINUTE could be spent again and again. The key of the search limiter is the user's id
    // alone. (The general limiter keeps the version in its key, for the reason in rateLimit.middleware.ts.)
    it("does not give the user a fresh count after a logout and a login: the fourth search of the minute is a 429 with the new token too", { timeout: 40_000 }, async () => {
        const password = "correct horse battery staple";
        await createTestUser({ email: "ana@example.com", passwordHash: await makePasswordHash(password) });
        const login = async (): Promise<string> => {
            const response = await request(app).post("/v1/auth/login").send({ email: "ana@example.com", password });

            assert.equal(response.status, 200, JSON.stringify(response.body));
            return response.body.token as string;
        };
        const documentId = randomUUID();
        const first = await login();

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await search(["Authorization", `Bearer ${first}`], documentId, {})).status, 400, `search ${attempt}`);
        }
        assert.equal((await search(["Authorization", `Bearer ${first}`], documentId, {})).status, 429, "the minute's searches are used up");

        assert.equal((await request(app).post("/v1/auth/logout").set("Authorization", `Bearer ${first}`)).status, 200);
        const second = await login();

        const afterwards = await search(["Authorization", `Bearer ${second}`], documentId, { question: "A valid question?" });

        assert.equal(afterwards.status, 429, `a new token is not a new count: ${JSON.stringify(afterwards.body)}`);
        assert.deepEqual(afterwards.body, TOO_MANY);
    });

    it("keeps a separate count for each user", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const documentId = randomUUID();

        for (let attempt = 1; attempt <= 3; attempt++) {
            await search(ana.auth, documentId, {});
        }

        assert.equal((await search(ana.auth, documentId, {})).status, 429);
        assert.equal((await search(bob.auth, documentId, {})).status, 400, "another user has their own counter");
    });
});
