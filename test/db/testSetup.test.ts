import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.join(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "printDatabaseUrl.ts");

let emptyEnvDirectory = "";
let emptyEnvFile = "";

before(async () => {
    // an empty .env, so the child process does not read the real one
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-setup-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");
});

after(() => rm(emptyEnvDirectory, { recursive: true, force: true }));

// Runs node with the same --import chain as `npm test`, in a clean environment, and returns the last line it printed.
const runAfterSetup = async (extraEnv: Record<string, string>, args: string[]): Promise<string> => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.RAG_LAB_TEST_DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    delete env.DATABASE_URL;
    delete env.OLLAMA_BASE_URL;
    Object.assign(env, { DOTENV_CONFIG_PATH: emptyEnvFile, DOTENV_CONFIG_QUIET: "true" }, extraEnv);

    const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--import", "./test/setup.ts", ...args],
        { cwd: ROOT, env, timeout: 30_000 }
    );

    return stdout.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";
};

describe("test setup: database", () => {
    it("points the app's pool at the test database", { timeout: 15_000 }, async () => {
        const testDatabaseUrl = process.env.RAG_LAB_TEST_DATABASE_URL;
        assert.ok(testDatabaseUrl, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");

        const { pool } = await import("../../src/v1/config/db.config.js");

        try {
            const { rows } = await pool.query<{ name: string }>("SELECT current_database() AS name");

            assert.ok(rows[0].name.endsWith("_test"), `connected to "${rows[0].name}"`);
            assert.equal(rows[0].name, decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1)));
        } finally {
            await pool.end();
        }
    });

    it("removes DATABASE_URL when no test database is configured", { timeout: 30_000 }, async () => {
        const printed = await runAfterSetup({ DATABASE_URL: "postgres://dev:dev@127.0.0.1:5433/rag_lab" }, [FIXTURE]);

        assert.equal(printed, "unset");
    });

    it("copies RAG_LAB_TEST_DATABASE_URL over a DATABASE_URL that points elsewhere", { timeout: 30_000 }, async () => {
        const testUrl = "postgres://tester:secret@127.0.0.1:5433/some_test";

        const printed = await runAfterSetup({
            DATABASE_URL: "postgres://dev:dev@127.0.0.1:5433/rag_lab",
            RAG_LAB_TEST_DATABASE_URL: testUrl
        }, [FIXTURE]);

        assert.equal(printed, testUrl);
    });

    it("does not read TEST_DATABASE_URL, which belongs to other projects", { timeout: 30_000 }, async () => {
        const printed = await runAfterSetup({
            DATABASE_URL: "postgres://dev:dev@127.0.0.1:5433/rag_lab",
            TEST_DATABASE_URL: "postgres://other:other@127.0.0.1:5432/other_test"
        }, [FIXTURE]);

        assert.equal(printed, "unset");
    });
});

describe("test setup: model server", () => {
    it("cannot reach a real Ollama unless a test starts the fake", { timeout: 15_000 }, async () => {
        const { listInstalledModelsService } = await import("../../src/v1/services/ollama.service.js");
        const { ModelUnavailableError } = await import("../../src/v1/utils/modelUnavailableError.util.js");

        await assert.rejects(
            listInstalledModelsService({ timeoutMs: 3000 }),
            (error: unknown) => error instanceof ModelUnavailableError
        );
    });

    it("replaces an OLLAMA_BASE_URL that points at a real server with a closed port", { timeout: 30_000 }, async () => {
        const printed = await runAfterSetup(
            { OLLAMA_BASE_URL: "http://localhost:11434" },
            ["--print", "process.env.OLLAMA_BASE_URL"]
        );

        assert.equal(printed, "http://127.0.0.1:1");
    });
});
