import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// A low limit per address, set before the app is imported (each test file runs in its own process, with its own
// counters). The other limits stay at their defaults, far above what these tests send.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.REQUESTS_PER_ADDRESS_PER_MINUTE = "3";
// the app's default, set rather than deleted because the app would load a value from the developer's .env
process.env.TRUSTED_PROXIES = "loopback";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const TOO_MANY = { message: "Too many requests, please try again later" };

// The requests come from this computer, as cloudflared's do, and X-Forwarded-For carries the address Cloudflare
// saw. Every test uses addresses of its own, so the counters of one never reach another.
const from = (address: string) => ({
    get: (path: string) => request(app).get(path).set("X-Forwarded-For", address),
    // a login attempt (the route is public), with the password the test chooses
    login: (password: string) => request(app).post("/v1/auth/login").set("X-Forwarded-For", address).send({ email: "nobody@example.com", password })
});

describe("the limit on every request from one address", () => {
    it("lets forged tokens through to a 401 three times, and then answers 429", { timeout: 15_000 }, async () => {
        const client = from("203.0.113.1");

        for (let attempt = 1; attempt <= 3; attempt++) {
            const response = await client.get("/v1/users/me").set("Authorization", `Bearer forged-token-${attempt}`);

            assert.equal(response.status, 401, `request ${attempt}`);
        }

        const blocked = await client.get("/v1/users/me").set("Authorization", "Bearer forged-token-4");

        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, TOO_MANY);
    });

    it("answers 429 to a valid token once its address is over the limit", { timeout: 15_000 }, async () => {
        const user = await createTestUser({ email: "ana@example.com" });
        const client = from("203.0.113.2");

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await client.get("/v1/users/me")).status, 401, `request ${attempt} has no token`);
        }

        const blocked = await client.get("/v1/users/me").set(...user.auth);

        assert.equal(blocked.status, 429, "the token is not even looked at");
        assert.deepEqual(blocked.body, TOO_MANY);
    });

    it("lets a valid token through while its address is under the limit", { timeout: 15_000 }, async () => {
        const user = await createTestUser({ email: "ana@example.com" });

        const response = await from("203.0.113.3").get("/v1/users/me").set(...user.auth);

        assert.equal(response.status, 200);
    });

    it("counts each forwarded address separately", { timeout: 15_000 }, async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            await from("203.0.113.4").get("/v1/users/me");
        }

        assert.equal((await from("203.0.113.4").get("/v1/users/me")).status, 429, "the address over its limit is blocked");
        assert.equal((await from("203.0.113.5").get("/v1/users/me")).status, 401, "another address, from the same proxy, is not");
    });

    it("ignores the addresses a client writes into the header itself", { timeout: 15_000 }, async () => {
        // Cloudflare appends the real address at the end; anything before it was written by the client
        for (let attempt = 1; attempt <= 3; attempt++) {
            await from(`198.51.100.${attempt}, 203.0.113.6`).get("/v1/users/me");
        }

        assert.equal((await from("198.51.100.99, 203.0.113.6").get("/v1/users/me")).status, 429, "a new fake address does not reset the counter");
    });

    it("does not count a CORS preflight, which carries no credentials and does nothing", { timeout: 15_000 }, async () => {
        const preflight = () => request(app)
            .options("/v1/users/me")
            .set("X-Forwarded-For", "203.0.113.7")
            .set("Origin", "https://app.example.com")
            .set("Access-Control-Request-Method", "GET")
            .set("Access-Control-Request-Headers", "authorization");

        for (let attempt = 1; attempt <= 6; attempt++) {
            assert.equal((await preflight()).status, 204, `preflight ${attempt}`);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await from("203.0.113.7").get("/v1/users/me")).status, 401, `the real request ${attempt} still has its three`);
        }

        assert.equal((await from("203.0.113.7").get("/v1/users/me")).status, 429);
    });

    it("counts the public routes too", { timeout: 15_000 }, async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await from("203.0.113.8").get("/v1/health")).status, 200, `check ${attempt}`);
        }

        assert.equal((await from("203.0.113.8").get("/v1/health")).status, 429);
    });

    it("counts the login route, which is public, with everything else of the address", { timeout: 15_000 }, async () => {
        assert.equal((await from("203.0.113.9").login("first password")).status, 401);
        assert.equal((await from("203.0.113.9").get("/v1/health")).status, 200);
        assert.equal((await from("203.0.113.9").get("/v1/users/me")).status, 401);

        assert.equal((await from("203.0.113.9").login("second password")).status, 429);
    });

    it("counts requests to paths that do not exist, inside and outside /v1", { timeout: 15_000 }, async () => {
        assert.equal((await from("203.0.113.10").get("/nothing-here")).status, 404);
        assert.equal((await from("203.0.113.10").get("/also-nothing")).status, 404);
        assert.equal((await from("203.0.113.10").get("/v1/nothing-here")).status, 401);

        const blocked = await from("203.0.113.10").get("/nothing-here");

        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, TOO_MANY);
    });
});
