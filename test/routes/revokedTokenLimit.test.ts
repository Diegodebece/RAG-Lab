import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Three requests per minute per user, set before the app is imported (each test file runs in its own process, with
// its own counters). The other limits are raised by relaxedLimits.js.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";
const EMAIL = "ana@example.com";

let hash = "";

before(async () => {
    await resetTestDatabase();
    hash = await makePasswordHash(PASSWORD);
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const login = async (): Promise<string> => {
    const response = await request(app).post("/v1/auth/login").send({ email: EMAIL, password: PASSWORD });

    assert.equal(response.status, 200);
    return response.body.token as string;
};

const me = (token: string) => request(app).get("/v1/users/me").set("Authorization", `Bearer ${token}`);

const logout = (token: string) => request(app).post("/v1/auth/logout").set("Authorization", `Bearer ${token}`);

// A token that was revoked by a logout is still a token the per-user limit sees (it runs before the database is asked
// about the account). If it shared a counter with the account's new token, anyone holding an old token of an account
// could spend the limit of its owner's current session.
describe("the per-user request limit and tokens that were revoked", () => {
    it("does not let requests with a revoked token use up the limit of the account's new token", { timeout: 30_000 }, async () => {
        await createTestUser({ email: EMAIL, passwordHash: hash });
        const first = await login();
        assert.equal((await logout(first)).status, 200);
        const second = await login();

        // the revoked token gets a 401 until its own counter is spent, and a 429 after that
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 6; attempt++) {
            statuses.push((await me(first)).status);
        }
        assert.equal(statuses.at(-1), 429, `the revoked token's own counter did run out: ${JSON.stringify(statuses)}`);

        const current = await me(second);

        assert.equal(current.status, 200, "the new token has a counter of its own");
        assert.equal(current.body.data.email, EMAIL);
    });

    // the control: splitting the counter by token version must not remove the limit from the token that is in use
    it("still limits the new token itself to the configured number of requests", { timeout: 30_000 }, async () => {
        await createTestUser({ email: EMAIL, passwordHash: hash });
        const first = await login();
        await logout(first);
        const second = await login();

        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal((await me(second)).status, 200, `request ${attempt}`);
        }

        const blocked = await me(second);
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
    });

    it("keeps one counter for the tokens of the same version, as before", { timeout: 30_000 }, async () => {
        await createTestUser({ email: EMAIL, passwordHash: hash });
        const one = await login();
        const same = await login();

        assert.equal((await me(one)).status, 200);
        assert.equal((await me(same)).status, 200);
        assert.equal((await me(one)).status, 200);

        assert.equal((await me(same)).status, 429, "two logins without a logout share the user's counter");
    });
});
