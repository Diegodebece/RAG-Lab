import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/v1/config/db.config.js";
import { emptyTestDatabase, runMigrateScript } from "./testDatabase.js";

// pgvector reads '[0.1,0.2,...]', which is exactly what JSON.stringify produces for a number array
const vectorOf = (value: number, dimensions = 1024): string => JSON.stringify(new Array(dimensions).fill(value));

interface ScriptFailure {
    code: number;
    stdout: string;
    stderr: string;
}

const isScriptFailure = (error: unknown): error is ScriptFailure =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" && "stderr" in error;

// closes the pool once, after both suites in this file
after(() => pool.end());

describe("migrate script", () => {
    before(emptyTestDatabase);

    it("applies every migration to an empty database", async () => {
        const output = await runMigrateScript();

        assert.match(output, /Applied 001_init\.sql/);

        const { rows } = await pool.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        );
        assert.deepEqual(rows.map((row) => row.table_name), ["schema_migrations"]);
    });

    it("enables pgvector, with cosine distance on 1024-dimension vectors", async () => {
        const { rows: extensions } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 1);

        const { rows } = await pool.query<{ distance: number }>(
            "SELECT ($1::vector(1024) <=> $1::vector(1024))::float8 AS distance",
            [vectorOf(0.1)]
        );
        assert.ok(Math.abs(rows[0].distance) < 1e-6, `the distance of a vector to itself is ${rows[0].distance}`);
    });

    it("records applied migrations and skips them on the next run", async () => {
        const output = await runMigrateScript();

        assert.match(output, /Database is up to date/);

        const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["001_init.sql"]);
    });
});

describe("migrate script against another project's database", () => {
    // A database with tables of its own and no schema_migrations table: DATABASE_URL points at the wrong place.
    before(async () => {
        await emptyTestDatabase();
        await pool.query("CREATE TABLE other_projects_notes (id integer PRIMARY KEY, body text)");
        await pool.query("INSERT INTO other_projects_notes VALUES (1, 'keep me')");
    });

    it("refuses to run, applies nothing and leaves the database as it was", async () => {
        await assert.rejects(runMigrateScript(), (error: unknown) => {
            assert.ok(isScriptFailure(error), "the script exits with a failure");
            assert.notEqual(error.code, 0);
            assert.match(error.stderr, /another project/i, "it says the database looks like another project's");
            assert.match(error.stderr, /DATABASE_URL/, "it points at the setting to check");
            assert.doesNotMatch(error.stdout, /Applied /);
            return true;
        });

        const { rows: extensions } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 0, "001_init.sql was not applied");

        const { rows: tables } = await pool.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        );
        assert.deepEqual(tables.map((row) => row.table_name), ["other_projects_notes"], "schema_migrations was not even created");

        const { rows } = await pool.query<{ body: string }>("SELECT body FROM other_projects_notes");
        assert.deepEqual(rows, [{ body: "keep me" }], "the other project's data is untouched");
    });
});

describe("migrate script against a database it already set up", () => {
    // The rule against other projects' databases must not catch the normal case: schema_migrations exists next
    // to the tables of the later layers.
    before(async () => {
        await emptyTestDatabase();
        await runMigrateScript();
        await pool.query("CREATE TABLE later_layer_table (id integer PRIMARY KEY)");
    });

    it("runs normally when other tables sit next to schema_migrations", async () => {
        const output = await runMigrateScript();

        assert.match(output, /Database is up to date/);
    });
});

describe("migrate script against the wrong database", () => {
    // A database that has a migration this checkout does not have: for example the development database of
    // another branch, or another project's database.
    before(async () => {
        await emptyTestDatabase();
        await pool.query(`
            CREATE TABLE schema_migrations (
                version text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        `);
        await pool.query("INSERT INTO schema_migrations (version) VALUES ('002_upload_usage.sql')");
    });

    it("refuses to run and applies nothing", async () => {
        await assert.rejects(runMigrateScript(), (error: unknown) => {
            assert.ok(isScriptFailure(error), "the script exits with a failure");
            assert.notEqual(error.code, 0);
            assert.match(error.stderr, /002_upload_usage\.sql/, "it names the migration this checkout does not have");
            assert.match(error.stderr, /DATABASE_URL/, "it points at the setting to check");
            assert.doesNotMatch(error.stdout, /Applied /);
            return true;
        });

        const { rows: extensions } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        assert.equal(extensions.length, 0, "001_init.sql was not applied");

        const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["002_upload_usage.sql"], "nothing was recorded");
    });
});
