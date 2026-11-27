import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

const SECRET = "test-secret-only-for-these-tests-0123456789";
process.env.SECRET_KEY = SECRET;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

const NOT_FOUND = { message: "Profile not found" };
const INVALID_TOKEN = { message: "Invalid or expired authentication token" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const create = (auth: Auth, body: unknown) => request(app).post("/v1/profiles").set(...auth).send(body as object);

// the body is sent as the text it is: an own "__proto__" key survives only when nothing but JSON.parse reads it
const createRaw = (auth: Auth, text: string) => request(app).post("/v1/profiles").set(...auth).set("Content-Type", "application/json").send(text);

// creates a profile that a test then works on: a creation that does not give 201 fails here, with its answer
const createdId = async (auth: Auth, body: unknown): Promise<string> => {
    const response = await create(auth, body);

    assert.equal(response.status, 201, `the profile this test works on was not created: ${JSON.stringify(response.body)}`);
    return response.body.data.id as string;
};

const patchRaw =(auth: Auth, id: string, text: string) => request(app).patch(`/v1/profiles/${id}`).set(...auth).set("Content-Type", "application/json").send(text);

const list = (auth: Auth) => request(app).get("/v1/profiles").set(...auth);

const show = (auth: Auth, id: string) => request(app).get(`/v1/profiles/${id}`).set(...auth);

const update = (auth: Auth, id: string, body: unknown) => request(app).patch(`/v1/profiles/${id}`).set(...auth).send(body as object);

const remove = (auth: Auth, id: string) => request(app).delete(`/v1/profiles/${id}`).set(...auth);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Row {
    id: string;
    user_id: string;
    name: string;
    version: number;
    settings: unknown;
    created_at: Date;
    updated_at: Date;
}

const rowsOf = async (userId: string): Promise<Row[]> =>
    (await ownerPool.query<Row>("SELECT id, user_id, name, version, settings, created_at, updated_at FROM profiles WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows;

const countAll = async (): Promise<number> => (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM profiles")).rows[0].count;

const rowById = async (id: string): Promise<Row | undefined> =>
    (await ownerPool.query<Row>("SELECT id, user_id, name, version, settings, created_at, updated_at FROM profiles WHERE id = $1", [id])).rows[0];

// a profile the way an older version of the app, or the owner, could have left it
const seedRaw = async (userId: string, name: string, settings: string): Promise<string> =>
    (await ownerPool.query<{ id: string }>("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, 1, $3::jsonb) RETURNING id", [userId, name, settings])).rows[0].id;

const PROFILE_KEYS = ["createdAt", "id", "name", "problems", "settings", "updatedAt"];

describe("POST /v1/profiles", () => {
    it("creates a profile: 201 with exactly createdAt, id, name, problems, settings and updatedAt, and the settings as they were sent", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await create(ana.auth, { name: "Precise", settings: { topK: 5, temperature: 0.5 } });

        assert.equal(response.status, 201);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Profile created successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), PROFILE_KEYS);
        assert.match(response.body.data.id, UUID);
        assert.equal(response.body.data.name, "Precise");
        assert.deepEqual(response.body.data.settings, { topK: 5, temperature: 0.5 });
        assert.deepEqual(response.body.data.problems, []);
        assert.ok(!Number.isNaN(Date.parse(response.body.data.createdAt)), "createdAt is a date");
        assert.ok(!Number.isNaN(Date.parse(response.body.data.updatedAt)), "updatedAt is a date");
    });

    it("stores only what the user set, for the user who asked, at configuration version 1", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await create(ana.auth, { name: "Precise", settings: { topK: 5 } });

        const rows = await rowsOf(ana.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, response.body.data.id);
        assert.equal(rows[0].version, 1);
        assert.deepEqual(rows[0].settings, { topK: 5 }, "the defaults are not copied into the profile");
    });

    it("creates a profile with no settings as an empty one", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const withoutSettings = await create(ana.auth, { name: "Plain" });
        const emptySettings = await create(ana.auth, { name: "Empty", settings: {} });

        assert.equal(withoutSettings.status, 201);
        assert.deepEqual(withoutSettings.body.data.settings, {});
        assert.equal(emptySettings.status, 201);
        assert.deepEqual(emptySettings.body.data.settings, {});
    });

    it("never returns the owner's id or the version", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await create(ana.auth, { name: "Precise" });

        for (const field of ["userId", "user_id", "version"]) {
            assert.equal(field in response.body.data, false, field);
        }
        assert.ok(!response.text.includes(ana.id), "the owner's id is not in the answer");
    });

    it("stores the name trimmed and in Unicode form NFC", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await create(ana.auth, { name: `  Cafe${String.fromCodePoint(0x301)}  ` });

        assert.equal(response.status, 201);
        assert.equal(response.body.data.name, `Caf${String.fromCodePoint(0xe9)}`);
        assert.equal((await rowsOf(ana.id))[0].name, `Caf${String.fromCodePoint(0xe9)}`);
    });

    it("answers 409 for a name the user already has, in any capitalization, and stores nothing more", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await create(ana.auth, { name: "Alpha" });

        for (const name of ["Alpha", "alpha", "ALPHA", "aLpHa"]) {
            const response = await create(ana.auth, { name });

            assert.equal(response.status, 409, name);
            assert.deepEqual(response.body, { message: "A profile with that name already exists" }, name);
        }

        assert.equal((await rowsOf(ana.id)).length, 1);
    });

    it("answers 409 for a name that is the same text in another Unicode form", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const composed = `Caf${String.fromCodePoint(0xe9)}`;
        const decomposed = `Cafe${String.fromCodePoint(0x301)}`;

        assert.equal((await create(ana.auth, { name: composed })).status, 201);

        const response = await create(ana.auth, { name: decomposed });

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { message: "A profile with that name already exists" });
        assert.equal((await rowsOf(ana.id)).length, 1);
    });

    it("lets another user have a profile with the same name", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        await create(ana.auth, { name: "Alpha" });

        const response = await create(bob.auth, { name: "ALPHA" });

        assert.equal(response.status, 201);
        assert.equal((await rowsOf(bob.id)).length, 1);
    });

    it("answers 400 'Validation error', and stores nothing, for a value past its cap, a number as text and an unknown setting", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const past = await create(ana.auth, { name: "Past", settings: { topK: 31 } });
        assert.equal(past.status, 400);
        assert.equal(past.body.message, "Validation error");
        assert.ok(past.body.details.some((detail: string) => /^Top K/.test(detail)), JSON.stringify(past.body.details));

        const asText = await create(ana.auth, { name: "Text", settings: { topK: "3" } });
        assert.equal(asText.status, 400);
        assert.equal(asText.body.message, "Validation error");

        const unknown = await create(ana.auth, { name: "Unknown", settings: { foo: 1 } });
        assert.equal(unknown.status, 400);
        assert.deepEqual(unknown.body.details, ["Unknown setting: foo"]);

        assert.equal(await countAll(), 0);
    });

    it("answers 400 for a __proto__ setting, stores nothing, and Object.prototype gains nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await createRaw(ana.auth, "{\"name\": \"Proto\", \"settings\": {\"__proto__\": {\"polluted\": true}}}");

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "Validation error");
        assert.deepEqual(response.body.details, ["Unknown setting: __proto__"]);
        assert.equal(await countAll(), 0);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });

    it("answers 400 for a missing name, an empty one, one with an invisible character and one of 101 characters", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (const body of [{}, { name: "" }, { name: "   " }, { name: `a${String.fromCodePoint(0x200b)}b` }, { name: "a".repeat(101) }, { name: 5 }]) {
            const response = await create(ana.auth, body);

            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40));
            assert.equal(response.body.message, "Validation error");
        }

        assert.equal(await countAll(), 0);
    });

    it("answers 400 for a name of 101 characters, which is under the size limit and is the validator's refusal and not a 413", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await create(ana.auth, { name: "a".repeat(101) });

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "Validation error");
    });

    it("answers 400 for malformed JSON, and stores nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await createRaw(ana.auth, "{\"name\": \"Broken\", ");

        assert.equal(response.status, 400);
        assert.equal(typeof response.body.message, "string");
        assert.equal(await countAll(), 0);
    });

    it("answers 413 'request entity too large' for a body over 16 kB, and 400 just under it", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const over = await create(ana.auth, { name: "a".repeat(17_000) });
        assert.equal(over.status, 413);
        assert.deepEqual(over.body, { message: "request entity too large" });

        const under = await create(ana.auth, { name: "a".repeat(15_000) });
        assert.equal(under.status, 400, "under the limit the body is read, and the name is too long");
        assert.equal(under.body.message, "Validation error");

        assert.equal(await countAll(), 0);
    });

    it("answers 400 and stores nothing, for anyone, when the body names another user as the owner", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });

        for (const extra of [{ userId: bob.id }, { user_id: bob.id }, { id: randomUUID() }, { isDefault: true }, { version: 2 }, { createdAt: "2020-01-01T00:00:00Z" }, { updatedAt: "2020-01-01T00:00:00Z" }]) {
            const response = await create(ana.auth, { name: "Taken over", ...extra });

            assert.equal(response.status, 400, JSON.stringify(extra));
            assert.equal(response.body.message, "Validation error");
            assert.deepEqual(response.body.details, [`"${Object.keys(extra)[0]}" is not allowed`], JSON.stringify(extra));
        }

        assert.equal(await countAll(), 0, "nothing was stored for anyone");
        assert.equal((await rowsOf(bob.id)).length, 0);
    });
});

describe("GET /v1/profiles", () => {
    it("lists the caller's profiles only, oldest first, each with the profile shape", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });

        // not in alphabetical order: the list is in the order of creation
        for (const name of ["Banana", "Apple", "Cherry"]) {
            assert.equal((await create(ana.auth, { name, settings: { topK: 4 } })).status, 201);
            await sleep(5);
        }
        await create(bob.auth, { name: "Bob's" });

        const response = await list(ana.auth);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Profiles retrieved successfully");
        assert.deepEqual(response.body.data.map((profile: { name: string }) => profile.name), ["Banana", "Apple", "Cherry"]);

        for (const profile of response.body.data) {
            assert.deepEqual(Object.keys(profile).sort(), PROFILE_KEYS);
            assert.deepEqual(profile.settings, { topK: 4 });
        }

        const bobs = await list(bob.auth);
        assert.deepEqual(bobs.body.data.map((profile: { name: string }) => profile.name), ["Bob's"]);
    });

    it("answers an empty list when the user has no profile", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        await create(bob.auth, { name: "Bob's" });

        const response = await list(ana.auth);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, []);
    });

    it("shows a profile the owner stored outside the caps with its problems, and still answers 200", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await seedRaw(ana.id, "Stale", "{\"topK\": 31, \"foo\": 1, \"temperature\": 0.5}");
        await create(ana.auth, { name: "Fine" });

        const response = await list(ana.auth);

        assert.equal(response.status, 200);
        const [stale, fine] = response.body.data;
        assert.deepEqual(stale.settings, { topK: 31, foo: 1, temperature: 0.5 }, "the stored settings, as they are");
        assert.equal(stale.problems.length, 2, JSON.stringify(stale.problems));
        assert.ok(stale.problems.every((problem: unknown) => typeof problem === "string"));
        assert.ok(stale.problems.some((problem: string) => /^Top K/.test(problem)));
        assert.ok(stale.problems.includes("Unknown setting: foo"));
        assert.deepEqual(fine.problems, []);
    });

    it("does not list another user's profile to an admin either", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const boss = await createTestUser({ email: "boss@example.com", role: "admin" });
        await create(ana.auth, { name: "Private" });

        const response = await list(boss.auth);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, []);
    });
});

describe("GET /v1/profiles/:id", () => {
    it("returns the user's own profile, also when the id is written in upper case", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const created = await create(ana.auth, { name: "Mine", settings: { topK: 5 } });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.data.id as string;

        for (const written of [id, id.toUpperCase()]) {
            const response = await show(ana.auth, written);

            assert.equal(response.status, 200, written);
            assert.equal(response.body.success, true);
            assert.equal(response.body.message, "Profile retrieved successfully");
            assert.deepEqual(response.body.data, created.body.data);
        }
    });

    it("answers the same 404 body for another user's id, a random UUID and an id that is not a UUID", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await createdId(ana.auth, { name: "Mine" });

        const answers = [
            await show(bob.auth, anas),
            await show(bob.auth, randomUUID()),
            await show(bob.auth, "not-a-uuid"),
            await show(bob.auth, "123"),
            await show(bob.auth, `${anas}x`)
        ];

        for (const answer of answers) {
            assert.equal(answer.status, 404);
            assert.deepEqual(answer.body, NOT_FOUND);
        }
    });

    it("answers 404 for twenty random UUIDs: no id of anyone else's is ever 'found'", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await create(ana.auth, { name: "Mine" });

        for (let attempt = 0; attempt < 20; attempt++) {
            const response = await show(ana.auth, randomUUID());

            assert.equal(response.status, 404);
            assert.deepEqual(response.body, NOT_FOUND);
        }
    });

    it("shows the problems of a profile stored outside the caps, with 200", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await seedRaw(ana.id, "Stale", "{\"topK\": 31}");

        const response = await show(ana.auth, id);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data.settings, { topK: 31 });
        assert.equal(response.body.data.problems.length, 1);
        assert.match(response.body.data.problems[0], /^Top K/);
    });

    it("answers an admin with 404 for another user's profile", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const boss = await createTestUser({ email: "boss@example.com", role: "admin" });
        const id = await createdId(ana.auth, { name: "Private" });

        const response = await show(boss.auth, id);

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, NOT_FOUND);
    });
});

describe("PATCH /v1/profiles/:id", () => {
    it("renames a profile and leaves its settings", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const created = await create(ana.auth, { name: "Old name", settings: { topK: 5 } });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.data.id as string;

        const response = await update(ana.auth, id, { name: "New name" });

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Profile updated successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), PROFILE_KEYS);
        assert.equal(response.body.data.name, "New name");
        assert.deepEqual(response.body.data.settings, { topK: 5 });
        assert.equal((await rowById(id))?.name, "New name");
    });

    it("replaces the settings as a whole: a key that is not sent is gone", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine", settings: { topK: 5, temperature: 0.5 } });

        const response = await update(ana.auth, id, { settings: { answerLanguage: "es" } });

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data.settings, { answerLanguage: "es" });
        assert.deepEqual((await rowById(id))?.settings, { answerLanguage: "es" });
        assert.equal((await rowById(id))?.name, "Mine", "the name is as it was");

        const emptied = await update(ana.auth, id, { settings: {} });
        assert.equal(emptied.status, 200);
        assert.deepEqual(emptied.body.data.settings, {});
        assert.deepEqual((await rowById(id))?.settings, {});
    });

    it("moves updatedAt forward and keeps createdAt", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const created = await create(ana.auth, { name: "Mine" });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        await sleep(30);

        const response = await update(ana.auth, created.body.data.id, { name: "Renamed" });

        assert.equal(response.body.data.createdAt, created.body.data.createdAt);
        assert.ok(Date.parse(response.body.data.updatedAt) > Date.parse(created.body.data.updatedAt), "updatedAt moved");
    });

    it("answers 400 for an empty body", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine" });

        const response = await update(ana.auth, id, {});

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "Validation error");
        assert.equal((await rowById(id))?.name, "Mine");
    });

    it("lets a profile be renamed to its own name in another capitalization", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Precise" });

        const response = await update(ana.auth, id, { name: "PRECISE" });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.name, "PRECISE");
    });

    it("answers 409 for a name that another profile of the user has, in any capitalization or Unicode form, and changes nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await create(ana.auth, { name: "Alpha" });
        await create(ana.auth, { name: `Caf${String.fromCodePoint(0xe9)}` });
        const beta = await createdId(ana.auth, { name: "Beta", settings: { topK: 5 } });

        for (const name of ["Alpha", "alpha", "ALPHA", `Cafe${String.fromCodePoint(0x301)}`]) {
            const response = await update(ana.auth, beta, { name, settings: { topK: 9 } });

            assert.equal(response.status, 409, name);
            assert.deepEqual(response.body, { message: "A profile with that name already exists" }, name);
        }

        const row = await rowById(beta);
        assert.equal(row?.name, "Beta");
        assert.deepEqual(row?.settings, { topK: 5 }, "the settings of the refused request were not stored either");
    });

    it("lets a user take a name that another user has", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        await create(ana.auth, { name: "Alpha" });
        const bobs = await createdId(bob.auth, { name: "Beta" });

        const response = await update(bob.auth, bobs, { name: "Alpha" });

        assert.equal(response.status, 200);
    });

    it("answers 404, and changes nothing, for another user's profile and for ids that are not anyone's", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await createdId(ana.auth, { name: "Mine", settings: { topK: 5 } });
        const before = await rowsOf(ana.id);

        for (const id of [anas, randomUUID(), "not-a-uuid"]) {
            const response = await update(bob.auth, id, { name: "Hijacked", settings: { topK: 9 } });

            assert.equal(response.status, 404, id);
            assert.deepEqual(response.body, NOT_FOUND, id);
        }

        assert.deepEqual(await rowsOf(ana.id), before, "the row is exactly as it was");
        assert.equal((await rowsOf(bob.id)).length, 0);
    });

    it("answers 400, and the owner does not change, when the body names an owner, a version or isDefault", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const id = await createdId(ana.auth, { name: "Mine" });
        const before = await rowsOf(ana.id);

        for (const extra of [{ userId: bob.id }, { user_id: bob.id }, { version: 2 }, { isDefault: true }, { id: randomUUID() }]) {
            const response = await update(ana.auth, id, { name: "Renamed", ...extra });

            assert.equal(response.status, 400, JSON.stringify(extra));
            assert.equal(response.body.message, "Validation error");
        }

        assert.deepEqual(await rowsOf(ana.id), before);
        assert.equal((await rowsOf(bob.id)).length, 0);
        assert.equal((await rowById(id))?.version, 1);
    });

    it("answers 400, and stores nothing, for a value past its cap, a number as text and a __proto__ setting", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine", settings: { topK: 5 } });
        const before = await rowsOf(ana.id);

        for (const body of [{ settings: { topK: 31 } }, { settings: { topK: "3" } }, { settings: { minScore: 0.305 } }, { settings: [] }, { name: "a".repeat(101) }]) {
            const response = await update(ana.auth, id, body);

            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40));
            assert.equal(response.body.message, "Validation error");
        }

        const proto = await patchRaw(ana.auth, id, "{\"settings\": {\"__proto__\": {\"polluted\": true}}}");
        assert.equal(proto.status, 400);
        assert.deepEqual(proto.body.details, ["Unknown setting: __proto__"]);

        assert.deepEqual(await rowsOf(ana.id), before);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });

    it("answers 413 for a body over 16 kB", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine" });

        const response = await update(ana.auth, id, { name: "a".repeat(17_000) });

        assert.equal(response.status, 413);
        assert.deepEqual(response.body, { message: "request entity too large" });
    });

    it("answers an admin with 404 for another user's profile, and changes nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const boss = await createTestUser({ email: "boss@example.com", role: "admin" });
        const id = await createdId(ana.auth, { name: "Private" });
        const before = await rowsOf(ana.id);

        const response = await update(boss.auth, id, { name: "Seized" });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, NOT_FOUND);
        assert.deepEqual(await rowsOf(ana.id), before);
    });
});

describe("DELETE /v1/profiles/:id", () => {
    it("deletes the profile: 200 without data, and the next GET is 404", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine" });

        const response = await remove(ana.auth, id);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Profile deleted successfully");
        assert.equal("data" in response.body, false);

        assert.equal((await show(ana.auth, id)).status, 404);
        assert.equal(await rowById(id), undefined);
        assert.equal((await remove(ana.auth, id)).status, 404, "a second delete finds nothing");
    });

    it("answers 404, and leaves the row, for another user's profile and for ids that are not anyone's", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await createdId(ana.auth, { name: "Mine", settings: { topK: 5 } });
        const before = await rowsOf(ana.id);

        for (const id of [anas, randomUUID(), "not-a-uuid"]) {
            const response = await remove(bob.auth, id);

            assert.equal(response.status, 404, id);
            assert.deepEqual(response.body, NOT_FOUND, id);
        }

        assert.deepEqual(await rowsOf(ana.id), before, "the row is exactly as it was");
    });

    it("answers an admin with 404 for another user's profile, and leaves the row", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const boss = await createTestUser({ email: "boss@example.com", role: "admin" });
        const id = await createdId(ana.auth, { name: "Private" });

        const response = await remove(boss.auth, id);

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, NOT_FOUND);
        assert.equal((await rowsOf(ana.id)).length, 1);
    });
});

describe("the profile routes and the account", () => {
    it("answer 401 without a token", { timeout: 15_000 }, async () => {
        const id = randomUUID();
        const calls: [string, () => request.Test][] = [
            ["GET /v1/profiles", () => request(app).get("/v1/profiles")],
            ["POST /v1/profiles", () => request(app).post("/v1/profiles").send({ name: "x" })],
            ["GET /v1/profiles/:id", () => request(app).get(`/v1/profiles/${id}`)],
            ["PATCH /v1/profiles/:id", () => request(app).patch(`/v1/profiles/${id}`).send({ name: "x" })],
            ["DELETE /v1/profiles/:id", () => request(app).delete(`/v1/profiles/${id}`)]
        ];

        for (const [label, call] of calls) {
            const response = await call();

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, { message: "Authentication token is missing" }, label);
        }

        assert.equal(await countAll(), 0);
    });

    it("answer 401 to a token that was revoked (the account's token version was raised), and store nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const id = await createdId(ana.auth, { name: "Mine" });
        await ownerPool.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [ana.id]);

        const calls: [string, request.Test][] = [
            ["GET /v1/profiles", list(ana.auth)],
            ["POST /v1/profiles", create(ana.auth, { name: "Another" })],
            ["GET /v1/profiles/:id", show(ana.auth, id)],
            ["PATCH /v1/profiles/:id", update(ana.auth, id, { name: "Renamed" })],
            ["DELETE /v1/profiles/:id", remove(ana.auth, id)]
        ];

        for (const [label, call] of calls) {
            const response = await call;

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, INVALID_TOKEN, label);
        }

        const rows = await rowsOf(ana.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, "Mine");
    });

    it("are gone with the account: deleting a user deletes their profiles, and only theirs", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        await create(ana.auth, { name: "One" });
        await create(ana.auth, { name: "Two" });
        await create(bob.auth, { name: "Three" });

        await ownerPool.query("DELETE FROM users WHERE id = $1", [ana.id]);

        assert.equal((await rowsOf(ana.id)).length, 0);
        assert.equal((await rowsOf(bob.id)).length, 1);
    });
});
