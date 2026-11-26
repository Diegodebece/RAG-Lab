import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// Points the app at a port where nothing listens, so every query fails with "connection refused" right away.
// Set before the app is imported; this file runs in its own process.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.DATABASE_URL = "postgres://rag_lab_api:wrong@127.0.0.1:1/nowhere";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");
const { signTestToken, validClaims } = await import("./testUsers.js");

after(() => pool.end());

// A database that cannot be reached is the server's problem, not the client's: a 503 that says to try again, in
// the usual body, from errorMiddleware, and nothing about the connection (no address, no driver message).
const UNAVAILABLE = { message: "The database is not available, please try again later" };

const validToken = (): string => signTestToken(validClaims(randomUUID(), 0));

describe("a database that cannot be reached during a request", () => {
    it("answers 503 to a request with a valid token, because the account cannot be checked", { timeout: 15_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const started = Date.now();

        const response = await request(app).get("/v1/users/me").set("Authorization", `Bearer ${validToken()}`);

        assert.equal(response.status, 503);
        assert.deepEqual(response.body, UNAVAILABLE);
        assert.ok(Date.now() - started < 6000, "it answered instead of hanging");
    });

    it("answers 503 on every route that needs the database, with the same body", { timeout: 30_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const bearer = `Bearer ${validToken()}`;
        const id = randomUUID();

        for (const [method, path, body] of [
            ["get", "/v1/users/me", undefined],
            ["post", "/v1/auth/logout", undefined],
            ["patch", "/v1/users/me/password", { currentPassword: "old password", newPassword: "a new password 2026" }],
            ["post", "/v1/users", { email: "a@example.com", password: "a long enough password" }],
            ["patch", `/v1/users/${id}`, { status: "disabled" }],
            ["get", "/v1/nothing-here", undefined]
        ] as const) {
            const response = await request(app)[method](path).set("Authorization", bearer).send(body);

            assert.equal(response.status, 503, `${method} ${path}`);
            assert.deepEqual(response.body, UNAVAILABLE, `${method} ${path}`);
        }
    });

    it("answers 503 to a login, with the same body", { timeout: 15_000 }, async (t) => {
        t.mock.method(console, "error", () => {});

        const response = await request(app).post("/v1/auth/login").send({ email: "ana@example.com", password: "correct horse battery staple" });

        assert.equal(response.status, 503);
        assert.deepEqual(response.body, UNAVAILABLE);
    });

    it("still answers a bad body with a 400 and a bad token with a 401, which need no database", { timeout: 15_000 }, async () => {
        const badBody = await request(app).post("/v1/auth/login").send({ email: "not-an-email", password: "x" });
        const noToken = await request(app).get("/v1/users/me");
        const forged = await request(app).get("/v1/users/me").set("Authorization", "Bearer forged-token");

        assert.equal(badBody.status, 400);
        assert.equal(noToken.status, 401);
        assert.equal(forged.status, 401);
    });
});
