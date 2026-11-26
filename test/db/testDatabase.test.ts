import { after, afterEach, beforeEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { closeTestPools, ownerPool } from "./testDatabase.js";

const execFileAsync = promisify(execFile);

// The test helpers have their own guard, and a guard nobody tests is a guard that can silently stop working: a
// mistake in a URL must stop the reset before it touches a database. Each case runs the helper in a child process
// with the URLs the test chooses.
const ROOT = path.join(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "resetDatabase.ts");

let emptyEnvDirectory = "";
let emptyEnvFile = "";

before(async () => {
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-reset-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");
});

after(async () => {
    await closeTestPools();
    await rm(emptyEnvDirectory, { recursive: true, force: true });
});

// a table in the real test database: if a reset reaches it, the table is gone
beforeEach(() => ownerPool.query("CREATE TABLE IF NOT EXISTS reset_guard_probe (id integer)"));

afterEach(() => ownerPool.query("DROP TABLE IF EXISTS reset_guard_probe"));

const urlWithDatabase = (url: string | undefined, database: string): string => {
    assert.ok(url, "the database tests need RAG_LAB_TEST_API_DATABASE_URL and RAG_LAB_TEST_DATABASE_URL");
    const changed = new URL(url);
    changed.pathname = `/${database}`;
    return changed.toString();
};

const probeSurvives = async (): Promise<boolean> => {
    const { rows } = await ownerPool.query<{ found: string | null }>("SELECT to_regclass('public.reset_guard_probe') AS found");
    return rows[0].found !== null;
};

interface ResetOutcome {
    outcome: "reset" | "refused";
    message?: string;
}

const tryToReset = async (urls: { DATABASE_URL: string; MIGRATION_DATABASE_URL: string }): Promise<ResetOutcome> => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", FIXTURE], {
        cwd: ROOT,
        env: cleanChildEnvironment({ DOTENV_CONFIG_PATH: emptyEnvFile, DOTENV_CONFIG_QUIET: "true", ...urls }),
        timeout: 25_000
    });

    return JSON.parse(stdout.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "{}") as ResetOutcome;
};

describe("emptyTestDatabase", () => {
    // Both names are databases that do not exist, so even a guard that is missing cannot empty anything real: the
    // reset would fail to connect, and the test would see a different message than the refusal it expects.
    it("refuses to reset when DATABASE_URL and MIGRATION_DATABASE_URL name different databases", { timeout: 30_000 }, async () => {
        const result = await tryToReset({
            DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_API_DATABASE_URL, "rag_lab_guard_a_test"),
            MIGRATION_DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_DATABASE_URL, "rag_lab_guard_b_test")
        });

        assert.equal(result.outcome, "refused");
        assert.match(result.message ?? "", /Refusing to reset/);
        assert.match(result.message ?? "", /same database/);
    });

    it("refuses to reset when the real test database is the app's and another one is the owner's", { timeout: 30_000 }, async () => {
        const result = await tryToReset({
            DATABASE_URL: process.env.RAG_LAB_TEST_API_DATABASE_URL ?? "",
            MIGRATION_DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_DATABASE_URL, "rag_lab_guard_b_test")
        });

        assert.equal(result.outcome, "refused");
        assert.match(result.message ?? "", /Refusing to reset/);
        assert.equal(await probeSurvives(), true, "the real test database was not emptied");
    });

    it("refuses to reset a migration database whose name does not end in _test", { timeout: 30_000 }, async () => {
        const result = await tryToReset({
            DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_API_DATABASE_URL, "rag_lab_guard_not_a_test_database"),
            MIGRATION_DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_DATABASE_URL, "rag_lab_guard_not_a_test_database")
        });

        assert.equal(result.outcome, "refused");
        assert.match(result.message ?? "", /Refusing to reset/);
        assert.match(result.message ?? "", /_test/);
    });

    it("never puts a password in the message that refuses a reset", { timeout: 30_000 }, async () => {
        const ownerPassword = new URL(process.env.RAG_LAB_TEST_DATABASE_URL ?? "").password;
        assert.ok(ownerPassword, "the owner's test URL has a password in it");

        const result = await tryToReset({
            DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_API_DATABASE_URL, "rag_lab_guard_a_test"),
            MIGRATION_DATABASE_URL: urlWithDatabase(process.env.RAG_LAB_TEST_DATABASE_URL, "rag_lab_guard_b_test")
        });

        assert.equal(result.outcome, "refused");
        assert.ok(!(result.message ?? "").includes(ownerPassword));
    });

    // the control: the same child process, with the two real URLs, empties the schema, so the refusals above
    // are the guard's and not a broken fixture
    it("empties the schema when both URLs name the same test database", { timeout: 30_000 }, async () => {
        const result = await tryToReset({
            DATABASE_URL: process.env.RAG_LAB_TEST_API_DATABASE_URL ?? "",
            MIGRATION_DATABASE_URL: process.env.RAG_LAB_TEST_DATABASE_URL ?? ""
        });

        assert.deepEqual(result, { outcome: "reset" });
        assert.equal(await probeSurvives(), false, "the probe table was dropped with the schema");
    });
});
