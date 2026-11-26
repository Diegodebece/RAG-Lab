import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";

// Many logins from one address: the limits are raised by relaxedLimits.js, before the app is imported.
// authRateLimit.test.ts checks them with low values.
const SECRET = "test-secret-only-for-these-tests-0123456789";
process.env.SECRET_KEY = SECRET;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./testUsers.js");

const PASSWORD = "correct horse battery staple";
const EMAIL = "ana@example.com";

// one real scrypt hash for every seeded user of this file (each costs about 400 ms to make)
let currentHash = "";

const login = (body: object = { email: EMAIL, password: PASSWORD }) => request(app).post("/v1/auth/login").send(body);

const seed = (overrides: { email?: string; role?: "user" | "admin"; status?: "active" | "disabled"; passwordHash?: string } = {}) =>
    createTestUser({ email: EMAIL, passwordHash: currentHash, ...overrides });

const storedHash = async (): Promise<string> => (await ownerPool.query<{ hash: string }>("SELECT password_hash AS hash FROM users")).rows[0].hash;

const tokenVersionOf = async (id: string): Promise<number> =>
    (await ownerPool.query<{ version: number }>("SELECT token_version AS version FROM users WHERE id = $1", [id])).rows[0].version;

before(async () => {
    await resetTestDatabase();
    currentHash = await makePasswordHash(PASSWORD);
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

describe("POST /v1/auth/login", () => {
    it("returns the user and a token for the right password", { timeout: 15_000 }, async () => {
        const user = await seed({ role: "admin" });

        const response = await login();

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Logged in successfully");
        assert.deepEqual(Object.keys(response.body.data).sort(), ["createdAt", "email", "id", "role", "status"]);
        assert.equal(response.body.data.id, user.id);
        assert.equal(response.body.data.email, EMAIL);
        assert.equal(response.body.data.role, "admin");
        assert.equal(response.body.data.status, "active");
        assert.equal(typeof response.body.token, "string");
    });

    it("logs in with any capitalization and spacing of the email", { timeout: 30_000 }, async () => {
        const user = await seed();

        for (const email of ["ANA@EXAMPLE.COM", "  ana@example.com  ", "Ana@Example.Com", "\tana@example.com\n"]) {
            const response = await login({ email, password: PASSWORD });

            assert.equal(response.status, 200, JSON.stringify(email));
            assert.equal(response.body.data.id, user.id, JSON.stringify(email));
        }
    });

    it("gives a token that works on the protected routes", { timeout: 15_000 }, async () => {
        const user = await seed();

        const { body } = await login();
        const me = await request(app).get("/v1/users/me").set("Authorization", `Bearer ${body.token}`);

        assert.equal(me.status, 200);
        assert.equal(me.body.data.id, user.id);
    });

    it("signs the token with the claims of the design: sub, ver, iss, aud, iat and exp, and no role", { timeout: 15_000 }, async () => {
        const user = await seed({ role: "admin" });

        const { body } = await login();

        // verified with the issuer and the audience written out here, and only HS256
        const claims = jwt.verify(body.token, SECRET, { algorithms: ["HS256"], issuer: "rag-lab", audience: "rag-lab-api" }) as jwt.JwtPayload;
        assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "sub", "ver"]);
        assert.equal(claims.sub, user.id);
        assert.equal(claims.ver, 0);
        assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 3600);
    });

    it("puts the account's current token version in the token", { timeout: 15_000 }, async () => {
        const user = await seed();
        await ownerPool.query("UPDATE users SET token_version = 5 WHERE id = $1", [user.id]);

        const { body } = await login();

        assert.equal((jwt.decode(body.token) as jwt.JwtPayload).ver, 5);
        assert.equal((await request(app).get("/v1/users/me").set("Authorization", `Bearer ${body.token}`)).status, 200);
    });

    it("answers a wrong password and an unknown email with the same 401 and the same body", { timeout: 15_000 }, async () => {
        await seed();

        const wrongPassword = await login({ email: EMAIL, password: "wrong password" });
        const unknownEmail = await login({ email: "nobody@example.com", password: PASSWORD });

        assert.equal(wrongPassword.status, 401);
        assert.equal(unknownEmail.status, 401);
        assert.deepEqual(wrongPassword.body, { message: "Invalid email or password" });
        assert.deepEqual(unknownEmail.body, wrongPassword.body);
        assert.equal(unknownEmail.text, wrongPassword.text, "byte for byte");
    });

    // Without a hash to check, an unknown email would answer in a few milliseconds and a known one in several
    // hundred: the difference tells anyone which emails have an account. The route checks a dummy hash instead.
    it("takes about as long for an unknown email as for a wrong password (it checks a dummy hash)", { timeout: 30_000 }, async () => {
        await seed();

        const timeOf = async (body: object): Promise<number> => {
            const started = performance.now();
            await login(body);
            return performance.now() - started;
        };
        const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

        const wrong: number[] = [];
        const unknown: number[] = [];

        for (let round = 0; round < 3; round++) {
            wrong.push(await timeOf({ email: EMAIL, password: "wrong password" }));
            unknown.push(await timeOf({ email: `nobody${round}@example.com`, password: "wrong password" }));
        }

        // the measurement means something only if a wrong password costs a real hash
        assert.ok(median(wrong) > 50, `a wrong password took ${median(wrong).toFixed(0)} ms: no hash was checked`);
        assert.ok(median(unknown) >= median(wrong) / 2, `an unknown email took ${median(unknown).toFixed(0)} ms against ${median(wrong).toFixed(0)} ms for a wrong password`);
    });

    it("answers 403 for a disabled account with the right password, and the usual 401 with a wrong one", { timeout: 15_000 }, async () => {
        await seed({ status: "disabled" });

        const right = await login();
        assert.equal(right.status, 403);
        assert.deepEqual(right.body, { message: "This account is disabled" });
        assert.equal("token" in right.body, false, "no token for a disabled account");

        const wrong = await login({ email: EMAIL, password: "wrong password" });
        assert.equal(wrong.status, 401, "a wrong password does not reveal that the account exists or is disabled");
        assert.deepEqual(wrong.body, { message: "Invalid email or password" });
    });

    it("moves a password hashed with the earlier cost parameters to the current ones, on success only", { timeout: 30_000 }, async () => {
        const oldHash = await makePasswordHash(PASSWORD, { N: 16384, r: 8, p: 1 });
        await seed({ passwordHash: oldHash });

        assert.equal((await login({ email: EMAIL, password: "wrong password" })).status, 401);
        assert.equal(await storedHash(), oldHash, "a failed login changes nothing");

        assert.equal((await login()).status, 200);
        assert.match(await storedHash(), /^scrypt\$16384\$8\$5\$/);
        assert.notEqual(await storedHash(), oldHash);
        assert.equal((await login()).status, 200, "the new hash accepts the same password");
    });

    it("leaves a hash that already has the current parameters as it is", { timeout: 15_000 }, async () => {
        await seed();

        assert.equal((await login()).status, 200);

        assert.equal(await storedHash(), currentHash);
    });

    it("never returns the password hash or the token version", { timeout: 15_000 }, async () => {
        await seed();

        const response = await login();

        assert.equal(response.status, 200);
        for (const field of ["passwordHash", "password_hash", "tokenVersion", "token_version"]) {
            assert.equal(field in response.body.data, false, field);
        }
        assert.ok(!response.text.includes("scrypt$"), "the hash is nowhere in the response");
    });

    it("answers 401, not 500, for an account whose stored hash is not usable", { timeout: 15_000 }, async () => {
        await seed({ passwordHash: "not-a-usable-hash" });
        const notAHash = await login();
        assert.equal(notAHash.status, 401, "text that is not a hash");
        assert.deepEqual(notAHash.body, { message: "Invalid email or password" });

        await ownerPool.query("UPDATE users SET password_hash = $1", [["scrypt", 3, 8, 1, "ab".repeat(16), "cd".repeat(64)].join("$")]);
        const badCost = await login();
        assert.equal(badCost.status, 401, "cost parameters scrypt cannot use");
        assert.deepEqual(badCost.body, { message: "Invalid email or password" });
    });

    it("answers 500 and issues no token when SECRET_KEY is missing", { timeout: 15_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        await seed();
        delete process.env.SECRET_KEY;

        try {
            const response = await login();

            assert.equal(response.status, 500);
            assert.deepEqual(response.body, { message: "Internal server error" });
            assert.equal("token" in response.body, false);
        } finally {
            process.env.SECRET_KEY = SECRET;
        }
    });

    it("rejects a body that does not follow the schema with a 400 and the problems listed", { timeout: 15_000 }, async () => {
        for (const body of [{}, { email: EMAIL }, { password: PASSWORD }, { email: "not-an-email", password: PASSWORD }, { email: EMAIL, password: PASSWORD, role: "admin" }]) {
            const response = await login(body);

            assert.equal(response.status, 400, JSON.stringify(body));
            assert.equal(response.body.message, "Validation error", JSON.stringify(body));
            assert.ok(Array.isArray(response.body.details) && response.body.details.length > 0, JSON.stringify(body));
        }
    });
});

describe("POST /v1/auth/logout", () => {
    const logout = (token: string) => request(app).post("/v1/auth/logout").set("Authorization", `Bearer ${token}`);

    it("answers 200 with the usual body, and no data", { timeout: 15_000 }, async () => {
        const user = await seed();

        const response = await logout(user.token);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { success: true, message: "Logged out successfully" });
    });

    it("ends the session: the token gets a 401 afterwards", { timeout: 15_000 }, async () => {
        const user = await seed();
        assert.equal((await request(app).get("/v1/users/me").set(...user.auth)).status, 200);

        await logout(user.token);

        const afterwards = await request(app).get("/v1/users/me").set(...user.auth);
        assert.equal(afterwards.status, 401);
        assert.deepEqual(afterwards.body, { message: "Invalid or expired authentication token" });
    });

    it("ends every session of the account: tokens from two logins both stop", { timeout: 30_000 }, async () => {
        await seed();
        const first = (await login()).body.token as string;
        const second = (await login()).body.token as string;
        assert.equal((await request(app).get("/v1/users/me").set("Authorization", `Bearer ${second}`)).status, 200);

        assert.equal((await logout(first)).status, 200);

        assert.equal((await request(app).get("/v1/users/me").set("Authorization", `Bearer ${first}`)).status, 401);
        assert.equal((await request(app).get("/v1/users/me").set("Authorization", `Bearer ${second}`)).status, 401, "the other session was cut off too");
    });

    it("raises the token version by one, and a new login after it works with a token of the new version", { timeout: 30_000 }, async () => {
        const user = await seed();

        await logout(user.token);
        assert.equal(await tokenVersionOf(user.id), 1);

        const again = await login();
        assert.equal(again.status, 200);
        assert.equal((jwt.decode(again.body.token) as jwt.JwtPayload).ver, 1);
        assert.equal((await request(app).get("/v1/users/me").set("Authorization", `Bearer ${again.body.token}`)).status, 200);
    });

    it("requires a token", { timeout: 15_000 }, async () => {
        const user = await seed();

        const response = await request(app).post("/v1/auth/logout");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
        assert.equal(await tokenVersionOf(user.id), 0, "nothing was changed");
    });

    it("cannot be done again with a revoked token, and does not raise the version a second time", { timeout: 15_000 }, async () => {
        const user = await seed();
        await logout(user.token);

        const again = await logout(user.token);

        assert.equal(again.status, 401);
        assert.equal(await tokenVersionOf(user.id), 1);
    });

    it("leaves the sessions of other accounts alone", { timeout: 15_000 }, async () => {
        const ana = await seed();
        const bob = await seed({ email: "bob@example.com" });

        await logout(ana.token);

        assert.equal((await request(app).get("/v1/users/me").set(...bob.auth)).status, 200);
        assert.equal(await tokenVersionOf(bob.id), 0);
    });
});
