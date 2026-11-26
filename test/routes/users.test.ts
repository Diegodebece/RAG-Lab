import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";

// Three password changes per user, to reach the limit quickly; each test uses accounts of its own, so none of them
// goes past three. The other limits are raised by relaxedLimits.js. Both are set before the app is imported.
const SECRET = "test-secret-only-for-these-tests-0123456789";
process.env.SECRET_KEY = SECRET;
process.env.PASSWORD_CHANGES_PER_15_MINUTES = "3";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another long password 2026";

// one real scrypt hash for every seeded account of this file
let hash = "";

before(async () => {
    await resetTestDatabase();
    hash = await makePasswordHash(PASSWORD);
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const seed = (email = "ana@example.com", extra: { role?: "user" | "admin"; status?: "active" | "disabled" } = {}) =>
    createTestUser({ email, passwordHash: hash, ...extra });

const me = (token: string) => request(app).get("/v1/users/me").set("Authorization", `Bearer ${token}`);

const login = (email: string, password: string) => request(app).post("/v1/auth/login").send({ email, password });

const changePassword = (token: string, body: object) =>
    request(app).patch("/v1/users/me/password").set("Authorization", `Bearer ${token}`).send(body);

const storedHash = async (id: string): Promise<string> =>
    (await ownerPool.query<{ hash: string }>("SELECT password_hash AS hash FROM users WHERE id = $1", [id])).rows[0].hash;

const tokenVersionOf = async (id: string): Promise<number> =>
    (await ownerPool.query<{ version: number }>("SELECT token_version AS version FROM users WHERE id = $1", [id])).rows[0].version;

describe("GET /v1/users/me", () => {
    it("returns the current user with exactly id, email, role, status and createdAt", { timeout: 15_000 }, async () => {
        const user = await seed();

        const response = await me(user.token);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Current user retrieved successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), ["createdAt", "email", "id", "role", "status"]);
        assert.equal(response.body.data.id, user.id);
        assert.equal(response.body.data.email, "ana@example.com");
        assert.equal(response.body.data.role, "user");
        assert.equal(response.body.data.status, "active");
        assert.ok(!Number.isNaN(Date.parse(response.body.data.createdAt)), "createdAt is a date");
    });

    it("never returns the password hash or the token version", { timeout: 15_000 }, async () => {
        const user = await seed();

        const response = await me(user.token);

        for (const field of ["passwordHash", "password_hash", "tokenVersion", "token_version"]) {
            assert.equal(field in response.body.data, false, field);
        }
        assert.ok(!response.text.includes("scrypt$"));
    });

    it("requires a token", { timeout: 15_000 }, async () => {
        const response = await request(app).get("/v1/users/me");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("answers 401 after the account is deleted", { timeout: 15_000 }, async () => {
        const user = await seed();
        assert.equal((await me(user.token)).status, 200, "the token works while the account exists");
        await ownerPool.query("DELETE FROM users WHERE id = $1", [user.id]);

        const response = await me(user.token);

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Invalid or expired authentication token" });
    });

    it("answers 401 after the account is disabled", { timeout: 15_000 }, async () => {
        const user = await seed();
        assert.equal((await me(user.token)).status, 200, "the token works while the account is active");
        await ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);

        const response = await me(user.token);

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Invalid or expired authentication token" });
    });

    it("shows the role the database has now, after a demotion, not the one the account had at login", { timeout: 15_000 }, async () => {
        const admin = await seed("boss@example.com", { role: "admin" });
        assert.equal((await me(admin.token)).body.data.role, "admin");

        await ownerPool.query("UPDATE users SET role = 'user' WHERE id = $1", [admin.id]);

        const response = await me(admin.token);
        assert.equal(response.status, 200);
        assert.equal(response.body.data.role, "user");
    });

    it("answers each user with their own account", { timeout: 15_000 }, async () => {
        const ana = await seed("ana@example.com");
        const bob = await seed("bob@example.com");

        assert.equal((await me(ana.token)).body.data.email, "ana@example.com");
        assert.equal((await me(bob.token)).body.data.email, "bob@example.com");
    });
});

describe("PATCH /v1/users/me/password", () => {
    it("stops the old password working and starts the new one", { timeout: 30_000 }, async () => {
        const user = await seed();

        const changed = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(changed.status, 200);
        assert.equal((await login("ana@example.com", PASSWORD)).status, 401, "the old password no longer works");
        assert.equal((await login("ana@example.com", NEW_PASSWORD)).status, 200, "the new password does");
    });

    it("stores a new scrypt hash, never the password", { timeout: 30_000 }, async () => {
        const user = await seed();

        await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        const stored = await storedHash(user.id);
        assert.notEqual(stored, hash);
        assert.match(stored, /^scrypt\$16384\$8\$5\$/);
        assert.ok(!stored.includes(NEW_PASSWORD));
    });

    it("answers with the user and a new token, and cuts off every other token of the account", { timeout: 30_000 }, async () => {
        const user = await seed();
        const otherSession = (await login("ana@example.com", PASSWORD)).body.token as string;
        assert.equal((await me(otherSession)).status, 200);

        const changed = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(changed.status, 200);
        assert.equal(changed.body.success, true);
        assert.deepEqual(Object.keys(changed.body.data).sort(), ["createdAt", "email", "id", "role", "status"]);
        assert.equal(changed.body.data.id, user.id);
        assert.equal(typeof changed.body.token, "string");

        assert.equal((await me(user.token)).status, 401, "the token that made the change");
        assert.equal((await me(otherSession)).status, 401, "a token from another session");
        const fresh = await me(changed.body.token);
        assert.equal(fresh.status, 200, "the token that came back");
        assert.equal(fresh.body.data.id, user.id);
    });

    it("raises the token version by one and signs the new token with it", { timeout: 30_000 }, async () => {
        const user = await seed();

        const changed = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(await tokenVersionOf(user.id), 1);
        const claims = jwt.verify(changed.body.token, SECRET, { algorithms: ["HS256"], issuer: "rag-lab", audience: "rag-lab-api" }) as jwt.JwtPayload;
        assert.equal(claims.sub, user.id);
        assert.equal(claims.ver, 1);
        assert.equal("role" in claims, false);
    });

    it("answers 400 for a wrong current password and changes nothing", { timeout: 30_000 }, async () => {
        const user = await seed();

        const response = await changePassword(user.token, { currentPassword: "not my password", newPassword: NEW_PASSWORD });

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: "Current password is incorrect" });
        assert.equal(await storedHash(user.id), hash, "the hash is the same");
        assert.equal(await tokenVersionOf(user.id), 0, "no session was cut off");
        assert.equal((await me(user.token)).status, 200, "the token still works");
        assert.equal((await login("ana@example.com", PASSWORD)).status, 200, "the old password still works");
    });

    it("takes a new password of 8 to 64 characters, and refuses the rest with a 400", { timeout: 45_000 }, async () => {
        for (const [length, expected] of [[7, 400], [65, 400], [8, 200], [64, 200]] as const) {
            const user = await seed(`length${length}@example.com`);

            const response = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: "x".repeat(length) });

            assert.equal(response.status, expected, `${length} characters`);

            if (expected === 400) {
                assert.equal(response.body.message, "Validation error", `${length} characters`);
                assert.equal(await storedHash(user.id), hash, `${length} characters: nothing changed`);
            }
        }
    });

    it("refuses a body without both passwords, or with a password that is not text", { timeout: 15_000 }, async () => {
        const bodies = [{}, { newPassword: NEW_PASSWORD }, { currentPassword: PASSWORD }, { currentPassword: [PASSWORD], newPassword: NEW_PASSWORD }];

        // an account for each body: every attempt counts against the limit of three
        for (const [index, body] of bodies.entries()) {
            const user = await seed(`body${index}@example.com`);
            const response = await changePassword(user.token, body);

            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal(response.body.message, "Validation error", JSON.stringify(body));
            assert.equal(await storedHash(user.id), hash, JSON.stringify(body));
        }
    });

    it("rejects extra keys such as role, so a password change cannot change anything else", { timeout: 15_000 }, async () => {
        const user = await seed();

        for (const extra of [{ role: "admin" }, { email: "other@example.com" }, { status: "active" }]) {
            const response = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...extra });

            assert.equal(response.status, 400, JSON.stringify(extra));
            assert.equal(response.body.message, "Validation error", JSON.stringify(extra));
        }

        const { rows } = await ownerPool.query<{ role: string; email: string }>("SELECT role, email FROM users WHERE id = $1", [user.id]);
        assert.deepEqual(rows[0], { role: "user", email: "ana@example.com" });
        assert.equal(await storedHash(user.id), hash, "the password was not changed either");
    });

    it("requires a token", { timeout: 15_000 }, async () => {
        const response = await request(app).patch("/v1/users/me/password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("answers 401 for the token of a session that was already ended", { timeout: 15_000 }, async () => {
        const user = await seed();
        assert.equal((await me(user.token)).status, 200, "the token works before its session ends");
        await ownerPool.query("UPDATE users SET token_version = 1 WHERE id = $1", [user.id]);

        const response = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(response.status, 401);
        assert.equal(await storedHash(user.id), hash);
    });

    // Every attempt counts, the wrong ones too: the route checks a password, so it is a way to guess one
    it("answers 429 after the configured number of attempts, counting the wrong ones", { timeout: 30_000 }, async () => {
        const user = await seed();

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await changePassword(user.token, { currentPassword: "not my password", newPassword: NEW_PASSWORD })).status, 400, `attempt ${attempt}`);
        }

        const blocked = await changePassword(user.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

        assert.equal(blocked.status, 429, "even with the right password");
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
        assert.equal(await storedHash(user.id), hash, "a blocked attempt changes nothing");
    });

    // Two requests with the same current password at the same time: both check it against the same stored hash, and
    // the change is made only while the hash is still the one that was checked, so only one can win.
    it("lets only one of two simultaneous changes win, and says so to the other", { timeout: 45_000 }, async () => {
        const user = await seed();
        const passwords = [`${NEW_PASSWORD} first`, `${NEW_PASSWORD} second`];

        const responses = await Promise.all(passwords.map((newPassword) => changePassword(user.token, { currentPassword: PASSWORD, newPassword })));

        const winners = responses.filter((response) => response.status === 200);
        const losers = responses.filter((response) => response.status !== 200);
        assert.equal(winners.length, 1, `exactly one change was made: ${JSON.stringify(responses.map((response) => response.status))}`);
        assert.equal(losers.length, 1);

        // 409 when the other request had not stored its hash yet at the time of the update; 400 when this one read
        // the new hash and found that the current password no longer matches it
        const [loser] = losers;
        const expected: Record<number, string> = {
            409: "The password was changed by another request, please try again",
            400: "Current password is incorrect"
        };
        assert.ok(loser.status in expected, `the loser got ${loser.status}`);
        assert.deepEqual(loser.body, { message: expected[loser.status] });

        const winnerPassword = passwords[responses.indexOf(winners[0])];
        const loserPassword = passwords[responses.indexOf(loser)];
        assert.equal(await tokenVersionOf(user.id), 1, "the token version was raised once, not twice");
        assert.equal((await login("ana@example.com", winnerPassword)).status, 200, "the winner's password works");
        assert.equal((await login("ana@example.com", loserPassword)).status, 401, "the loser's password was never stored");
        assert.equal((await login("ana@example.com", PASSWORD)).status, 401, "the old password is gone");
    });

    it("counts the attempts of each user apart", { timeout: 30_000 }, async () => {
        const ana = await seed("ana@example.com");
        const bob = await seed("bob@example.com");

        for (let attempt = 1; attempt <= 4; attempt++) {
            await changePassword(ana.token, { currentPassword: "not my password", newPassword: NEW_PASSWORD });
        }

        const response = await changePassword(bob.token, { currentPassword: "not my password", newPassword: NEW_PASSWORD });

        assert.equal(response.status, 400, "bob has all his attempts");
    });
});
