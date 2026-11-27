import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// The default limits, not relaxed: an upload costs the model server minutes of work, so a user may send five upload
// requests a minute (UPLOAD_REQUESTS_PER_MINUTE). The other limits keep their defaults too, and this file makes far
// fewer requests than they allow.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { countRows, seedDocument } = await import("../documentsFixtures.js");

const TOO_MANY = { message: "Too many requests, please try again later" };

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const upload = (auth: Auth, body: object) => request(app).post("/v1/documents").set(...auth).send(body);

describe("the upload requests per minute of one user (UPLOAD_REQUESTS_PER_MINUTE)", () => {
    it("answers the sixth upload request within a minute with 429, even when its body is not valid: the request is counted before the body is read", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (let attempt = 1; attempt <= 5; attempt++) {
            const response = await upload(ana.auth, {});

            assert.equal(response.status, 400, `request ${attempt}`);
            assert.equal(response.body.message, "Validation error", `request ${attempt}`);
        }

        const sixth = await upload(ana.auth, {});

        assert.equal(sixth.status, 429);
        assert.deepEqual(sixth.body, TOO_MANY);
    });

    it("counts a request whose body is not JSON at all, and refuses the sixth with 429 before reading it", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const broken = (): Promise<request.Response> => request(app).post("/v1/documents").set(...ana.auth).set("Content-Type", "application/json").send("{\"filename\": ");

        for (let attempt = 1; attempt <= 5; attempt++) {
            assert.equal((await broken()).status, 400, `request ${attempt}`);
        }

        const sixth = await upload(ana.auth, { filename: "small.txt", text: "A short invented text." });
        assert.equal(sixth.status, 429, "the five refused requests counted");
        assert.deepEqual(sixth.body, TOO_MANY);
    });

    it("keeps a separate count for each user", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });

        for (let attempt = 1; attempt <= 6; attempt++) {
            await upload(ana.auth, {});
        }

        assert.equal((await upload(ana.auth, {})).status, 429, "ana is over her limit");

        const response = await upload(bob.auth, {});
        assert.equal(response.status, 400, "bob's first request is read and refused for its body, not counted against ana");
    });

    it("counts only the uploads: reading documents is not held back by it", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (let attempt = 1; attempt <= 6; attempt++) {
            await upload(ana.auth, {});
        }

        assert.equal((await upload(ana.auth, {})).status, 429);
        assert.equal((await request(app).get("/v1/documents").set(...ana.auth)).status, 200);
        assert.equal((await request(app).get(`/v1/documents/${document.id}`).set(...ana.auth)).status, 200);
        assert.equal(await countRows("documents"), 1);
    });
});
