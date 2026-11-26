import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Two accounts per admin per hour, set before the app is imported (each test file runs in its own process, with its
// own counters). The other limits are raised by relaxedLimits.js.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.USER_CREATIONS_PER_HOUR = "2";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const create = (auth: [string, string], email: string) => request(app).post("/v1/users").set(...auth).send({ email, password: PASSWORD });

const countAccounts = async (): Promise<number> => (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0].count;

describe("the limit on creating accounts", () => {
    it("lets an admin create the configured number of accounts per hour, and then answers 429", { timeout: 30_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });

        assert.equal((await create(admin.auth, "one@example.com")).status, 201);
        assert.equal((await create(admin.auth, "two@example.com")).status, 201);

        const blocked = await create(admin.auth, "three@example.com");

        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
        assert.equal(await countAccounts(), 3, "the admin and two accounts: the third was not created");
    });

    it("counts each admin apart", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana.admin@example.com", role: "admin" });
        const bob = await createTestUser({ email: "bob.admin@example.com", role: "admin" });

        await create(ana.auth, "a1@example.com");
        await create(ana.auth, "a2@example.com");
        assert.equal((await create(ana.auth, "a3@example.com")).status, 429);

        assert.equal((await create(bob.auth, "b1@example.com")).status, 201, "another admin has their own counter");
    });

    // the limit is after the permission check: a user is told 403 however many times they try, and what they
    // try does not use up an admin's attempts
    it("is checked after the permission: a user gets 403 every time, never 429", { timeout: 30_000 }, async () => {
        const user = await createTestUser({ email: "plain.user@example.com" });

        for (let attempt = 1; attempt <= 4; attempt++) {
            assert.equal((await create(user.auth, `try${attempt}@example.com`)).status, 403, `attempt ${attempt}`);
        }
    });

    it("does not count the other admin routes: changing an account is not creating one", { timeout: 30_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const user = await createTestUser({ email: "ana@example.com" });

        for (let attempt = 1; attempt <= 3; attempt++) {
            const status = attempt % 2 === 1 ? "disabled" : "active";
            assert.equal((await request(app).patch(`/v1/users/${user.id}`).set(...admin.auth).send({ status })).status, 200, `change ${attempt}`);
        }

        assert.equal((await create(admin.auth, "one@example.com")).status, 201);
    });
});
