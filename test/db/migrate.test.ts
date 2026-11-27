import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { closeTestPools, emptyTestDatabase, ownerPool, runMigrateScript } from "./testDatabase.js";

const execFileAsync = promisify(execFile);

const ROOT = path.join(import.meta.dirname, "..", "..");

// pgvector reads '[0.1,0.2,...]', which is exactly what JSON.stringify produces for a number array
const vectorOf = (value: number, dimensions = 1024): string => JSON.stringify(new Array(dimensions).fill(value));

interface ScriptFailure {
    code: number;
    stdout: string;
    stderr: string;
}

const isScriptFailure = (error: unknown): error is ScriptFailure =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" && "stderr" in error;

// Everything below inspects the database as its owner: the API role has no rights on a schema the migrations have
// not given it, so through its pool a table would simply not be there to see.
const publicTables = async (): Promise<string[]> => {
    const { rows } = await ownerPool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    // sorted here and not by the database: its collation decides where "document_indexes" goes next to "documents"
    return rows.map((row) => row.tablename).sort();
};

const ALL_MIGRATIONS = [
    "001_init.sql", "002_api_role.sql", "003_users.sql", "004_default_profile.sql", "005_profiles.sql",
    "006_documents.sql", "007_document_indexes.sql", "008_index_build_usage.sql"
];

const ALL_TABLES = ["chunks", "default_profile", "document_indexes", "documents", "index_build_usage", "profiles", "schema_migrations", "users"];

// closes both pools once, after every suite in this file
after(closeTestPools);

describe("migrate script", () => {
    before(emptyTestDatabase);

    it("applies every migration to an empty database", { timeout: 60_000 }, async () => {
        const output = await runMigrateScript();

        assert.match(output, /Applied 001_init\.sql/);
        assert.match(output, /Applied 002_api_role\.sql/);
        assert.match(output, /Applied 003_users\.sql/);
        assert.match(output, /Applied 004_default_profile\.sql/);
        assert.match(output, /Applied 005_profiles\.sql/);
        assert.match(output, /Applied 006_documents\.sql/);
        assert.match(output, /Applied 007_document_indexes\.sql/);
        assert.match(output, /Applied 008_index_build_usage\.sql/);

        const { rows } = await ownerPool.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        );
        assert.deepEqual(rows.map((row) => row.table_name).sort(), ALL_TABLES);
    });

    it("enables pgvector, with cosine distance on 1024-dimension vectors", async () => {
        const { rows: extensions } = await ownerPool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 1);

        const { rows } = await ownerPool.query<{ distance: number }>(
            "SELECT ($1::vector(1024) <=> $1::vector(1024))::float8 AS distance",
            [vectorOf(0.1)]
        );
        assert.ok(Math.abs(rows[0].distance) < 1e-6, `the distance of a vector to itself is ${rows[0].distance}`);
    });

    it("records applied migrations and skips them on the next run", { timeout: 60_000 }, async () => {
        const output = await runMigrateScript();

        assert.match(output, /Database is up to date/);

        const { rows } = await ownerPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ALL_MIGRATIONS);
    });
});

// The migration script changes the schema, so it runs as the owner and takes its connection from
// MIGRATION_DATABASE_URL only. The API's own DATABASE_URL names a role that cannot change the schema; falling back
// to it would run the migrations with the wrong rights (or, with a URL copied from a development .env, against the
// wrong database), so a missing variable is an error and not a fallback.
describe("migrate script without MIGRATION_DATABASE_URL", () => {
    before(emptyTestDatabase);

    // DATABASE_URL here is the owner's URL, the only one that could apply the migrations: a script that falls back
    // to it succeeds, so the test sees the fallback instead of a permission error that would hide it
    const runWithout = (migrationUrl: string | undefined): Promise<{ stdout: string; stderr: string }> =>
        execFileAsync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
            cwd: ROOT,
            env: cleanChildEnvironment({
                DATABASE_URL: process.env.RAG_LAB_TEST_DATABASE_URL,
                MIGRATION_DATABASE_URL: migrationUrl,
                DOTENV_CONFIG_PATH: "nonexistent.env",
                DOTENV_CONFIG_QUIET: "true"
            }),
            timeout: 25_000
        });

    for (const [label, value] of [["missing", undefined], ["empty", ""]] as const) {
        it(`refuses to run when MIGRATION_DATABASE_URL is ${label}, even with DATABASE_URL set, and applies nothing`, { timeout: 40_000 }, async () => {
            await assert.rejects(runWithout(value), (error: unknown) => {
                assert.ok(isScriptFailure(error), "the script exits with a failure, not a timeout");
                assert.notEqual(error.code, 0);
                assert.match(error.stderr, /MIGRATION_DATABASE_URL/, "it names the setting that is missing");
                assert.doesNotMatch(error.stdout, /Applied /);
                return true;
            });

            assert.deepEqual(await publicTables(), [], "no table was created, not even schema_migrations");

            const { rows: extensions } = await ownerPool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
            assert.equal(extensions.length, 0, "001_init.sql was not applied");
        });
    }
});

// The owner runs `npm run migrate` before the API role's URL exists (the role's migration is what gives it rights),
// and on a machine that has only the owner's URL. The script must not need DATABASE_URL, which is the API's.
describe("migrate script with only MIGRATION_DATABASE_URL", () => {
    before(emptyTestDatabase);

    it("applies every migration without DATABASE_URL and without reading any .env file", { timeout: 60_000 }, async () => {
        const ownerUrl = process.env.RAG_LAB_TEST_DATABASE_URL;
        assert.ok(ownerUrl, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");

        let outcome: { stdout: string; stderr: string };

        try {
            outcome = await execFileAsync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
                cwd: ROOT,
                env: cleanChildEnvironment({
                    DATABASE_URL: undefined,
                    MIGRATION_DATABASE_URL: ownerUrl,
                    DOTENV_CONFIG_PATH: "nonexistent.env",
                    DOTENV_CONFIG_QUIET: "true"
                }),
                timeout: 50_000
            });
        } catch (error) {
            assert.fail(`the script failed without DATABASE_URL: ${isScriptFailure(error) ? error.stderr : String(error)}`);
        }

        assert.match(outcome.stdout, /Applied 001_init\.sql/);
        assert.match(outcome.stdout, /Applied 003_users\.sql/);
        assert.match(outcome.stdout, /Applied 005_profiles\.sql/);
        assert.match(outcome.stdout, /Applied 008_index_build_usage\.sql/);
        assert.deepEqual(await publicTables(), ALL_TABLES);
    });
});

describe("migrate script against another project's database", () => {
    // A database with tables of its own and no schema_migrations table: the owner's URL points at the wrong place.
    before(async () => {
        await emptyTestDatabase();
        await ownerPool.query("CREATE TABLE other_projects_notes (id integer PRIMARY KEY, body text)");
        await ownerPool.query("INSERT INTO other_projects_notes VALUES (1, 'keep me')");
    });

    it("refuses to run, applies nothing and leaves the database as it was", { timeout: 60_000 }, async () => {
        await assert.rejects(runMigrateScript(), (error: unknown) => {
            assert.ok(isScriptFailure(error), "the script exits with a failure");
            assert.notEqual(error.code, 0);
            assert.match(error.stderr, /another project/i, "it says the database looks like another project's");
            assert.match(error.stderr, /DATABASE_URL/, "it points at the setting to check");
            assert.doesNotMatch(error.stdout, /Applied /);
            return true;
        });

        const { rows: extensions } = await ownerPool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 0, "001_init.sql was not applied");

        assert.deepEqual(await publicTables(), ["other_projects_notes"], "schema_migrations was not even created");

        const { rows } = await ownerPool.query<{ body: string }>("SELECT body FROM other_projects_notes");
        assert.deepEqual(rows, [{ body: "keep me" }], "the other project's data is untouched");
    });
});

describe("migrate script against a database it already set up", () => {
    // The rule against other projects' databases must not catch the normal case: schema_migrations exists next
    // to the tables of the later layers.
    before(async () => {
        await emptyTestDatabase();
        await runMigrateScript();
        await ownerPool.query("CREATE TABLE later_layer_table (id integer PRIMARY KEY)");
    });

    it("runs normally when other tables sit next to schema_migrations", { timeout: 60_000 }, async () => {
        const output = await runMigrateScript();

        assert.match(output, /Database is up to date/);
    });
});

describe("migrate script against the wrong database", () => {
    // A database that has a migration this checkout does not have: for example the development database of
    // another branch, or another project's database.
    before(async () => {
        await emptyTestDatabase();
        await ownerPool.query(`
            CREATE TABLE schema_migrations (
                version text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        `);
        await ownerPool.query("INSERT INTO schema_migrations (version) VALUES ('002_upload_usage.sql')");
    });

    it("refuses to run and applies nothing", { timeout: 60_000 }, async () => {
        await assert.rejects(runMigrateScript(), (error: unknown) => {
            assert.ok(isScriptFailure(error), "the script exits with a failure");
            assert.notEqual(error.code, 0);
            assert.match(error.stderr, /002_upload_usage\.sql/, "it names the migration this checkout does not have");
            assert.match(error.stderr, /DATABASE_URL/, "it points at the setting to check");
            assert.doesNotMatch(error.stdout, /Applied /);
            return true;
        });

        const { rows: extensions } = await ownerPool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 0, "001_init.sql was not applied");

        const { rows } = await ownerPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["002_upload_usage.sql"], "nothing was recorded");
    });
});
