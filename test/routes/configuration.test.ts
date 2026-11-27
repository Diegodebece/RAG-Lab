import "./relaxedLimits.js";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

const SECRET = "test-secret-only-for-these-tests-0123456789";
process.env.SECRET_KEY = SECRET;

const { app } = await import("../../src/app.js");
const { REQUIRED_MODELS } = await import("../../src/v1/config/ollama.config.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { DEFAULT_SETTINGS, DEFAULT_SNAPSHOT_HASH, DEFAULT_SNAPSHOT_TEXT, ELLIPSIS, LONG_KEY, assertDetails, LONG_KEY_DETAIL, PROTO_WITH_OTHER_ERRORS, SETTING_DEFINITIONS, SETTING_KEYS, canonicalText, sha256Hex } = await import("../configurationFixtures.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

// some tests change the default row
afterEach(() => ownerPool.query("UPDATE default_profile SET version = 1, settings = $1::jsonb", [JSON.stringify(DEFAULT_SETTINGS)]));

after(closeTestPools);

type Auth = [string, string];

const view = (auth: Auth) => request(app).get("/v1/configuration").set(...auth);

const resolve = (auth: Auth, body: unknown) => request(app).post("/v1/configuration/resolve").set(...auth).send(body as object);

const resolveRaw = (auth: Auth, text: string) => request(app).post("/v1/configuration/resolve").set(...auth).set("Content-Type", "application/json").send(text);

const seedProfile = async (userId: string, settings: string, name = "Mine", version = 1): Promise<string> =>
    (await ownerPool.query<{ id: string }>("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, $3, $4::jsonb) RETURNING id", [userId, name, version, settings])).rows[0].id;

// a profile with an id the owner chose: the app makes version 4 ids, but the column takes any UUID
const seedProfileWithId = async (id: string, userId: string, settings: string): Promise<void> => {
    await ownerPool.query("INSERT INTO profiles (id, user_id, name, version, settings) VALUES ($1, $2, 'Chosen id', 1, $3::jsonb)", [id, userId, settings]);
};

// the text of what console.error was called with, so a test can look for what the server reported
const loggedText = (spy: { mock: { calls: { arguments: unknown[] }[] } }): string =>
    spy.mock.calls.map((call) => call.arguments.map((argument) => (argument instanceof Error ? argument.message : String(argument))).join(" ")).join("\n");

const GENERIC_500 = { message: "Internal server error" };

describe("GET /v1/configuration", () => {
    it("describes configuration version 1: the defaults, one definition per setting, and the profile limits", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await view(ana.auth);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Configuration retrieved successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), ["defaults", "profiles", "settings", "version"]);
        assert.equal(response.body.data.version, 1);
        assert.deepEqual(response.body.data.profiles, { maxPerUser: 20, maxNameLength: 100 });
    });

    it("gives the defaults the default_profile row holds, with the eleven values of RAG Web", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const { rows } = await ownerPool.query<{ settings: unknown }>("SELECT settings FROM default_profile");

        const response = await view(ana.auth);

        assert.deepEqual(response.body.data.defaults, rows[0].settings);
        assert.deepEqual(response.body.data.defaults, DEFAULT_SETTINGS);
        assert.deepEqual(Object.keys(response.body.data.defaults).sort(), [...SETTING_KEYS].sort(), "exactly the eleven keys");
    });

    it("reads the defaults from the row on every request, so a new default shows at once", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '8')");

        const response = await view(ana.auth);

        assert.equal(response.body.data.defaults.topK, 8);
    });

    it("lists one definition per setting, in order, with the caps", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await view(ana.auth);

        assert.deepEqual(response.body.data.settings.map((definition: { key: string }) => definition.key), SETTING_KEYS);
        assert.deepEqual(response.body.data.settings, SETTING_DEFINITIONS);
    });

    it("answers 401 without a token", { timeout: 15_000 }, async () => {
        const response = await request(app).get("/v1/configuration");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("allows only models the health check requires, so a setting can never name a model the server does not have", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await view(ana.auth);

        assert.equal(response.status, 200);

        const modelDefinitions = response.body.data.settings.filter((definition: { key: string }) => ["embeddingModel", "smallModel"].includes(definition.key));
        assert.equal(modelDefinitions.length, 2);

        for (const definition of modelDefinitions) {
            assert.ok(Array.isArray(definition.allowed) && definition.allowed.length > 0, definition.key);

            for (const model of definition.allowed) {
                assert.ok(REQUIRED_MODELS.includes(model), `${definition.key} allows ${model}, which the health check does not require`);
            }
        }

        for (const model of [response.body.data.defaults.embeddingModel, response.body.data.defaults.smallModel]) {
            assert.ok(REQUIRED_MODELS.includes(model), `the default ${model} is a required model`);
        }
    });
});

describe("POST /v1/configuration/resolve", () => {
    it("resolves {} to the default snapshot, with a hash that is the SHA-256 of its canonical text", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await resolve(ana.auth, {});

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Configuration resolved successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), ["hash", "profileId", "snapshot"]);
        assert.equal(response.body.data.profileId, null);
        assert.deepEqual(response.body.data.snapshot, { version: 1, settings: DEFAULT_SETTINGS });
        assert.equal(response.body.data.hash, sha256Hex(canonicalText(response.body.data.snapshot)), "computed here, from the snapshot");
        assert.equal(canonicalText(response.body.data.snapshot), DEFAULT_SNAPSHOT_TEXT);
        assert.equal(response.body.data.hash, DEFAULT_SNAPSHOT_HASH);
    });

    it("resolves a request with no body at all the same way", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await request(app).post("/v1/configuration/resolve").set(...ana.auth);

        assert.equal(response.status, 200);
        assert.equal(response.body.data.hash, DEFAULT_SNAPSHOT_HASH);
    });

    it("returns the settings of the profile that was asked for, over the defaults", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 5, \"temperature\": 0.5, \"answerLanguage\": \"es\"}");

        const response = await resolve(ana.auth, { profileId });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.profileId, profileId);
        assert.deepEqual(response.body.data.snapshot.settings, { ...DEFAULT_SETTINGS, topK: 5, temperature: 0.5, answerLanguage: "es" });
        assert.equal(response.body.data.hash, sha256Hex(canonicalText(response.body.data.snapshot)));
    });

    it("puts the overrides over the profile", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 5, \"temperature\": 0.5}");

        const response = await resolve(ana.auth, { profileId, overrides: { topK: 9 } });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.snapshot.settings.topK, 9);
        assert.equal(response.body.data.snapshot.settings.temperature, 0.5);
    });

    it("keeps the profile's id outside the hash: the same settings from a profile and from overrides have one hash", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 5}");

        const fromProfile = await resolve(ana.auth, { profileId });
        const fromOverrides = await resolve(ana.auth, { overrides: { topK: 5 } });

        assert.notEqual(fromProfile.body.data.profileId, fromOverrides.body.data.profileId);
        assert.equal(fromProfile.body.data.hash, fromOverrides.body.data.hash);
    });

    it("returns the cap exactly for overrides at the top and at the bottom of their caps", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const top = { topK: 30, minScore: 1, temperature: 1, maxTokens: 1024, chunkSize: 5000, neighborWindow: 2, answerLanguage: "es", answerMode: "structured" };
        const bottom = { topK: 1, minScore: 0, temperature: 0, maxTokens: 1, chunkSize: 300, neighborWindow: 1 };

        const atTop = await resolve(ana.auth, { overrides: top });
        const atBottom = await resolve(ana.auth, { overrides: bottom });

        assert.equal(atTop.status, 200, JSON.stringify(atTop.body));
        assert.deepEqual(atTop.body.data.snapshot.settings, { ...DEFAULT_SETTINGS, ...top });
        assert.equal(atBottom.status, 200, JSON.stringify(atBottom.body));
        assert.deepEqual(atBottom.body.data.snapshot.settings, { ...DEFAULT_SETTINGS, ...bottom });
    });

    it("answers 400 'Validation error' for overrides over their cap, with details that name the setting", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (const [overrides, label] of [
            [{ topK: 31 }, "Top K"],
            [{ topK: 0 }, "Top K"],
            [{ maxTokens: 1025 }, "Max tokens"],
            [{ minScore: 1.01 }, "Minimum score"],
            [{ temperature: 0.305 }, "Temperature"],
            [{ chunkSize: 999 }, "Chunk size"],
            [{ smallModel: "gpt-oss:20b" }, "Small model"],
            [{ embeddingModel: "../../api/pull" }, "Embedding model"],
            [{ topK: "3" }, "Top K"]
        ] as [object, string][]) {
            const response = await resolve(ana.auth, { overrides });

            assert.equal(response.status, 400, JSON.stringify(overrides));
            assert.equal(response.body.message, "Validation error");
            assert.ok(response.body.details.some((detail: string) => detail.startsWith(label)), `${JSON.stringify(overrides)}: ${JSON.stringify(response.body.details)}`);
        }
    });

    it("answers 400 for an unknown override and for a __proto__ override, and Object.prototype gains nothing", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const unknown = await resolve(ana.auth, { overrides: { foo: 1 } });
        assert.equal(unknown.status, 400);
        assert.equal(unknown.body.message, "Validation error");
        assert.deepEqual(unknown.body.details, ["Unknown setting: foo"]);

        const proto = await resolveRaw(ana.auth, "{\"overrides\": {\"__proto__\": {\"polluted\": true}}}");
        assert.equal(proto.status, 400);
        assert.equal(proto.body.message, "Validation error");
        assert.deepEqual(proto.body.details, ["Unknown setting: __proto__"]);

        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });

    it("answers 400 for a profileId that is not a UUID, and for a field the body does not have", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const malformed = await resolve(ana.auth, { profileId: "not-a-uuid" });
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.message, "Validation error");
        assert.deepEqual(malformed.body.details, ["Profile id must be a valid UUID"]);

        const extra = await resolve(ana.auth, { userId: randomUUID() });
        assert.equal(extra.status, 400);
        assert.deepEqual(extra.body.details, ["\"userId\" is not allowed"]);
    });

    // the same rule as GET /v1/profiles/:id (isUuid): the plain hyphenated form, so the id is never one thing to the
    // validator and another to the lookup
    it("answers 400 'Profile id must be a valid UUID' for the id of an own profile written wrapped in braces, brackets or parentheses, without hyphens, or with colons", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 5}");

        assert.equal((await resolve(ana.auth, { profileId })).status, 200, "the plain form resolves");

        const forms: Record<string, string> = {
            "in braces": `{${profileId}}`,
            "in brackets": `[${profileId}]`,
            "in parentheses": `(${profileId})`,
            "without hyphens": profileId.replaceAll("-", ""),
            "with colons": profileId.replaceAll("-", ":")
        };

        for (const [label, written] of Object.entries(forms)) {
            const response = await resolve(ana.auth, { profileId: written });

            assert.equal(response.status, 400, `${label}: ${written}`);
            assert.equal(response.body.message, "Validation error", label);
            assert.deepEqual(response.body.details, ["Profile id must be a valid UUID"], label);
        }
    });

    it("answers 404 'Profile not found', like GET /v1/profiles/:id, for a valid UUID that is not version 4 and that nobody owns", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const versionOne = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
        const versionSeven = "01890a5d-ac96-774b-bcce-b302099a8057";

        for (const profileId of [versionOne, versionSeven]) {
            const response = await resolve(ana.auth, { profileId });

            assert.equal(response.status, 404, profileId);
            assert.deepEqual(response.body, { message: "Profile not found" }, profileId);
            assert.equal((await request(app).get(`/v1/profiles/${profileId}`).set(...ana.auth)).status, 404, `${profileId} on the profile route`);
        }
    });

    it("resolves an own profile whose id is not version 4, and one written in upper case", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const versionSeven = "01890a5d-ac96-774b-bcce-b302099a8057";
        await seedProfileWithId(versionSeven, ana.id, "{\"topK\": 5}");

        const response = await resolve(ana.auth, { profileId: versionSeven });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.profileId, versionSeven);
        assert.equal(response.body.data.snapshot.settings.topK, 5);

        const upper = await resolve(ana.auth, { profileId: versionSeven.toUpperCase() });
        assert.equal(upper.status, 200, JSON.stringify(upper.body));
        assert.equal(upper.body.data.profileId, versionSeven, "the id comes back in lower case");
    });

    it("answers 404 'Profile not found' for another user's profile and for an id nobody has", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await seedProfile(ana.id, "{\"topK\": 5}");

        for (const profileId of [anas, randomUUID()]) {
            const response = await resolve(bob.auth, { profileId });

            assert.equal(response.status, 404, profileId);
            assert.deepEqual(response.body, { message: "Profile not found" }, profileId);
        }

        assert.equal((await resolve(ana.auth, { profileId: anas })).status, 200, "the owner resolves it");
    });

    it("answers 400 'The configuration is not valid', with details, for a stored profile that is outside the caps", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 31, \"foo\": 1}");

        const response = await resolve(ana.auth, { profileId });

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "The configuration is not valid");
        assert.equal(response.body.details.length, 2, JSON.stringify(response.body.details));
        assert.ok(response.body.details.some((detail: string) => /^Top K/.test(detail)));
        assert.ok(response.body.details.includes("Unknown setting: foo"));
    });

    // The default is the server's own data, checked at startup: a default that breaks while the server runs is the server's
    // fault and not the client's, so the client gets the generic 500 (nothing about the stored data) and the server logs
    // which setting it is.
    it("answers 500 with the generic message and no details, and logs the setting, when the default profile was damaged while the server runs", { timeout: 15_000 }, async (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"temperature\": 0.5}");

        const damages: [label: string, assignment: string][] = [
            ["topK past its cap", "settings = jsonb_set(settings, '{topK}', '31')"],
            ["topK removed", "settings = settings - 'topK'"]
        ];

        for (const [label, assignment] of damages) {
            await ownerPool.query(`UPDATE default_profile SET ${assignment}`);
            consoleError.mock.resetCalls();

            for (const body of [{}, { profileId }]) {
                const response = await resolve(ana.auth, body);

                assert.equal(response.status, 500, `${label}: ${JSON.stringify(body)}`);
                assert.deepEqual(response.body, GENERIC_500, `${label}: no details, no message about the data`);
            }

            assert.match(loggedText(consoleError), /Top K/, `${label}: the server logs which setting`);

            await ownerPool.query("UPDATE default_profile SET settings = $1::jsonb", [JSON.stringify(DEFAULT_SETTINGS)]);
        }

        assert.equal((await resolve(ana.auth, {})).status, 200, "put back, it resolves again");
    });

    it("keeps answering 400 'The configuration is not valid' for a stored profile outside the caps while the default is sound", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 31}");

        const response = await resolve(ana.auth, { profileId });

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "The configuration is not valid");
        assert.ok(Array.isArray(response.body.details) && response.body.details.length === 1);
    });

    // a profile at another version is data this code cannot read: the user did nothing wrong, so it is a 500 and not a 400
    it("answers 500 with the generic message and no details for a profile saved by another configuration version", { timeout: 15_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, "{\"topK\": 5}", "Mine", 1);
        await ownerPool.query("UPDATE profiles SET version = 2 WHERE id = $1", [profileId]);

        for (const body of [{ profileId }, { profileId, overrides: { topK: 7 } }]) {
            const response = await resolve(ana.auth, body);

            assert.equal(response.status, 500, JSON.stringify(body));
            assert.deepEqual(response.body, GENERIC_500, JSON.stringify(body));
        }

        assert.equal((await resolve(ana.auth, {})).status, 200, "without the profile the default still resolves");
    });

    it("answers 404 'Profile not found', and not 500, for another user's profile that is at another configuration version", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await seedProfile(ana.id, "{}", "Mine", 2);

        const response = await resolve(bob.auth, { profileId: anas });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Profile not found" });
    });

    // keys longer than 64 characters are echoed cut: a 16 kB body must not become a 16 kB answer, a log line or a stored detail
    it("echoes an unknown override of 15,000 characters cut to its first 64 followed by an ellipsis, and a key of 64 whole", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const long = await resolve(ana.auth, { overrides: { [LONG_KEY]: 1 } });
        assert.equal(long.status, 400);
        assertDetails(long.body.details, [LONG_KEY_DETAIL]);
        assert.ok(long.body.details[0].length < 100);

        const sixtyFive = await resolve(ana.auth, { overrides: { ["k".repeat(65)]: 1 } });
        assert.deepEqual(sixtyFive.body.details, [`Unknown setting: ${"k".repeat(64)}${ELLIPSIS}`]);

        const sixtyFour = await resolve(ana.auth, { overrides: { ["k".repeat(64)]: 1 } });
        assert.deepEqual(sixtyFour.body.details, [`Unknown setting: ${"k".repeat(64)}`]);
    });

    it("echoes an unknown key of a stored profile cut to 64 characters too", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const profileId = await seedProfile(ana.id, JSON.stringify({ [LONG_KEY]: 1 }));

        const response = await resolve(ana.auth, { profileId });

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "The configuration is not valid");
        assertDetails(response.body.details, [LONG_KEY_DETAIL]);
    });

    it("reports a __proto__ override together with a value past its cap and an unknown key, all three", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await resolveRaw(ana.auth, `{"overrides": ${PROTO_WITH_OTHER_ERRORS}}`);

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "Validation error");
        assert.equal(response.body.details.length, 3, JSON.stringify(response.body.details));
        assert.ok(response.body.details.includes("Unknown setting: __proto__"));
        assert.ok(response.body.details.includes("Unknown setting: foo"));
        assert.ok(response.body.details.some((detail: string) => /^Top K.*at most 30/.test(detail)));
        assert.equal(Object.hasOwn(Object.prototype, "foo"), false);
    });

    it("answers 413 'request entity too large' for a body over 16 kB, and reads one just under it", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const over = await resolve(ana.auth, { overrides: { note: "a".repeat(17_000) } });
        assert.equal(over.status, 413);
        assert.deepEqual(over.body, { message: "request entity too large" });

        const under = await resolve(ana.auth, { overrides: { note: "a".repeat(15_000) } });
        assert.equal(under.status, 400, "the body was read, and the setting is unknown");
        assert.deepEqual(under.body.details, ["Unknown setting: note"]);
    });

    it("answers 400 for malformed JSON", { timeout: 15_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await resolveRaw(ana.auth, "{\"overrides\": ");

        assert.equal(response.status, 400);
        assert.equal(typeof response.body.message, "string");
    });
});
