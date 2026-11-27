import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// A low per-minute limit, set before the app is imported (each test file runs in its own process).
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, signTestToken, validClaims } = await import("./testUsers.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

describe("the protected section of /v1", () => {
    it("asks for a token on any unknown /v1 path", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/v1/nothing-here");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("answers 404 for an unknown /v1 path when the token belongs to an active account", { timeout: 10_000 }, async () => {
        const user = await createTestUser({ email: "ana@example.com" });

        const response = await request(app).get("/v1/nothing-here").set(...user.auth);

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Route not found" });
    });

    it("answers 401, not 404, on an unknown path when the token is valid but its account is not", { timeout: 10_000 }, async () => {
        const active = await createTestUser({ email: "active@example.com" });
        const gone = await createTestUser({ email: "gone@example.com" });
        const disabled = await createTestUser({ email: "disabled@example.com", status: "disabled" });
        await ownerPool.query("DELETE FROM users WHERE id = $1", [gone.id]);

        assert.equal((await request(app).get("/v1/nothing-here").set(...active.auth)).status, 404, "an active account gets the 404");

        const cases: [string, [string, string]][] = [
            ["a deleted account", gone.auth],
            ["a disabled account", disabled.auth],
            ["an id that was never an account", ["Authorization", `Bearer ${signTestToken(validClaims(randomUUID(), 0))}`]]
        ];

        for (const [label, auth] of cases) {
            const response = await request(app).get("/v1/nothing-here").set(...auth);

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, { message: "Invalid or expired authentication token" }, label);
        }
    });

    it("answers 404, not 401, for a path outside /v1", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/nothing-here");

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Route not found" });
    });

    it("leaves login public and asks for a token on every other account route", { timeout: 15_000 }, async () => {
        const noToken: [string, string][] = [
            ["post", "/v1/auth/logout"],
            ["get", "/v1/users/me"],
            ["patch", "/v1/users/me/password"],
            ["post", "/v1/users"],
            ["patch", `/v1/users/${randomUUID()}`],
            ["get", "/v1/configuration"],
            ["post", "/v1/configuration/resolve"],
            ["get", "/v1/profiles"],
            ["post", "/v1/profiles"],
            ["get", `/v1/profiles/${randomUUID()}`],
            ["patch", `/v1/profiles/${randomUUID()}`],
            ["delete", `/v1/profiles/${randomUUID()}`],
            ["get", "/v1/documents"],
            ["post", "/v1/documents"],
            ["get", `/v1/documents/${randomUUID()}`],
            ["delete", `/v1/documents/${randomUUID()}`],
            ["post", `/v1/documents/${randomUUID()}/indexes`],
            ["get", `/v1/documents/${randomUUID()}/indexes/${randomUUID()}`],
            ["delete", `/v1/documents/${randomUUID()}/indexes/${randomUUID()}`]
        ];

        for (const [method, path] of noToken) {
            const response = await request(app)[method as "get"](path);

            assert.equal(response.status, 401, `${method} ${path}`);
            assert.deepEqual(response.body, { message: "Authentication token is missing" }, `${method} ${path}`);
        }

        const login = await request(app).post("/v1/auth/login").send({});

        assert.equal(login.status, 400, "login does not ask for a token: it answers the empty body with a validation error");
        assert.equal(login.body.message, "Validation error");
    });
});

// The test above also passes for a path that does not exist (every /v1 path asks for a token first), so this one
// shows the seven routes of layer 3 and the seven of layer 4 are mounted behind the token. One account per request:
// the limit of this file is three requests a minute for each account.
describe("the configuration, profile and document routes", () => {
    it("exist: with a valid token none of the fourteen answers 'Route not found'", { timeout: 40_000 }, async () => {
        const routes: [string, string][] = [
            ["get", "/v1/configuration"],
            ["post", "/v1/configuration/resolve"],
            ["get", "/v1/profiles"],
            ["post", "/v1/profiles"],
            ["get", `/v1/profiles/${randomUUID()}`],
            ["patch", `/v1/profiles/${randomUUID()}`],
            ["delete", `/v1/profiles/${randomUUID()}`],
            ["get", "/v1/documents"],
            ["post", "/v1/documents"],
            ["get", `/v1/documents/${randomUUID()}`],
            ["delete", `/v1/documents/${randomUUID()}`],
            ["post", `/v1/documents/${randomUUID()}/indexes`],
            ["get", `/v1/documents/${randomUUID()}/indexes/${randomUUID()}`],
            ["delete", `/v1/documents/${randomUUID()}/indexes/${randomUUID()}`]
        ];

        for (const [index, [method, path]] of routes.entries()) {
            const user = await createTestUser({ email: `route${index}@example.com` });
            const response = await request(app)[method as "get"](path).set(...user.auth);

            assert.notEqual(response.body.message, "Route not found", `${method} ${path}`);
            assert.notEqual(response.status, 401, `${method} ${path}`);
        }
    });
});

describe("requests per minute to the protected routes", () => {
    it("counts every protected request of a user, and each user apart", { timeout: 10_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });

        for (const path of ["/v1/first", "/v1/second", "/v1/third"]) {
            assert.equal((await request(app).get(path).set(...ana.auth)).status, 404, path);
        }

        const blocked = await request(app).get("/v1/fourth").set(...ana.auth);
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });

        assert.equal((await request(app).get("/v1/first").set(...bob.auth)).status, 404, "another user has their own counter");
    });

    // more checks than the per-minute limit of the protected routes (3 here), all answered: the health check is
    // neither counted against that limit nor asked for a token
    it("leaves the public routes out", { timeout: 10_000 }, async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await request(app).get("/v1/health")).status, 200, `check ${attempt + 1}`);
        }
    });
});
