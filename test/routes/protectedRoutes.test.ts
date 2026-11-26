import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// A low per-minute limit, set before the app is imported (each test file runs in its own process).
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");
const { authAs } = await import("./testTokens.js");

after(() => pool.end());

describe("the protected section of /v1", () => {
    it("asks for a token on any unknown /v1 path", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/v1/nothing-here");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("answers 404 for an unknown /v1 path when the token is valid", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/v1/nothing-here").set(...authAs(randomUUID()));

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Route not found" });
    });

    it("answers 404, not 401, for a path outside /v1", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/nothing-here");

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Route not found" });
    });
});

describe("requests per minute to the protected routes", () => {
    it("counts every protected request of a user, and each user apart", { timeout: 10_000 }, async () => {
        const ana = authAs(randomUUID());
        const bob = authAs(randomUUID());

        for (const path of ["/v1/first", "/v1/second", "/v1/third"]) {
            assert.equal((await request(app).get(path).set(...ana)).status, 404, path);
        }

        const blocked = await request(app).get("/v1/fourth").set(...ana);
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });

        assert.equal((await request(app).get("/v1/first").set(...bob)).status, 404, "another user has their own counter");
    });

    // more checks than the per-minute limit of the protected routes (3 here), all answered: the health check is
    // neither counted against that limit nor asked for a token
    it("leaves the public routes out", { timeout: 10_000 }, async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await request(app).get("/v1/health")).status, 200, `check ${attempt + 1}`);
        }
    });
});
