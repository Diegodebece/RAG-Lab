import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// The limits are raised by relaxedLimits.js, before the app is imported; the limit on account creation has its own
// file (userCreationLimit.test.ts).
const SECRET = "test-secret-only-for-these-tests-0123456789";
process.env.SECRET_KEY = SECRET;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";
const FORBIDDEN = { message: "You do not have permission to perform this action" };
const INVALID_TOKEN = { message: "Invalid or expired authentication token" };

let hash = "";

before(async () => {
    await resetTestDatabase();
    hash = await makePasswordHash(PASSWORD);
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const seedAdmin = (email = "admin@example.com") => createTestUser({ email, role: "admin", passwordHash: hash });

const seedUser = (email = "ana@example.com", status: "active" | "disabled" = "active") => createTestUser({ email, passwordHash: hash, status });

const create = (auth: [string, string], body: object) => request(app).post("/v1/users").set(...auth).send(body);

const update = (auth: [string, string], id: string, body: object) => request(app).patch(`/v1/users/${id}`).set(...auth).send(body);

const me = (auth: [string, string]) => request(app).get("/v1/users/me").set(...auth);

const login = (email: string, password: string) => request(app).post("/v1/auth/login").send({ email, password });

const countAccounts = async (): Promise<number> => (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM users")).rows[0].count;

interface Row {
    email: string;
    role: string;
    status: string;
    token_version: number;
    password_hash: string;
}

const rowOf = async (id: string): Promise<Row> =>
    (await ownerPool.query<Row>("SELECT email, role, status, token_version, password_hash FROM users WHERE id = $1", [id])).rows[0];

describe("POST /v1/users", () => {
    it("lets an admin create an account that can log in", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();

        const created = await create(admin.auth, { email: "new.user@example.com", password: "a brand new password" });

        assert.equal(created.status, 201);
        assert.equal(created.body.success, true);
        assert.equal(created.body.message, "User created successfully");
        assert.deepEqual(Object.keys(created.body.data).sort(), ["createdAt", "email", "id", "role", "status"]);
        assert.equal(created.body.data.email, "new.user@example.com");
        assert.equal(created.body.data.role, "user", "an account is a user unless the admin says otherwise");
        assert.equal(created.body.data.status, "active");
        assert.equal("token" in created.body, false, "the admin does not get a token for someone else's account");

        const loggedIn = await login("new.user@example.com", "a brand new password");
        assert.equal(loggedIn.status, 200);
        assert.equal(loggedIn.body.data.id, created.body.data.id);
        assert.equal(loggedIn.body.data.role, "user");
    });

    it("stores the email trimmed, lowercased and in form NFC", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();

        const created = await create(admin.auth, { email: "  New.User@Example.COM ", password: PASSWORD });

        assert.equal(created.status, 201);
        assert.equal(created.body.data.email, "new.user@example.com");
        assert.equal((await rowOf(created.body.data.id)).email, "new.user@example.com");
    });

    it("can create an admin, who can then create accounts", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();

        const created = await create(admin.auth, { email: "second.admin@example.com", password: PASSWORD, role: "admin" });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.role, "admin");

        const token = (await login("second.admin@example.com", PASSWORD)).body.token as string;
        const third = await create(["Authorization", `Bearer ${token}`], { email: "third@example.com", password: PASSWORD });
        assert.equal(third.status, 201);
    });

    it("stores a scrypt hash, never the password, and never returns it", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();

        const created = await create(admin.auth, { email: "hashed@example.com", password: "a password to hash" });

        const row = await rowOf(created.body.data.id);
        assert.match(row.password_hash, /^scrypt\$16384\$8\$5\$/);
        assert.ok(!row.password_hash.includes("a password to hash"));
        assert.equal(row.token_version, 0);

        for (const field of ["passwordHash", "password_hash", "tokenVersion", "token_version"]) {
            assert.equal(field in created.body.data, false, field);
        }
        assert.ok(!created.text.includes("scrypt$"), "the hash is nowhere in the response");
        assert.ok(!created.text.includes("a password to hash"));
    });

    it("answers a user with 403 and creates nothing", { timeout: 15_000 }, async () => {
        const user = await seedUser();
        const before = await countAccounts();

        const response = await create(user.auth, { email: "sneaky@example.com", password: PASSWORD, role: "admin" });

        assert.equal(response.status, 403);
        assert.deepEqual(response.body, FORBIDDEN);
        assert.equal(await countAccounts(), before);
    });

    it("answers 403 at once to an admin demoted in the database after logging in", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        assert.equal((await create(admin.auth, { email: "first@example.com", password: PASSWORD })).status, 201);

        await ownerPool.query("UPDATE users SET role = 'user' WHERE id = $1", [admin.id]);

        const response = await create(admin.auth, { email: "second@example.com", password: PASSWORD });
        assert.equal(response.status, 403, "the token still says admin; the database does not");
        assert.deepEqual(response.body, FORBIDDEN);
        assert.equal(await countAccounts(), 2, "the admin and the first account only");
    });

    it("requires a token", { timeout: 15_000 }, async () => {
        const response = await request(app).post("/v1/users").send({ email: "a@example.com", password: PASSWORD });

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("answers 409 for an email that already has an account, in any capitalization, spacing or Unicode form", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();
        const precomposed = `jos${String.fromCodePoint(0xe9)}@example.com`;
        const decomposed = `jose${String.fromCodePoint(0x301)}@example.com`;
        assert.equal((await create(admin.auth, { email: "ana@example.com", password: PASSWORD })).status, 201);
        assert.equal((await create(admin.auth, { email: precomposed, password: PASSWORD })).status, 201);

        for (const email of ["ana@example.com", "ANA@example.com", "Ana@Example.Com", "  ana@example.com  ", decomposed, precomposed.toUpperCase()]) {
            const response = await create(admin.auth, { email, password: "another password" });

            assert.equal(response.status, 409, JSON.stringify(email));
            assert.deepEqual(response.body, { message: "Email is already registered" }, JSON.stringify(email));
        }

        assert.equal(await countAccounts(), 3, "the admin and the two accounts, nothing more");
    });

    it("answers 409 for the email of a disabled account too, and does not touch the existing account", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();
        const disabled = await seedUser("off@example.com", "disabled");

        const response = await create(admin.auth, { email: "off@example.com", password: "a different password" });

        assert.equal(response.status, 409);
        const row = await rowOf(disabled.id);
        assert.equal(row.password_hash, hash, "the existing account keeps its password");
        assert.equal(row.status, "disabled");
    });

    it("rejects a body that does not follow the schema with a 400 and the problems listed", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const cases: Record<string, object> = {
            "no body fields": {},
            "invalid email": { email: "not-an-email", password: PASSWORD },
            "password of 7 characters": { email: "a@example.com", password: "x".repeat(7) },
            "password of 65 characters": { email: "a@example.com", password: "x".repeat(65) },
            "missing password": { email: "a@example.com" },
            "an unknown role": { email: "a@example.com", password: PASSWORD, role: "superadmin" },
            "a status the creation does not take": { email: "a@example.com", password: PASSWORD, status: "disabled" },
            "an id": { email: "a@example.com", password: PASSWORD, id: randomUUID() }
        };

        for (const [label, body] of Object.entries(cases)) {
            const response = await create(admin.auth, body);

            assert.equal(response.status, 400, label);
            assert.equal(response.body.message, "Validation error", label);
            assert.ok(Array.isArray(response.body.details) && response.body.details.length > 0, label);
        }

        assert.equal(await countAccounts(), 1, "nothing was created");
    });
});

describe("PATCH /v1/users/:id", () => {
    it("disables an account: its token stops working on the very next request", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();
        assert.equal((await me(user.auth)).status, 200);

        const response = await update(admin.auth, user.id, { status: "disabled" });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "User updated successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), ["createdAt", "email", "id", "role", "status"]);
        assert.equal(response.body.data.id, user.id);
        assert.equal(response.body.data.status, "disabled");

        const afterwards = await me(user.auth);
        assert.equal(afterwards.status, 401);
        assert.deepEqual(afterwards.body, INVALID_TOKEN);
    });

    it("raises the token version when it disables, so the old tokens stay dead", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();

        await update(admin.auth, user.id, { status: "disabled" });

        assert.equal((await rowOf(user.id)).token_version, 1);
    });

    it("does not revive the old tokens when the account is enabled again", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();

        await update(admin.auth, user.id, { status: "disabled" });
        const enabled = await update(admin.auth, user.id, { status: "active" });
        assert.equal(enabled.status, 200);
        assert.equal(enabled.body.data.status, "active");

        assert.equal((await me(user.auth)).status, 401, "the token from before it was disabled is still dead");

        const again = await login("ana@example.com", PASSWORD);
        assert.equal(again.status, 200, "the account itself works again");
        assert.equal((await me(["Authorization", `Bearer ${again.body.token}`])).status, 200);
    });

    it("promotes and demotes, and the role applies to the very next request with the same token", { timeout: 30_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();
        const newAccount = { email: "made.by.promoted@example.com", password: PASSWORD };
        assert.equal((await create(user.auth, newAccount)).status, 403);

        const promoted = await update(admin.auth, user.id, { role: "admin" });
        assert.equal(promoted.status, 200);
        assert.equal(promoted.body.data.role, "admin");
        assert.equal((await create(user.auth, newAccount)).status, 201, "the user's token is the same, and now the user is an admin");

        const demoted = await update(admin.auth, user.id, { role: "user" });
        assert.equal(demoted.status, 200);
        assert.equal(demoted.body.data.role, "user");
        assert.equal((await create(user.auth, { ...newAccount, email: "again@example.com" })).status, 403);
    });

    it("changes the role and the status in one request", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();

        const response = await update(admin.auth, user.id, { role: "admin", status: "disabled" });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.role, "admin");
        assert.equal(response.body.data.status, "disabled");
        const row = await rowOf(user.id);
        assert.deepEqual([row.role, row.status], ["admin", "disabled"]);
    });

    it("does not touch the other accounts", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");

        await update(admin.auth, ana.id, { status: "disabled", role: "admin" });

        const row = await rowOf(bob.id);
        assert.deepEqual([row.role, row.status, row.token_version], ["user", "active", 0]);
        assert.equal((await me(bob.auth)).status, 200);
    });

    it("answers 409 when an admin changes their own role or status, and changes nothing", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const other = await seedAdmin("other.admin@example.com");

        for (const body of [{ role: "user" }, { status: "disabled" }, { role: "user", status: "disabled" }]) {
            const response = await update(admin.auth, admin.id, body);

            assert.equal(response.status, 409, JSON.stringify(body));
            assert.deepEqual(response.body, { message: "You cannot change your own role or status" }, JSON.stringify(body));
        }

        const row = await rowOf(admin.id);
        assert.deepEqual([row.role, row.status, row.token_version], ["admin", "active", 0]);
        assert.equal((await me(admin.auth)).status, 200, "the admin can still use their token");

        // another admin can: the rule is about oneself, not about admins
        assert.equal((await update(other.auth, admin.id, { role: "user" })).status, 200);
    });

    // a UUID is the same account in any capitalization: writing the admin's own id in capitals must not get past the
    // rule against changing oneself
    it("answers 409 when an admin changes themselves writing their own id in upper case, and changes nothing", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        await seedAdmin("other.admin@example.com");
        assert.notEqual(admin.id, admin.id.toUpperCase(), "the id has letters, so the capitalization is different");

        for (const body of [{ role: "user" }, { status: "disabled" }]) {
            const response = await update(admin.auth, admin.id.toUpperCase(), body);

            assert.equal(response.status, 409, JSON.stringify(body));
            assert.deepEqual(response.body, { message: "You cannot change your own role or status" }, JSON.stringify(body));
        }

        const row = await rowOf(admin.id);
        assert.deepEqual([row.role, row.status, row.token_version], ["admin", "active", 0]);
    });

    it("answers 404 for an id that is malformed or that belongs to nobody", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();

        for (const id of ["not-a-uuid", "me", "123", "x".repeat(300), randomUUID()]) {
            const response = await update(admin.auth, id, { status: "disabled" });

            assert.equal(response.status, 404, id);
            assert.deepEqual(response.body, { message: "User not found" }, id);
        }
    });

    it("answers a user with 403 and changes nothing", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");

        const response = await update(ana.auth, bob.id, { status: "disabled" });

        assert.equal(response.status, 403);
        assert.deepEqual(response.body, FORBIDDEN);
        assert.equal((await rowOf(bob.id)).status, "active");

        const onHerself = await update(ana.auth, ana.id, { role: "admin" });
        assert.equal(onHerself.status, 403, "a user cannot promote themselves either");
        assert.equal((await rowOf(ana.id)).role, "user");
    });

    it("answers 403 to a user before it says whether the id exists", { timeout: 15_000 }, async () => {
        const user = await seedUser();

        const response = await update(user.auth, randomUUID(), { status: "disabled" });

        assert.equal(response.status, 403, "a user learns nothing about which ids have accounts");
    });

    it("requires a token", { timeout: 15_000 }, async () => {
        const user = await seedUser();

        const response = await request(app).patch(`/v1/users/${user.id}`).send({ status: "disabled" });

        assert.equal(response.status, 401);
        assert.equal((await rowOf(user.id)).status, "active");
    });

    it("needs at least one field, and takes no others", { timeout: 15_000 }, async () => {
        const admin = await seedAdmin();
        const user = await seedUser();
        const bodies: Record<string, object> = {
            "an empty body": {},
            "an unknown role": { role: "superadmin" },
            "an unknown status": { status: "banned" },
            "an email": { email: "changed@example.com" },
            "a password": { password: "a new password for you" },
            "a token version": { tokenVersion: 99 }
        };

        for (const [label, body] of Object.entries(bodies)) {
            const response = await update(admin.auth, user.id, body);

            assert.equal(response.status, 400, label);
            assert.equal(response.body.message, "Validation error", label);
        }

        const row = await rowOf(user.id);
        assert.deepEqual([row.email, row.role, row.status, row.token_version, row.password_hash], ["ana@example.com", "user", "active", 0, hash], "nothing changed");
    });
});

// Each of two admins is told "you are an admin" before the other one's change is made. If each then changes the other
// one, both would end up without the right to undo it and the system would have no admin. The change checks the actor
// again, inside its own transaction, with both rows locked in the same order (so the two cannot deadlock either).
describe("PATCH /v1/users/:id by two admins who change each other at the same moment", () => {
    const activeAdmins = async (): Promise<number> =>
        (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active'")).rows[0].count;

    for (const [label, body] of [["demote", { role: "user" }], ["disable", { status: "disabled" }]] as const) {
        it(`leaves one active admin when each admin tries to ${label} the other, and only one of the two changes is made`, { timeout: 60_000 }, async () => {
            // the race is run several times: a single run could be one where the requests did not overlap
            for (let round = 1; round <= 5; round++) {
                await ownerPool.query("TRUNCATE users CASCADE");
                const ana = await seedAdmin("ana.admin@example.com");
                const bob = await seedAdmin("bob.admin@example.com");

                const [fromAna, fromBob] = await Promise.all([update(ana.auth, bob.id, body), update(bob.auth, ana.id, body)]);

                // one change is made, and the other admin is told they may not: no deadlock, no server error
                const winner = [fromAna, fromBob].filter((response) => response.status === 200);
                const losers = [fromAna, fromBob].filter((response) => response.status !== 200);
                assert.equal(winner.length, 1, `round ${round}: one change was made (${fromAna.status} and ${fromBob.status})`);
                assert.equal(losers.length, 1, `round ${round}: the other one was refused (${fromAna.status} and ${fromBob.status})`);
                assert.equal(await activeAdmins(), 1, `round ${round}: exactly one active admin is left`);

                // refused by the service (403), or, when the first change was already made by the time the second request
                // was authenticated, by the token check: a disabled account's token is dead (401)
                const [loser] = losers;
                const allowed: [number, object][] = [[403, FORBIDDEN]];
                if (label === "disable") {
                    allowed.push([401, INVALID_TOKEN]);
                }
                assert.ok(
                    allowed.some(([status, expectedBody]) => loser.status === status && JSON.stringify(loser.body) === JSON.stringify(expectedBody)),
                    `round ${round}: the loser got ${loser.status} ${JSON.stringify(loser.body)}`
                );
            }
        });
    }
});
