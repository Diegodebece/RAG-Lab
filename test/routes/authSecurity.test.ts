import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Abuse and edge cases of the two routes that take an email and a password: login (public) and the creation of an
// account (an admin's). The limits are raised so they do not interfere; the limits themselves are covered by
// authRateLimit.test.ts, addressLimit.test.ts and users.test.ts.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

const password = "correct horse battery staple";

// special characters built from code points, so this file stays plain ASCII
const char = (codePoint: number) => String.fromCodePoint(codePoint);

let adminAuth: [string, string] = ["Authorization", ""];

const createAccount = (body: object) => request(app).post("/v1/users").set(...adminAuth).send(body);

const login = (body: object) => request(app).post("/v1/auth/login").send(body);

// everything but the admin that makes the requests
const countAccounts = async (): Promise<number> =>
    (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM users WHERE email <> 'admin@example.com'")).rows[0].count;

before(resetTestDatabase);

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    adminAuth = (await createTestUser({ email: "admin@example.com", role: "admin" })).auth;
});

after(closeTestPools);

// the same abuse, against each route that reads an email and a password
const routes: [string, (body: object) => ReturnType<typeof login>][] = [
    ["login", login],
    ["account creation", createAccount]
];

for (const [name, send] of routes) {
    const sendRaw = (text: string) => {
        const base = name === "login" ? request(app).post("/v1/auth/login") : request(app).post("/v1/users").set(...adminAuth);
        return base.set("Content-Type", "application/json").send(text);
    };

    describe(`input abuse on ${name}`, () => {
        it("rejects an email with a null byte with a 400, not a database error", { timeout: 15_000 }, async () => {
            const response = await send({ email: `a${char(0)}b@example.com`, password });

            assert.equal(response.status, 400);
        });

        it("rejects a 90,000-character email quickly", { timeout: 15_000 }, async () => {
            const started = Date.now();
            const response = await send({ email: `${"a".repeat(90_000)}@example.com`, password });

            assert.equal(response.status, 400);
            assert.ok(Date.now() - started < 1000, "it did not hash, query or work on the email before refusing it");
        });

        it("answers a body over the size limit with 413 and the usual error shape", { timeout: 15_000 }, async () => {
            const response = await send({ email: "big@example.com", password, filler: "x".repeat(200_000) });

            assert.equal(response.status, 413);
            assert.deepEqual(Object.keys(response.body), ["message"]);
        });

        it("rejects bodies that are not a JSON object", { timeout: 15_000 }, async () => {
            for (const body of ["\"just a string\"", "[1,2]", "null", "42"]) {
                const response = await sendRaw(body);

                assert.equal(response.status, 400, body);
            }
        });

        it("rejects arrays and objects where a string is expected", { timeout: 15_000 }, async () => {
            for (const [label, body] of [
                ["array email", { email: ["a@example.com", "b@example.com"], password }],
                ["object email", { email: { $gt: "" }, password }],
                ["array password", { email: "a@example.com", password: [password] }],
                ["object password", { email: "a@example.com", password: { $ne: "" } }]
            ] as const) {
                const response = await send(body);

                assert.equal(response.status, 400, label);
                assert.match(response.body.details.join(" "), /must be a string/, label);
            }
        });

        it("ignores form-encoded bodies: the API reads only JSON", { timeout: 15_000 }, async () => {
            const base = name === "login" ? request(app).post("/v1/auth/login") : request(app).post("/v1/users").set(...adminAuth);
            const response = await base
                .type("form")
                .send(`email[]=a@example.com&email[]=b@example.com&password=${encodeURIComponent(password)}`);

            assert.equal(response.status, 400);
            assert.equal(response.body.message, "Validation error");
            assert.equal(response.body.details.length, 2, "both fields are reported as missing");
            assert.match(response.body.details.join(" "), /email/i);
            assert.match(response.body.details.join(" "), /password/i);
        });

        it("ignores a __proto__ key, so the body cannot make anyone an admin", { timeout: 15_000 }, async () => {
            const response = await sendRaw(`{"email":"proto@example.com","password":"${password}","__proto__":{"role":"admin"}}`);

            // an answer that came from the route: the account is created, the login fails as for any unknown
            // email, or the extra key is refused as an unknown field. Never an error, and never an admin.
            const answered = name === "login"
                ? (response.status === 401 && response.body.message === "Invalid email or password") || response.status === 400
                : response.status === 201 || response.status === 400;
            assert.ok(answered, `${response.status} ${JSON.stringify(response.body)}`);
            assert.notEqual(response.body.data?.role, "admin");

            const { rows } = await ownerPool.query("SELECT role FROM users WHERE email = 'proto@example.com'");
            assert.ok(rows.every((row) => row.role === "user"));
        });
    });
}

describe("two accounts created at the same time", () => {
    it("creates one account when the same email is created twice at the same time", { timeout: 20_000 }, async () => {
        const responses = await Promise.all([1, 2].map(() => createAccount({ email: "race@example.com", password })));

        assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
        assert.equal(await countAccounts(), 1);
    });
});

describe("Unicode normalization", () => {
    // "jose" with an accented e: one precomposed character (NFC) or "e" plus a combining accent (NFD)
    const precomposed = `jos${char(0xe9)}@example.com`;
    const decomposed = `jose${char(0x301)}@example.com`;

    it("treats both spellings of an accented email as the same account", { timeout: 20_000 }, async () => {
        assert.equal((await createAccount({ email: precomposed, password })).status, 201);

        const second = await createAccount({ email: decomposed, password });

        assert.equal(second.status, 409);
        assert.equal(await countAccounts(), 1);
    });

    it("stores the email in form NFC whichever way it was typed", { timeout: 20_000 }, async () => {
        const created = await createAccount({ email: decomposed, password });

        assert.equal(created.status, 201);
        assert.equal(created.body.data.email, precomposed);
        const { rows } = await ownerPool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [created.body.data.id]);
        assert.equal(rows[0].email, precomposed);
    });

    it("logs in with the other spelling of the same email", { timeout: 20_000 }, async () => {
        await createAccount({ email: precomposed, password });

        const response = await login({ email: decomposed, password });

        assert.equal(response.status, 200);
    });

    it("accepts a password typed with a different Unicode form of the same accents", { timeout: 20_000 }, async () => {
        const typedOnWindows = `caf${char(0xe9)} con le${char(0xf1)}a 2026`;
        const typedOnMac = `cafe${char(0x301)} con len${char(0x303)}a 2026`;
        await createAccount({ email: "accents@example.com", password: typedOnWindows });

        const response = await login({ email: "accents@example.com", password: typedOnMac });

        assert.equal(response.status, 200);
    });

    it("accepts a compatibility form of the password (NFKC), such as a ligature", { timeout: 20_000 }, async () => {
        await createAccount({ email: "ligature@example.com", password: `${char(0xfb01)}rst password 2026` });

        const response = await login({ email: "ligature@example.com", password: "first password 2026" });

        assert.equal(response.status, 200);
    });

    it("still refuses a password that only looks alike", { timeout: 20_000 }, async () => {
        const created = await createAccount({ email: "alike@example.com", password: `caf${char(0xe9)} con le${char(0xf1)}a 2026` });
        assert.equal(created.status, 201);

        const response = await login({ email: "alike@example.com", password: "cafe con lena 2026" });

        assert.equal(response.status, 401);
    });
});
