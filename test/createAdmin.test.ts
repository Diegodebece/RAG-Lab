import "./routes/relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { cleanChildEnvironment } from "./childEnvironment.js";

const execFileAsync = promisify(execFile);

// These tests run the real src/createAdmin.ts in a child process, as `npm run create-admin -- <email>` does: the
// owner runs it once to get the first admin, since there is no self-registration. It connects with DATABASE_URL,
// the API role's, like the server, and needs nothing the API role does not have.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const { app } = await import("../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("./db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("./routes/testUsers.js");

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "src", "createAdmin.ts");

let emptyEnvDirectory = "";
let emptyEnvFile = "";

before(async () => {
    // an empty .env, so the child process does not read the real one
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-admin-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");

    await resetTestDatabase();
});

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(async () => {
    await closeTestPools();
    await rm(emptyEnvDirectory, { recursive: true, force: true });
});

interface Outcome {
    code: number;
    stdout: string;
    stderr: string;
}

// Runs the script with the arguments given. The migration URL is removed from its environment: the script is the
// API's, and must not need the owner's connection.
const createAdmin = async (...args: string[]): Promise<Outcome> => {
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
            cwd: ROOT,
            env: cleanChildEnvironment({
                DOTENV_CONFIG_PATH: emptyEnvFile,
                DOTENV_CONFIG_QUIET: "true",
                MIGRATION_DATABASE_URL: undefined
            }),
            timeout: 30_000
        });

        return { code: 0, stdout, stderr };
    } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
        assert.ok(!failure.killed, "the script ended by itself instead of hanging");

        return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
};

// The password the script printed: the only word of exactly 24 characters in what it wrote.
const printedPassword = (outcome: Outcome): string => {
    const words = outcome.stdout.split(/\s+/).filter((word) => word.length === 24);

    assert.equal(words.length, 1, `exactly one word of 24 characters in the output: ${JSON.stringify(words)}`);
    return words[0];
};

const accounts = async () => (await ownerPool.query<{ email: string; role: string; status: string; token_version: number; password_hash: string }>(
    "SELECT email, role, status, token_version, password_hash FROM users ORDER BY email"
)).rows;

describe("create-admin", () => {
    it("creates an admin whose printed password logs in as an admin", { timeout: 60_000 }, async () => {
        const outcome = await createAdmin("first.admin@example.com");

        assert.equal(outcome.code, 0, outcome.stderr);
        const password = printedPassword(outcome);
        assert.equal(password.length, 24);

        const rows = await accounts();
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0].email, rows[0].role, rows[0].status, rows[0].token_version], ["first.admin@example.com", "admin", "active", 0]);
        assert.match(rows[0].password_hash, /^scrypt\$16384\$8\$5\$/);

        const login = await request(app).post("/v1/auth/login").send({ email: "first.admin@example.com", password });
        assert.equal(login.status, 200);
        assert.equal(login.body.data.role, "admin");
    });

    it("prints the password once and never the hash", { timeout: 60_000 }, async () => {
        const outcome = await createAdmin("quiet.admin@example.com");

        assert.equal(outcome.code, 0, outcome.stderr);
        const password = printedPassword(outcome);
        const everything = `${outcome.stdout}\n${outcome.stderr}`;

        assert.equal(everything.split(password).length - 1, 1, "the password appears once in all the output");
        assert.ok(!everything.includes("scrypt$"), "the hash format is not printed");
        assert.ok(!everything.includes((await accounts())[0].password_hash), "the stored hash is not printed");
    });

    it("generates a different password every time", { timeout: 90_000 }, async () => {
        const first = printedPassword(await createAdmin("one@example.com"));
        const second = printedPassword(await createAdmin("two@example.com"));

        assert.notEqual(first, second);
    });

    it("stores the email trimmed and lowercased, as every account's email is", { timeout: 60_000 }, async () => {
        const outcome = await createAdmin("  Root.Admin@Example.COM ");

        assert.equal(outcome.code, 0, outcome.stderr);
        assert.deepEqual((await accounts()).map((row) => row.email), ["root.admin@example.com"]);
    });

    it("refuses an email that already has an account, in any capitalization, and changes nothing", { timeout: 60_000 }, async () => {
        const hash = await makePasswordHash("the original password");
        await createTestUser({ email: "taken@example.com", role: "user", passwordHash: hash });
        const before = await accounts();

        const outcome = await createAdmin("TAKEN@Example.com");

        assert.notEqual(outcome.code, 0);
        assert.match(`${outcome.stdout}${outcome.stderr}`, /already|taken|exists|registered/i, "it says why");
        assert.deepEqual(await accounts(), before, "the existing account is as it was: still a user, with its own password");
        assert.equal(outcome.stdout.split(/\s+/).filter((word) => word.length === 24).length, 0, "no password was printed");
    });

    it("refuses an invalid email and creates nothing", { timeout: 60_000 }, async () => {
        for (const email of ["not-an-email", "a@b", "@example.com", `${"a".repeat(250)}@example.com`, "two words@example.com"]) {
            const outcome = await createAdmin(email);

            assert.notEqual(outcome.code, 0, email);
            assert.match(`${outcome.stdout}${outcome.stderr}`, /email/i, `${email}: it says what is wrong`);
        }

        assert.deepEqual(await accounts(), []);
    });

    it("refuses to run without an email, and says how to use it", { timeout: 30_000 }, async () => {
        const outcome = await createAdmin();

        assert.notEqual(outcome.code, 0);
        assert.match(`${outcome.stdout}${outcome.stderr}`, /email/i);
        assert.deepEqual(await accounts(), []);
    });
});
