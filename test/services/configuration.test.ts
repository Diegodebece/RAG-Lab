import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/v1/config/db.config.js";
import { getConfigurationProblemsService, resolveConfigurationService } from "../../src/v1/services/configuration.service.js";
import { AppError } from "../../src/v1/utils/appError.util.js";
import { closeTestPools, ownerPool, resetTestDatabase } from "../db/testDatabase.js";
import { DEFAULT_SETTINGS, DEFAULT_SNAPSHOT_HASH, DEFAULT_SNAPSHOT_TEXT, ELLIPSIS, LONG_KEY, LONG_KEY_DETAIL, PROTO_WITH_OTHER_ERRORS, SETTING_KEYS, assertDetails, canonicalText, sha256Hex } from "../configurationFixtures.js";

// resolveConfigurationService(userId, { profileId?, overrides? }) turns a user's choices into the complete
// configuration a question will use, and getConfigurationProblemsService(pool) is what the server asks at startup.
// The overrides arrive already validated by the route, so they are passed as they would be; the stored profiles are
// whatever the owner puts in the table, because a stored value outside today's caps is exactly the case to check.

before(resetTestDatabase);

// the default row is put back before each test: some tests tamper with it
beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    await ownerPool.query(
        "INSERT INTO default_profile (version, settings) VALUES (1, $1::jsonb) ON CONFLICT (singleton) DO UPDATE SET version = 1, settings = EXCLUDED.settings",
        [JSON.stringify(DEFAULT_SETTINGS)]
    );
});

after(closeTestPools);

const seedUser = async (email: string): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    return rows[0].id;
};

// settings is JSON text, so a test can store what JSON.stringify of an object could not make, such as an own "__proto__"
const seedProfile = async (userId: string, settings: string, name = "Mine", version = 1): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>(
        "INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
        [userId, name, version, settings]
    );
    return rows[0].id;
};

const resolve = (userId: string, input: { profileId?: string; overrides?: object }) => resolveConfigurationService(userId, input as never);

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof AppError, `an AppError, not ${String(error)}`);
        return error;
    }

    assert.fail("it resolved, and it should have been refused");
};

// data the server cannot use is the server's problem and not the client's: a plain Error, which errorMiddleware answers
// with the generic 500, and never an AppError (whose message and details reach the client)
const serverFailure = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof Error, `an Error, not ${String(error)}`);
        assert.ok(!(error instanceof AppError), `a plain Error (a 500), not an AppError with status ${(error as AppError).status}`);
        return error;
    }

    assert.fail("it resolved, and it should have been refused");
};

const assertPrototypeIsClean = (): void => {
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    assert.deepEqual(Object.keys(Object.prototype), []);
};

describe("resolveConfigurationService", () => {
    it("resolves to the default profile when there is no profile and no overrides", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");

        const result = await resolve(user, {});

        assert.equal(result.profileId, null);
        assert.deepEqual(result.snapshot, { version: 1, settings: DEFAULT_SETTINGS });
        assert.equal(result.snapshotText, DEFAULT_SNAPSHOT_TEXT);
        assert.equal(result.hash, DEFAULT_SNAPSHOT_HASH);
    });

    it("takes the default from the default_profile row, not from a constant", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '7')");

        const result = await resolve(user, {});

        assert.equal(result.snapshot.settings.topK, 7);
        assert.equal(result.snapshot.settings.temperature, DEFAULT_SETTINGS.temperature);
    });

    it("puts the profile over the default, and the overrides over both, key by key", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 5, \"temperature\": 0.5, \"answerMode\": \"structured\"}");

        const result = await resolve(user, { profileId, overrides: { topK: 7, answerLanguage: "es" } });

        assert.equal(result.profileId, profileId);
        assert.deepEqual(result.snapshot.settings, {
            ...DEFAULT_SETTINGS,
            topK: 7,
            temperature: 0.5,
            answerMode: "structured",
            answerLanguage: "es"
        });
    });

    it("uses the profile's value when the overrides do not mention the key, and the default when neither does", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"minScore\": 0.5}");

        const withProfile = await resolve(user, { profileId });
        const withOverrides = await resolve(user, { overrides: { maxTokens: 512 } });

        assert.deepEqual(withProfile.snapshot.settings, { ...DEFAULT_SETTINGS, minScore: 0.5 });
        assert.deepEqual(withOverrides.snapshot.settings, { ...DEFAULT_SETTINGS, maxTokens: 512 });
        assert.equal(withOverrides.profileId, null);
    });

    it("lets an override of zero win over the profile (a falsy value is a value)", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"minScore\": 0.5, \"temperature\": 0.7}");

        const result = await resolve(user, { profileId, overrides: { minScore: 0, temperature: 0 } });

        assert.equal(result.snapshot.settings.minScore, 0);
        assert.equal(result.snapshot.settings.temperature, 0);
    });

    it("refuses with 400 'The configuration is not valid' a stored profile whose value is outside today's caps, with details naming it", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 31}");

        const error = await rejection(resolve(user, { profileId }));

        assert.equal(error.status, 400);
        assert.equal(error.message, "The configuration is not valid");
        assert.equal(error.details?.length, 1, JSON.stringify(error.details));
        assert.match(error.details?.[0] ?? "", /^Top K/);
        assert.match(error.details?.[0] ?? "", /at most/);
    });

    it("reports every problem of a stored profile at once", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 31, \"smallModel\": \"gpt-oss:20b\", \"foo\": 1}");

        const error = await rejection(resolve(user, { profileId }));

        assert.equal(error.status, 400);
        assert.equal(error.details?.length, 3, JSON.stringify(error.details));
        assert.ok(error.details?.includes("Unknown setting: foo"));
    });

    it("does not need the stored value that is out of cap when an override replaces it", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 31}");

        const result = await resolve(user, { profileId, overrides: { topK: 5 } });

        assert.equal(result.snapshot.settings.topK, 5);
    });

    it("refuses a stored profile with a number written as text, because nothing is converted", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": \"3\"}");

        const error = await rejection(resolve(user, { profileId }));

        assert.equal(error.status, 400);
        assert.equal(error.message, "The configuration is not valid");
    });

    it("refuses with 400 a stored unknown key, and a stored __proto__ key, and Object.prototype stays clean", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const unknownId = await seedProfile(user, "{\"foo\": 1}", "Unknown");
        const protoId = await seedProfile(user, "{\"__proto__\": {\"polluted\": true}}", "Proto");
        const constructorId = await seedProfile(user, "{\"constructor\": {\"prototype\": {\"polluted\": true}}}", "Constructor");

        const unknown = await rejection(resolve(user, { profileId: unknownId }));
        assert.equal(unknown.status, 400);
        assert.equal(unknown.message, "The configuration is not valid");
        assert.deepEqual(unknown.details, ["Unknown setting: foo"]);

        const proto = await rejection(resolve(user, { profileId: protoId }));
        assert.equal(proto.status, 400);
        assert.deepEqual(proto.details, ["Unknown setting: __proto__"]);

        const constructed = await rejection(resolve(user, { profileId: constructorId }));
        assert.equal(constructed.status, 400);
        assert.deepEqual(constructed.details, ["Unknown setting: constructor"]);

        assertPrototypeIsClean();
    });

    it("fails with a plain error, not a 400, when the default profile was damaged after the server started: a setting past its cap, or one missing", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"temperature\": 0.5}");

        for (const assignment of ["settings = jsonb_set(settings, '{topK}', '31')", "settings = settings - 'topK'"]) {
            await ownerPool.query(`UPDATE default_profile SET ${assignment}`);

            await serverFailure(resolve(user, {}));
            await serverFailure(resolve(user, { profileId }));

            await ownerPool.query("UPDATE default_profile SET settings = $1::jsonb", [JSON.stringify(DEFAULT_SETTINGS)]);
        }

        assert.equal((await resolve(user, {})).snapshot.settings.topK, 3, "put back, it resolves again");
    });

    it("fails with a plain error, not a 400, for a profile saved by another configuration version", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 5}", "Old", 2);

        await serverFailure(resolve(user, { profileId }));
        await serverFailure(resolve(user, { profileId, overrides: { topK: 7 } }));
    });

    it("answers 404 for another user's profile at another version, before it says anything about the version", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        const anas = await seedProfile(ana, "{}", "Old", 2);

        const error = await rejection(resolve(bob, { profileId: anas }));

        assert.equal(error.status, 404);
        assert.equal(error.message, "Profile not found");
    });

    it("refuses with 400 'The configuration is not valid' overrides that are outside the caps, when the service is given them directly", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");

        const error = await rejection(resolve(user, { overrides: { topK: 31, foo: 1 } }));

        assert.equal(error.status, 400);
        assert.equal(error.message, "The configuration is not valid");
        assert.equal(error.details?.length, 2, JSON.stringify(error.details));
        assert.ok(error.details?.some((detail) => /^Top K/.test(detail)));
        assert.ok(error.details?.includes("Unknown setting: foo"));
    });

    it("echoes an unknown key of a stored profile or of the overrides cut to its first 64 characters and an ellipsis, and a key of 64 whole", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const storedLong = await seedProfile(user, JSON.stringify({ [LONG_KEY]: 1 }), "Long");
        const storedEdge = await seedProfile(user, JSON.stringify({ ["k".repeat(64)]: 1, ["j".repeat(65)]: 1 }), "Edge");

        const stored = await rejection(resolve(user, { profileId: storedLong }));
        assertDetails(stored.details, [LONG_KEY_DETAIL], "a stored profile");
        assert.ok((stored.details?.[0].length ?? 1000) < 100);

        const edge = await rejection(resolve(user, { profileId: storedEdge }));
        assertDetails(edge.details?.slice().sort(), [`Unknown setting: ${"j".repeat(64)}${ELLIPSIS}`, `Unknown setting: ${"k".repeat(64)}`], "the edge of 64");

        const given = await rejection(resolve(user, { overrides: { [LONG_KEY]: 1 } }));
        assertDetails(given.details, [LONG_KEY_DETAIL], "the overrides");
    });

    // an own "__proto__" key made by JSON.parse, in the stored settings and in the overrides, next to two other problems
    it("reports a __proto__ key together with a value past its cap and an unknown key, all three, in a stored profile and in the overrides", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, PROTO_WITH_OTHER_ERRORS);

        for (const error of [
            await rejection(resolve(user, { profileId })),
            await rejection(resolve(user, { overrides: JSON.parse(PROTO_WITH_OTHER_ERRORS) as object }))
        ]) {
            assert.equal(error.status, 400);
            assert.equal(error.details?.length, 3, JSON.stringify(error.details));
            assert.ok(error.details?.includes("Unknown setting: __proto__"));
            assert.ok(error.details?.includes("Unknown setting: foo"));
            assert.ok(error.details?.some((detail) => /^Top K.*at most 30/.test(detail)));
        }

        assertPrototypeIsClean();
    });

    it("answers the same 404 'Profile not found' for another user's profile and for a random UUID, and for a malformed id", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        const anasProfile = await seedProfile(ana, "{}");

        const others = await rejection(resolve(bob, { profileId: anasProfile }));
        const missing = await rejection(resolve(bob, { profileId: randomUUID() }));
        const malformed = await rejection(resolve(bob, { profileId: "not-a-uuid" }));

        for (const error of [others, missing, malformed]) {
            assert.equal(error.status, 404);
            assert.equal(error.message, "Profile not found");
            assert.equal(error.details, undefined);
        }

        assert.equal((await resolve(ana, { profileId: anasProfile })).profileId, anasProfile, "the owner still resolves it");
    });

    it("returns a frozen result: assigning a setting throws", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 5}");

        for (const result of [await resolve(user, {}), await resolve(user, { profileId, overrides: { answerLanguage: "es" } })]) {
            assert.ok(Object.isFrozen(result), "the result");
            assert.ok(Object.isFrozen(result.snapshot), "the snapshot");
            assert.ok(Object.isFrozen(result.snapshot.settings), "its settings");

            const settings = result.snapshot.settings as unknown as Record<string, unknown>;
            const before = JSON.stringify(settings);

            assert.throws(() => { settings.topK = 99; }, TypeError);
            assert.throws(() => { settings.extra = 1; }, TypeError);
            assert.throws(() => { (result as unknown as Record<string, unknown>).hash = "x"; }, TypeError);
            assert.equal(JSON.stringify(settings), before);
        }
    });

    it("does not change the overrides it was given, and gives a result that does not share them", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const overrides = { topK: 5 };

        const result = await resolve(user, { overrides });

        assert.deepEqual(overrides, { topK: 5 });
        assert.ok(!Object.isFrozen(overrides), "the caller's object is still the caller's");
        overrides.topK = 6;
        assert.equal(result.snapshot.settings.topK, 5);
    });

    it("gives the same snapshot and hash for the same settings from a profile, from overrides or from another user", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        const carol = await seedUser("carol@example.com");
        const anasProfile = await seedProfile(ana, "{\"topK\": 5, \"answerLanguage\": \"es\"}");
        // stored with the keys the other way round
        const bobsProfile = await seedProfile(bob, "{\"answerLanguage\": \"es\", \"topK\": 5}");

        const fromProfile = await resolve(ana, { profileId: anasProfile });
        const fromOtherUser = await resolve(bob, { profileId: bobsProfile });
        const fromOverrides = await resolve(carol, { overrides: { topK: 5, answerLanguage: "es" } });
        const fromOverridesReordered = await resolve(carol, { overrides: { answerLanguage: "es", topK: 5 } });

        for (const other of [fromOtherUser, fromOverrides, fromOverridesReordered]) {
            assert.deepEqual(other.snapshot, fromProfile.snapshot);
            assert.equal(other.snapshotText, fromProfile.snapshotText);
            assert.equal(other.hash, fromProfile.hash);
        }

        assert.notEqual(fromProfile.hash, DEFAULT_SNAPSHOT_HASH, "and it differs from the default");
    });

    it("holds exactly the version 1 keys in the snapshot, whatever the profile and the overrides hold", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const profileId = await seedProfile(user, "{\"topK\": 5}");

        for (const result of [await resolve(user, {}), await resolve(user, { profileId, overrides: { temperature: 0.2 } })]) {
            assert.deepEqual(Object.keys(result.snapshot).sort(), ["settings", "version"]);
            assert.equal(result.snapshot.version, 1);
            assert.deepEqual(Object.keys(result.snapshot.settings).sort(), [...SETTING_KEYS].sort());
        }
    });

    it("keeps the profile's id outside the hash, and the hash is the SHA-256 of the canonical text of the snapshot", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        const emptyProfile = await seedProfile(user, "{}", "Empty");

        const withProfile = await resolve(user, { profileId: emptyProfile });
        const without = await resolve(user, {});

        assert.notEqual(withProfile.profileId, without.profileId);
        assert.equal(withProfile.hash, without.hash, "an empty profile and no profile are the same configuration");
        assert.equal(withProfile.snapshotText, canonicalText(withProfile.snapshot));
        assert.equal(withProfile.hash, sha256Hex(withProfile.snapshotText));
        assert.ok(!withProfile.snapshotText.includes(emptyProfile), "the id is not in the text");
    });
});

describe("getConfigurationProblemsService", () => {
    const problems = () => getConfigurationProblemsService(pool);

    it("finds none on a freshly migrated database", { timeout: 15_000 }, async () => {
        assert.deepEqual(await problems(), []);
    });

    it("finds none when stored profiles are at version 1, whatever their settings hold", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        await seedProfile(user, "{}", "Empty");
        await seedProfile(user, "{\"topK\": 5}", "Sparse");

        assert.deepEqual(await problems(), []);
    });

    it("names a missing default row", { timeout: 15_000 }, async () => {
        await ownerPool.query("DELETE FROM default_profile");

        const found = await problems();

        assert.equal(found.length, 1, JSON.stringify(found));
        assert.match(found[0], /default/i);
    });

    it("names a default at version 2", { timeout: 15_000 }, async () => {
        await ownerPool.query("UPDATE default_profile SET version = 2");

        const found = await problems();

        assert.ok(found.some((problem) => /version/i.test(problem) && problem.includes("2")), JSON.stringify(found));
    });

    it("names a default that is missing a setting", { timeout: 15_000 }, async () => {
        await ownerPool.query("UPDATE default_profile SET settings = settings - 'topK'");

        const found = await problems();

        assert.ok(found.some((problem) => problem.includes("Top K") || problem.includes("topK")), JSON.stringify(found));
    });

    it("names a default with a setting this version does not have", { timeout: 15_000 }, async () => {
        await ownerPool.query("UPDATE default_profile SET settings = settings || '{\"foo\": 1}'::jsonb");

        const found = await problems();

        assert.ok(found.includes("Unknown setting: foo"), JSON.stringify(found));
    });

    it("names a default with a setting of a very long name cut to 64 characters", { timeout: 15_000 }, async () => {
        await ownerPool.query("UPDATE default_profile SET settings = settings || $1::jsonb", [JSON.stringify({ [LONG_KEY]: 1 })]);

        const found = await problems();

        assertDetails(found, [LONG_KEY_DETAIL]);
    });

    it("names a default setting outside its cap", { timeout: 15_000 }, async () => {
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '31')");

        const found = await problems();

        assert.equal(found.length, 1, JSON.stringify(found));
        assert.match(found[0], /^Top K.*at most/);
    });

    it("counts the stored profiles that are at another version", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        await seedProfile(user, "{}", "Old one", 2);
        await seedProfile(user, "{}", "Old two", 3);
        await seedProfile(user, "{}", "Current", 1);

        const found = await problems();

        assert.deepEqual(found, ["2 stored profiles are not at configuration version 1"]);
    });

    it("reports a default problem and the profiles together", { timeout: 15_000 }, async () => {
        const user = await seedUser("ana@example.com");
        await seedProfile(user, "{}", "Old one", 2);
        await seedProfile(user, "{}", "Old two", 2);
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '31')");

        const found = await problems();

        assert.equal(found.length, 2, JSON.stringify(found));
        assert.ok(found.some((problem) => problem.startsWith("Top K")));
        assert.ok(found.includes("2 stored profiles are not at configuration version 1"));
    });
});
