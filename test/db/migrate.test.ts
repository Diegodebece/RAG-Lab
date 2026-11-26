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
