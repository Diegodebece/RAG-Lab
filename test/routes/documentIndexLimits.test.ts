import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Building an index costs the model server minutes of work, so a user may send as many index-creation requests a minute as
// upload requests: the limit of POST /v1/documents/:id/indexes is the value of UPLOAD_REQUESTS_PER_MINUTE (no setting of its
// own), set here to 3 so each test is short. The two routes keep separate counters: each limiter is its own instance, as
// every limiter of the API is, and one request of each kind is a different thing to refuse. The other limits keep their
// defaults, and this file makes far fewer requests than they allow.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.UPLOAD_REQUESTS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { countRows, seedDocument, seedIndex } = await import("../documentsFixtures.js");

const TOO_MANY = { message: "Too many requests, please try again later" };

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

// a body the validator refuses: the request is read and answered with a 400, and nothing is built
const refusedBody = { chunkSize: 400 };

const buildIndex = (auth: Auth, documentId: string, body: object = refusedBody) => request(app).post(`/v1/documents/${documentId}/indexes`).set(...auth).send(body);

const upload = (auth: Auth, body: object) => request(app).post("/v1/documents").set(...auth).send(body);

describe("the index creation requests per minute of one user (the value of UPLOAD_REQUESTS_PER_MINUTE)", () => {
    it("answers the fourth request within a minute with 429, even when its body is not valid: the request is counted before the body is read", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (let attempt = 1; attempt <= 3; attempt++) {
            const response = await buildIndex(ana.auth, document.id);

            assert.equal(response.status, 400, `request ${attempt}`);
            assert.equal(response.body.message, "Validation error", `request ${attempt}`);
        }

        const fourth = await buildIndex(ana.auth, document.id);

        assert.equal(fourth.status, 429);
        assert.deepEqual(fourth.body, TOO_MANY);
    });

    it("counts a request whose body is not JSON at all, and refuses the fourth with 429 before reading it", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);
        const broken = (): Promise<request.Response> => request(app).post(`/v1/documents/${document.id}/indexes`).set(...ana.auth).set("Content-Type", "application/json").send("{\"chunkSize\": ");

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await broken()).status, 400, `request ${attempt}`);
        }

        const fourth = await buildIndex(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(fourth.status, 429, "the three refused requests counted");
        assert.deepEqual(fourth.body, TOO_MANY);
        assert.equal(await countRows("document_indexes"), 0, "nothing was built");
    });

    it("counts a request for a document that does not exist, so ids cannot be tried without limit", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await buildIndex(ana.auth, "00000000-0000-4000-8000-000000000000", {})).status, 404, `request ${attempt}`);
        }

        assert.equal((await buildIndex(ana.auth, document.id, {})).status, 429);
    });

    it("keeps a separate count for each user", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await seedDocument(ana.id);
        const bobs = await seedDocument(bob.id);

        for (let attempt = 1; attempt <= 4; attempt++) {
            await buildIndex(ana.auth, anas.id);
        }

        assert.equal((await buildIndex(ana.auth, anas.id)).status, 429, "ana is over her limit");
        assert.equal((await buildIndex(bob.auth, bobs.id)).status, 400, "bob's first request is read and refused for its body, not counted against ana");
    });

    it("counts only the creation of indexes: reading and deleting an index are not held back by it", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);
        const kept = await seedIndex(document.id, { status: "ready", chunkSize: 500 });
        const doomed = await seedIndex(document.id, { status: "ready", chunkSize: 750 });

        for (let attempt = 1; attempt <= 4; attempt++) {
            await buildIndex(ana.auth, document.id);
        }

        assert.equal((await buildIndex(ana.auth, document.id)).status, 429);
        assert.equal((await request(app).get(`/v1/documents/${document.id}/indexes/${kept.id}`).set(...ana.auth)).status, 200);
        assert.equal((await request(app).get(`/v1/documents/${document.id}`).set(...ana.auth)).status, 200);
        assert.equal((await request(app).delete(`/v1/documents/${document.id}/indexes/${doomed.id}`).set(...ana.auth)).status, 200);
    });

    it("lets a request through that finds an index already there, up to the limit: 200 answers count too", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);
        await seedIndex(document.id, { status: "ready", chunkSize: 1000 });

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await buildIndex(ana.auth, document.id, {})).status, 200, `request ${attempt}`);
        }

        assert.equal((await buildIndex(ana.auth, document.id, {})).status, 429, "the fourth is over the limit, though it would have been a 200");
    });
});

describe("the counters of uploads and of index creation are separate", () => {
    it("does not refuse an index creation because the user used up their uploads", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (let attempt = 1; attempt <= 4; attempt++) {
            await upload(ana.auth, {});
        }

        assert.equal((await upload(ana.auth, {})).status, 429, "the uploads are used up");

        const response = await buildIndex(ana.auth, document.id);

        assert.equal(response.status, 400, "the index request is read and refused for its body, not for the limit");
    });

    it("does not refuse an upload because the user used up their index creations", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (let attempt = 1; attempt <= 4; attempt++) {
            await buildIndex(ana.auth, document.id);
        }

        assert.equal((await buildIndex(ana.auth, document.id)).status, 429, "the index creations are used up");

        const response = await upload(ana.auth, {});

        assert.equal(response.status, 400, "the upload is read and refused for its body, not for the limit");
    });
});
