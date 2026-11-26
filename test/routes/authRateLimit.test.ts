import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Low limits, set before the app is imported (each test file runs in its own process, with its own counters).
// Every test uses a forwarded address of its own, so the counters of one test never reach another.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.LOGINS_PER_15_MINUTES = "6";
process.env.FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES = "2";
process.env.TRUSTED_PROXIES = "loopback";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";
const TOO_MANY = { message: "Too many requests, please try again later" };

let hash = "";

before(async () => {
    await resetTestDatabase();
    hash = await makePasswordHash(PASSWORD);
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const loginFrom = (address: string, body: object) => request(app).post("/v1/auth/login").set("X-Forwarded-For", address).send(body);

describe("failed logins per email and address", () => {
    it("blocks an email after the configured number of failed logins, whatever its capitalization", { timeout: 15_000 }, async () => {
        const attempt = (email: string) => loginFrom("203.0.113.21", { email, password: "wrong password" });

        assert.equal((await attempt("x@example.com")).status, 401);
        assert.equal((await attempt("X@example.com")).status, 401);

        const blocked = await attempt("  x@Example.com ");
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, TOO_MANY);
    });

    it("counts only the failures: successful logins do not use up the email's attempts", { timeout: 30_000 }, async () => {
        await createTestUser({ email: "ana@example.com", passwordHash: hash });
        const attempt = (password: string) => loginFrom("203.0.113.22", { email: "ana@example.com", password });

        for (let success = 0; success < 3; success++) {
            assert.equal((await attempt(PASSWORD)).status, 200, `login ${success + 1}`);
        }

        assert.equal((await attempt("wrong password")).status, 401);
        assert.equal((await attempt("wrong password")).status, 401);
        assert.equal((await attempt("wrong password")).status, 429, "the third failure is the one that is blocked");
    });

    it("does not let a failure from another address lock the owner out of their account", { timeout: 15_000 }, async () => {
        await createTestUser({ email: "victim@example.com", passwordHash: hash });

        for (let attempt = 0; attempt < 3; attempt++) {
            await loginFrom("203.0.113.23", { email: "victim@example.com", password: "guess" });
        }
        assert.equal((await loginFrom("203.0.113.23", { email: "victim@example.com", password: "guess" })).status, 429, "the guesser is blocked");

        const owner = await loginFrom("198.51.100.23", { email: "victim@example.com", password: PASSWORD });
        assert.equal(owner.status, 200);
    });

    it("keeps a separate counter for each email from the same address", { timeout: 15_000 }, async () => {
        const attempt = (email: string) => loginFrom("203.0.113.24", { email, password: "wrong password" });

        await attempt("one@example.com");
        await attempt("one@example.com");
        assert.equal((await attempt("one@example.com")).status, 429);

        assert.equal((await attempt("two@example.com")).status, 401, "another email from this address has its own counter");
    });
});

describe("logins per address", () => {
    it("blocks an address after the configured number of logins, whatever the email", { timeout: 15_000 }, async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
            assert.equal((await loginFrom("203.0.113.25", { email: `nobody${attempt}@example.com`, password: PASSWORD })).status, 401, `login ${attempt + 1}`);
        }

        const blocked = await loginFrom("203.0.113.25", { email: "never-used-before@example.com", password: PASSWORD });

        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, TOO_MANY);
    });

    it("counts the successful logins too", { timeout: 30_000 }, async () => {
        await createTestUser({ email: "ana@example.com", passwordHash: hash });

        for (let attempt = 0; attempt < 6; attempt++) {
            assert.equal((await loginFrom("203.0.113.26", { email: "ana@example.com", password: PASSWORD })).status, 200, `login ${attempt + 1}`);
        }

        assert.equal((await loginFrom("203.0.113.26", { email: "ana@example.com", password: PASSWORD })).status, 429);
    });

    it("answers an address over the limit before reading the request body", { timeout: 15_000 }, async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
            await loginFrom("203.0.113.27", { email: `nobody${attempt}@example.com`, password: PASSWORD });
        }

        // a malformed body would be a 400 if it were parsed first
        const response = await request(app)
            .post("/v1/auth/login")
            .set("X-Forwarded-For", "203.0.113.27")
            .set("Content-Type", "application/json")
            .send("{");

        assert.equal(response.status, 429);
    });

    it("does not limit another address", { timeout: 15_000 }, async () => {
        for (let attempt = 0; attempt < 7; attempt++) {
            await loginFrom("203.0.113.28", { email: `nobody${attempt}@example.com`, password: PASSWORD });
        }

        const other = await loginFrom("203.0.113.29", { email: "someone@example.com", password: PASSWORD });

        assert.equal(other.status, 401);
        assert.deepEqual(other.body, { message: "Invalid email or password" }, "the login ran and refused the credentials; it was not stopped");
    });
});
