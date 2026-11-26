import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
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

// Sends one complete request with a valid body and destroys the socket about 20 ms later, without reading the answer.
// Resolves once the socket is destroyed.
const sendAndHangUp = (port: number, token: string, body: object): Promise<void> => new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const outgoing = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/users",
        agent: false,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    });

    // destroying the request ends in "socket hang up": that is what the test wants
    outgoing.on("error", () => {});
    outgoing.end(payload);

    setTimeout(() => {
        outgoing.destroy();
        resolve();
    }, 20);
});

// Waits until the table has at least this many rows, for at most 10 seconds.
const waitForAccounts = async (expected: number): Promise<void> => {
    const deadline = Date.now() + 10_000;

    while ((await countAccounts()) < expected) {
        assert.ok(Date.now() < deadline, `the server did not create the accounts within 10 seconds (${await countAccounts()} of ${expected} rows)`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

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

    // Every attempt that gets past the permission check counts, whatever it ends in: the route hashes a password
    // before it answers a duplicate, so a failed attempt costs the server as much as a good one.
    it("counts the attempts that fail too: a validation error (400) and a duplicate email (409) use up the allowance", { timeout: 30_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });

        const invalid = await request(app).post("/v1/users").set(...admin.auth).send({ email: "not-an-email", password: PASSWORD });
        assert.equal(invalid.status, 400);

        const duplicate = await create(admin.auth, "admin@example.com");
        assert.equal(duplicate.status, 409);

        const blocked = await create(admin.auth, "fresh@example.com");

        assert.equal(blocked.status, 429, "two attempts were made, both failed, and both counted");
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
        assert.equal(await countAccounts(), 1, "only the admin: the third attempt was not carried out");
    });

    it("answers 429 to an attempt over the limit even when its body is invalid, before it is validated", { timeout: 30_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });

        for (const email of ["one@example.com", "two@example.com"]) {
            assert.equal((await create(admin.auth, email)).status, 201);
        }

        const blocked = await request(app).post("/v1/users").set(...admin.auth).send({ email: "not-an-email" });

        assert.equal(blocked.status, 429, "not a 400: the limit comes before the body is read");
    });

    // The server finishes creating an account whose client hung up, so the limit cannot depend on the client waiting
    // for the answer: a script that sends the request and closes the connection at once would never use it up.
    it("counts an attempt whose client closes the connection right after sending it", { timeout: 40_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", () => resolve()));

        try {
            const { port } = server.address() as AddressInfo;

            for (const email of ["hangup.one@example.com", "hangup.two@example.com"]) {
                await sendAndHangUp(port, admin.token, { email, password: PASSWORD });
            }

            // the server creates the accounts anyway, a moment later (each one hashes a password)
            await waitForAccounts(3);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        const blocked = await create(admin.auth, "third@example.com");

        assert.equal(blocked.status, 429, "the two attempts that hung up were counted");
        assert.equal(await countAccounts(), 3, "the admin and the two accounts: the third was not created");
    });
});
