import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { OPERATIONAL_DEFAULTS } from "../operationalSettings.js";

const execFileAsync = promisify(execFile);

const ROOT = path.join(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "printDatabaseUrl.ts");
const SETTINGS_FIXTURE = path.join(import.meta.dirname, "fixtures", "printSettings.ts");
const PROXIES_FIXTURE = path.join(import.meta.dirname, "fixtures", "printTrustedProxies.ts");

let emptyEnvDirectory = "";
let emptyEnvFile = "";
let developerEnvFile = "";

// What a developer's own .env might hold: values that change how the app runs, none of them the test defaults.
const DEVELOPER_SETTINGS: Record<string, string> = {
    HOST: "0.0.0.0",
    PORT: "8080",
    TRUSTED_PROXIES: "10.0.0.0/8",
    CORS_ORIGINS: "https://app.example.com",
    HEALTH_CACHE_SECONDS: "99",
    HEALTH_CHECKS_PER_MINUTE: "1",
    AUTHENTICATED_REQUESTS_PER_MINUTE: "2",
    TOKEN_LIFETIME_SECONDS: "5",
    OLLAMA_BASE_URL: "http://localhost:11434"
};

// the values every test run starts from, written out here on purpose: they are the app's own defaults
const TEST_DEFAULTS: Record<string, string> = {
    HOST: "127.0.0.1",
    PORT: "3000",
    TRUSTED_PROXIES: "loopback",
    CORS_ORIGINS: "",
    HEALTH_CACHE_SECONDS: "10",
    HEALTH_CHECKS_PER_MINUTE: "30",
    AUTHENTICATED_REQUESTS_PER_MINUTE: "120",
    TOKEN_LIFETIME_SECONDS: "3600",
    OLLAMA_BASE_URL: "http://127.0.0.1:1"
};

before(async () => {
    // an empty .env, so the child process does not read the real one
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-setup-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");

    developerEnvFile = path.join(emptyEnvDirectory, "developer.env");
    await writeFile(developerEnvFile, Object.entries(DEVELOPER_SETTINGS).map(([name, value]) => `${name}=${value}`).join("\n"));
});

after(() => rm(emptyEnvDirectory, { recursive: true, force: true }));

// Runs node with the same --import chain as `npm test`, in a clean environment, and returns the last line it printed.
const runAfterSetup = async (extraEnv: Record<string, string>, args: string[]): Promise<string> => {
    const env = cleanChildEnvironment();
    delete env.RAG_LAB_TEST_DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    delete env.DATABASE_URL;

    // Like a developer's shell, which does not define these: only the test's own extraEnv or the .env file does,
    // and test/setup.ts must replace what they hold.
    for (const name of Object.keys(OPERATIONAL_DEFAULTS)) {
        delete env[name];
    }

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

// A test must give the same result on every computer: the developer's .env or shell must not change it.
describe("test setup: operational settings", () => {
    const settingsAfterSetup = async (extraEnv: Record<string, string>): Promise<Record<string, string | null>> =>
        JSON.parse(await runAfterSetup(extraEnv, [SETTINGS_FIXTURE])) as Record<string, string | null>;

    it("sets every operational setting to its default when the developer's .env changes them", { timeout: 30_000 }, async () => {
        assert.deepEqual(await settingsAfterSetup({ DOTENV_CONFIG_PATH: developerEnvFile }), TEST_DEFAULTS);
    });

    it("sets every operational setting to its default when the shell changes them", { timeout: 30_000 }, async () => {
        assert.deepEqual(await settingsAfterSetup(DEVELOPER_SETTINGS), TEST_DEFAULTS);
    });

    it("keeps a TRUSTED_PROXIES value from the environment out of the app under test", { timeout: 30_000 }, async () => {
        const databaseUrl = "postgres://tester:secret@127.0.0.1:1/some_test";

        // from the shell
        assert.deepEqual(
            JSON.parse(await runAfterSetup({ TRUSTED_PROXIES: "10.0.0.0/8", RAG_LAB_TEST_DATABASE_URL: databaseUrl }, [PROXIES_FIXTURE])),
            ["loopback"],
            "shell"
        );

        // from the developer's .env, which the app loads itself when the setup left the variable alone
        assert.deepEqual(
            JSON.parse(await runAfterSetup({ DOTENV_CONFIG_PATH: developerEnvFile, RAG_LAB_TEST_DATABASE_URL: databaseUrl }, [PROXIES_FIXTURE])),
            ["loopback"],
            ".env"
        );
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
