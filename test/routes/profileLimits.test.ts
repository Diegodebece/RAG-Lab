import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Three profiles per user, to reach the limit quickly. Set before the app is imported: the limits are read once, when
// their module loads (each test file is its own process). The per-minute limits keep their defaults: this file makes
// far fewer requests than they allow.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_PROFILES_PER_USER = "3";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

const AT_THE_LIMIT = { message: "You have reached the maximum number of profiles" };

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const create = (auth: Auth, name: string) => request(app).post("/v1/profiles").set(...auth).send({ name });

const remove = (auth: Auth, id: string) => request(app).delete(`/v1/profiles/${id}`).set(...auth);

const countOf = async (userId: string): Promise<number> =>
    (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM profiles WHERE user_id = $1", [userId])).rows[0].count;

const fill = async (auth: Auth, howMany: number): Promise<string[]> => {
    const ids: string[] = [];

    for (let index = 1; index <= howMany; index++) {
        const response = await create(auth, `Profile ${index}`);

        assert.equal(response.status, 201, `profile ${index}: ${JSON.stringify(response.body)}`);
        ids.push(response.body.data.id as string);
    }

    return ids;
};

describe("the number of profiles a user may keep (MAX_PROFILES_PER_USER)", () => {
    it("answers 409 'You have reached the maximum number of profiles' to the fourth profile, and stores nothing", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await fill(ana.auth, 3);

        const response = await create(ana.auth, "Profile 4");

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, AT_THE_LIMIT);
        assert.equal(await countOf(ana.id), 3);
    });

    it("makes room again when a profile is deleted", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const ids = await fill(ana.auth, 3);

        assert.equal((await create(ana.auth, "Profile 4")).status, 409);
        assert.equal((await remove(ana.auth, ids[0])).status, 200);

        const response = await create(ana.auth, "Profile 4");

        assert.equal(response.status, 201);
        assert.equal(await countOf(ana.id), 3);
        assert.equal((await create(ana.auth, "Profile 5")).status, 409, "and the limit holds again");
    });

    it("counts each user's profiles apart", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        await fill(ana.auth, 3);

        assert.equal((await create(ana.auth, "One more")).status, 409);

        await fill(bob.auth, 3);
        assert.equal((await create(bob.auth, "One more")).status, 409);
        assert.equal(await countOf(ana.id), 3);
        assert.equal(await countOf(bob.id), 3);
    });

    it("lets exactly one of two creations that arrive together take the last place", { timeout: 60_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (let round = 1; round <= 5; round++) {
            await ownerPool.query("DELETE FROM profiles WHERE user_id = $1", [ana.id]);
            await fill(ana.auth, 2);

            const answers = await Promise.all([create(ana.auth, `Race ${round} a`), create(ana.auth, `Race ${round} b`)]);

            assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409], `round ${round}`);
            assert.deepEqual(answers.find((answer) => answer.status === 409)?.body, AT_THE_LIMIT, `round ${round}`);
            assert.equal(await countOf(ana.id), 3, `round ${round}: never more than the limit`);
        }
    });

    it("lets exactly one of six creations that arrive together take the last place", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await fill(ana.auth, 2);

        const answers = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => create(ana.auth, `Crowd ${index}`)));

        assert.equal(answers.filter((answer) => answer.status === 201).length, 1);
        assert.equal(answers.filter((answer) => answer.status === 409).length, 5);
        assert.equal(await countOf(ana.id), 3);
    });

    it("stores nothing for a creation that is refused, whether for a duplicate name or for the limit", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await fill(ana.auth, 2);

        const duplicate = await create(ana.auth, "profile 1");
        assert.equal(duplicate.status, 409);
        assert.deepEqual(duplicate.body, { message: "A profile with that name already exists" });
        assert.equal(await countOf(ana.id), 2, "a duplicate name takes no place");

        assert.equal((await create(ana.auth, "Profile 3")).status, 201, "and the place is still free");

        const overTheLimit = await create(ana.auth, "Profile 4");
        assert.equal(overTheLimit.status, 409);
        assert.equal(await countOf(ana.id), 3);

        const { rows } = await ownerPool.query<{ name: string }>("SELECT name FROM profiles WHERE user_id = $1 ORDER BY name", [ana.id]);
        assert.deepEqual(rows.map((row) => row.name), ["Profile 1", "Profile 2", "Profile 3"]);
    });

    it("does not limit renaming or replacing the settings of a profile when the user is at the limit", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const ids = await fill(ana.auth, 3);

        const response = await request(app).patch(`/v1/profiles/${ids[0]}`).set(...ana.auth).send({ name: "Renamed", settings: { topK: 5 } });

        assert.equal(response.status, 200);
        assert.equal(await countOf(ana.id), 3);
    });
});
