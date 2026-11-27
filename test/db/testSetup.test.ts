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
    REQUESTS_PER_ADDRESS_PER_MINUTE: "7",
    LOGINS_PER_15_MINUTES: "1",
    FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES: "1",
    PASSWORD_CHANGES_PER_15_MINUTES: "1",
    USER_CREATIONS_PER_HOUR: "1",
    MAX_PROFILES_PER_USER: "1",
    MAX_DOCUMENTS_PER_USER: "1",
    MAX_DOCUMENT_CHARACTERS: "500",
    UPLOAD_REQUESTS_PER_MINUTE: "1",
    MAX_ACTIVE_INDEX_BUILDS_PER_USER: "9",
    MAX_QUEUED_INDEX_BUILDS: "2",
    MAX_INDEX_BUILDS_PER_DAY: "1",
    MAX_INDEX_BUILDS_PER_DAY_TOTAL: "2",
    OLLAMA_TIMEOUT_MS: "5000",
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
    REQUESTS_PER_ADDRESS_PER_MINUTE: "300",
    LOGINS_PER_15_MINUTES: "10",
    FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES: "5",
    PASSWORD_CHANGES_PER_15_MINUTES: "5",
    USER_CREATIONS_PER_HOUR: "20",
    MAX_PROFILES_PER_USER: "20",
    MAX_DOCUMENTS_PER_USER: "3",
    MAX_DOCUMENT_CHARACTERS: "1000000",
    UPLOAD_REQUESTS_PER_MINUTE: "5",
    MAX_ACTIVE_INDEX_BUILDS_PER_USER: "1",
    MAX_QUEUED_INDEX_BUILDS: "20",
    MAX_INDEX_BUILDS_PER_DAY: "6",
    MAX_INDEX_BUILDS_PER_DAY_TOTAL: "100",
    OLLAMA_TIMEOUT_MS: "120000",
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
    delete env.RAG_LAB_TEST_API_DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    delete env.DATABASE_URL;
    delete env.MIGRATION_DATABASE_URL;

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
    // what test/setup.ts left in the two database variables
    const databaseVariablesAfterSetup = async (extraEnv: Record<string, string>): Promise<Record<string, string | null>> =>
        JSON.parse(await runAfterSetup(extraEnv, [FIXTURE])) as Record<string, string | null>;

    const DEVELOPMENT_URL = "postgres://dev:dev@127.0.0.1:5433/rag_lab";

    it("points the app's pool at the test database, as the API role", { timeout: 15_000 }, async () => {
        const apiUrl = process.env.RAG_LAB_TEST_API_DATABASE_URL;
        assert.ok(apiUrl, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");

        const { pool } = await import("../../src/v1/config/db.config.js");

        try {
            const { rows } = await pool.query<{ name: string; role: string }>("SELECT current_database() AS name, current_user AS role");

            assert.ok(rows[0].name.endsWith("_test"), `connected to "${rows[0].name}"`);
            assert.equal(rows[0].name, decodeURIComponent(new URL(apiUrl).pathname.slice(1)));
            assert.equal(rows[0].role, "rag_lab_api", "the app runs with the API role's rights, not the owner's");
        } finally {
            await pool.end();
        }
    });

    it("copies RAG_LAB_TEST_API_DATABASE_URL over a DATABASE_URL that points elsewhere", { timeout: 30_000 }, async () => {
        const apiUrl = "postgres://rag_lab_api:secret@127.0.0.1:5433/some_test";

        const printed = await databaseVariablesAfterSetup({
            DATABASE_URL: DEVELOPMENT_URL,
            RAG_LAB_TEST_API_DATABASE_URL: apiUrl,
            RAG_LAB_TEST_DATABASE_URL: "postgres://owner:secret@127.0.0.1:5433/some_test"
        });

        assert.equal(printed.DATABASE_URL, apiUrl);
    });

    it("copies RAG_LAB_TEST_DATABASE_URL over a MIGRATION_DATABASE_URL that points at the development database", { timeout: 30_000 }, async () => {
        const ownerUrl = "postgres://owner:secret@127.0.0.1:5433/some_test";

        const printed = await databaseVariablesAfterSetup({
            MIGRATION_DATABASE_URL: "postgres://owner:dev@127.0.0.1:5433/rag_lab",
            RAG_LAB_TEST_API_DATABASE_URL: "postgres://rag_lab_api:secret@127.0.0.1:5433/some_test",
            RAG_LAB_TEST_DATABASE_URL: ownerUrl
        });

        assert.equal(printed.MIGRATION_DATABASE_URL, ownerUrl);
    });

    it("removes DATABASE_URL and MIGRATION_DATABASE_URL when no test database is configured", { timeout: 30_000 }, async () => {
        const printed = await databaseVariablesAfterSetup({ DATABASE_URL: DEVELOPMENT_URL, MIGRATION_DATABASE_URL: DEVELOPMENT_URL });

        assert.deepEqual(printed, { DATABASE_URL: null, MIGRATION_DATABASE_URL: null });
    });

    // the owner's URL must never become the app's: the app would then run with rights it does not have in production
    it("removes DATABASE_URL when only the owner's test URL is set, and still sets MIGRATION_DATABASE_URL", { timeout: 30_000 }, async () => {
        const ownerUrl = "postgres://owner:secret@127.0.0.1:5433/some_test";

        const printed = await databaseVariablesAfterSetup({ DATABASE_URL: DEVELOPMENT_URL, RAG_LAB_TEST_DATABASE_URL: ownerUrl });

        assert.deepEqual(printed, { DATABASE_URL: null, MIGRATION_DATABASE_URL: ownerUrl });
    });

    it("removes MIGRATION_DATABASE_URL when only the API's test URL is set, and still sets DATABASE_URL", { timeout: 30_000 }, async () => {
        const apiUrl = "postgres://rag_lab_api:secret@127.0.0.1:5433/some_test";

        const printed = await databaseVariablesAfterSetup({ MIGRATION_DATABASE_URL: DEVELOPMENT_URL, RAG_LAB_TEST_API_DATABASE_URL: apiUrl });

        assert.deepEqual(printed, { DATABASE_URL: apiUrl, MIGRATION_DATABASE_URL: null });
    });

    it("does not read TEST_DATABASE_URL, which belongs to other projects", { timeout: 30_000 }, async () => {
        const printed = await databaseVariablesAfterSetup({
            DATABASE_URL: DEVELOPMENT_URL,
            TEST_DATABASE_URL: "postgres://other:other@127.0.0.1:5432/other_test"
        });

        assert.deepEqual(printed, { DATABASE_URL: null, MIGRATION_DATABASE_URL: null });
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
        // the app only needs its own URL to load; nothing connects
        const databaseUrl = "postgres://tester:secret@127.0.0.1:1/some_test";

        // from the shell
        assert.deepEqual(
            JSON.parse(await runAfterSetup({ TRUSTED_PROXIES: "10.0.0.0/8", RAG_LAB_TEST_API_DATABASE_URL: databaseUrl }, [PROXIES_FIXTURE])),
            ["loopback"],
            "shell"
        );

        // from the developer's .env, which the app loads itself when the setup left the variable alone
        assert.deepEqual(
            JSON.parse(await runAfterSetup({ DOTENV_CONFIG_PATH: developerEnvFile, RAG_LAB_TEST_API_DATABASE_URL: databaseUrl }, [PROXIES_FIXTURE])),
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
