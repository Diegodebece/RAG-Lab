import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

// A low per-user limit for the last tests, set before the app is imported (the limits are read when they load).
// The tests of the middleware itself use a small app of their own and do not touch it.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");
const { authenticateMiddleware } = await import("../../src/v1/middlewares/authenticate.middleware.js");
const { currentUserMiddleware } = await import("../../src/v1/middlewares/currentUser.middleware.js");
const { errorMiddleware } = await import("../../src/v1/middlewares/error.middleware.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, signTestToken, validClaims } = await import("../routes/testUsers.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

// a small app with only the two middlewares, to see what they leave in the request
const probeApp = express();
probeApp.get("/probe", authenticateMiddleware, currentUserMiddleware, (req, res) => res.json({ user: req.user, decoded: req.decoded }));
probeApp.use(errorMiddleware);

const INVALID = { message: "Invalid or expired authentication token" };

describe("currentUserMiddleware", () => {
    it("sets req.user with the id, the role stored in the database and the token's expiry", async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const user = await createTestUser({ email: "user@example.com", role: "user" });
        const { exp } = jwt.decode(admin.token) as jwt.JwtPayload;

        const asAdmin = await request(probeApp).get("/probe").set(...admin.auth);
        const asUser = await request(probeApp).get("/probe").set(...user.auth);

        assert.equal(asAdmin.status, 200);
        assert.deepEqual(asAdmin.body.user, { id: admin.id, role: "admin", expiresAt: (exp ?? 0) * 1000 });
        assert.equal(asUser.status, 200);
        assert.equal(asUser.body.user.role, "user");
        assert.equal(asUser.body.user.id, user.id);
    });

    it("reads the role from the database, not from the token", async () => {
        const user = await createTestUser({ email: "user@example.com", role: "user" });
        const forged = signTestToken({ ...validClaims(user.id, 0), role: "admin" });

        const response = await request(probeApp).get("/probe").set("Authorization", `Bearer ${forged}`);

        assert.equal(response.status, 200);
        assert.equal(response.body.user.role, "user");
    });

    it("answers 401 when the account no longer exists", async () => {
        const user = await createTestUser({ email: "gone@example.com" });
        await ownerPool.query("DELETE FROM users WHERE id = $1", [user.id]);

        const response = await request(probeApp).get("/probe").set(...user.auth);

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, INVALID);
    });

    it("answers 401 for a token whose id was never an account", async () => {
        const response = await request(probeApp).get("/probe").set("Authorization", `Bearer ${signTestToken(validClaims(randomUUID(), 0))}`);

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, INVALID);
    });

    it("answers 401 for a token older than the account's token version", async () => {
        const user = await createTestUser({ email: "old@example.com" });
        await ownerPool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [user.id]);

        const stale = await request(probeApp).get("/probe").set(...user.auth);

        assert.equal(stale.status, 401);
        assert.deepEqual(stale.body, INVALID);

        // a token made for the new version works: only the old ones were cut off
        const fresh = await request(probeApp).get("/probe").set("Authorization", `Bearer ${signTestToken(validClaims(user.id, 1))}`);
        assert.equal(fresh.status, 200);
    });

    it("answers 401 for a disabled account, with the same message as for any other bad token", async () => {
        const user = await createTestUser({ email: "disabled@example.com", status: "disabled" });

        const response = await request(probeApp).get("/probe").set(...user.auth);

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, INVALID);
    });

    it("applies a role changed in the database to the very next request", async () => {
        const user = await createTestUser({ email: "promoted@example.com", role: "user" });

        const before = await request(probeApp).get("/probe").set(...user.auth);
        await ownerPool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
        const promoted = await request(probeApp).get("/probe").set(...user.auth);
        await ownerPool.query("UPDATE users SET role = 'user' WHERE id = $1", [user.id]);
        const demoted = await request(probeApp).get("/probe").set(...user.auth);

        assert.deepEqual([before.body.user.role, promoted.body.user.role, demoted.body.user.role], ["user", "admin", "user"]);
    });

    it("asks the database one question per request", async (t) => {
        const user = await createTestUser({ email: "one@example.com" });
        const query = t.mock.method(pool, "query");

        const response = await request(probeApp).get("/probe").set(...user.auth);

        assert.equal(response.status, 200);
        assert.equal(query.mock.callCount(), 1, "one query for the role, the status and the token version");
    });

    it("does not query the database for a request without a valid token", async (t) => {
        const query = t.mock.method(pool, "query");

        const missing = await request(probeApp).get("/probe");
        const forged = await request(probeApp).get("/probe").set("Authorization", `Bearer ${signTestToken(validClaims(randomUUID(), 0), { expiresIn: -10 })}`);

        assert.equal(missing.status, 401);
        assert.equal(forged.status, 401);
        assert.equal(query.mock.callCount(), 0);
    });
});

// The order of the real app: the token, then the per-user limit, then the database. A user over the limit costs
// the database nothing, so the limit protects it; a limit placed after the lookup would not.
describe("the order in the app: token, per-user limit, current user", () => {
    it("answers 429 to a user over the limit without querying the database", async (t) => {
        const user = await createTestUser({ email: "busy@example.com" });

        for (let attempt = 0; attempt < 3; attempt++) {
            assert.equal((await request(app).get("/v1/nothing-here").set(...user.auth)).status, 404, `request ${attempt + 1}`);
        }

        const query = t.mock.method(pool, "query");
        const blocked = await request(app).get("/v1/nothing-here").set(...user.auth);

        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
        assert.equal(query.mock.callCount(), 0, "no query was made for the blocked request");
    });

    it("counts the requests of a deleted account too, then stops asking the database", async (t) => {
        const ghost = { auth: ["Authorization", `Bearer ${signTestToken(validClaims(randomUUID(), 0))}`] as [string, string] };

        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await request(app).get("/v1/nothing-here").set(...ghost.auth);

            assert.equal(response.status, 401, `request ${attempt + 1}`);
            assert.deepEqual(response.body, INVALID);
        }

        const query = t.mock.method(pool, "query");
        const blocked = await request(app).get("/v1/nothing-here").set(...ghost.auth);

        assert.equal(blocked.status, 429);
        assert.equal(query.mock.callCount(), 0);
    });
});
