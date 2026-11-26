import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createPool, runInTransaction } from "./v1/config/pool.config.js";
import { getMigrationStateService, MIGRATIONS_DIR } from "./v1/services/schema.service.js";

// Any number works; it only has to be the same for every process that runs migrations.
const MIGRATIONS_LOCK_ID = 72617001;

const applyPendingMigrations = async (migrationPool: Pool): Promise<void> => {
    const { pending, unknown, foreignTables } = await getMigrationStateService(migrationPool);

    // Tables but no schema_migrations: this project's migrations never ran here, so the tables belong to something
    // else. Nothing is applied, not even the schema_migrations table, so the database stays as it was.
    if (foreignTables.length > 0) {
        const shown = foreignTables.slice(0, 5).join(", ");
        const more = foreignTables.length > 5 ? ` and ${foreignTables.length - 5} more` : "";

        throw new Error(
            `The database looks like another project's: it has tables (${shown}${more}) but no schema_migrations table. `
            + "Nothing was applied. Check that MIGRATION_DATABASE_URL points at the right database."
        );
    }

    // A database that has migrations this checkout does not have was made by another checkout or project:
    // applying our files to it would mix two schemas, so nothing is applied.
    if (unknown.length > 0) {
        throw new Error(
            `The database has applied migrations this checkout does not have: ${unknown.join(", ")}. `
            + "Nothing was applied. Check that MIGRATION_DATABASE_URL points at the right database."
        );
    }

    await migrationPool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);

    if (pending.length === 0) {
        console.log("Database is up to date");
        return;
    }

    for (const file of pending) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");

        try {
            // the file and its record are applied together, or not at all
            await runInTransaction(migrationPool, async (client) => {
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
            });
        } catch (error) {
            throw new Error(`Migration ${file} failed`, { cause: error });
        }

        console.log(`Applied ${file}`);
    }
};

// A session-level advisory lock: a second process that runs migrations at the same time waits here.
const migrate = async (migrationPool: Pool): Promise<void> => {
    const lockClient = await migrationPool.connect();

    try {
        await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATIONS_LOCK_ID]);

        try {
            await applyPendingMigrations(migrationPool);
        } finally {
            await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATIONS_LOCK_ID]);
        }
    } finally {
        lockClient.release();
    }
};

// The schema is changed as the database's owner, with a connection of its own: MIGRATION_DATABASE_URL. DATABASE_URL
// is the API's, a role that cannot change the schema, and it is never used as a fallback: that would run the
// migrations with the wrong rights or, with a URL copied from another setup, against the wrong database.
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

if (!migrationUrl) {
    console.error("MIGRATION_DATABASE_URL is not set: it is the owner's connection to the database, used only to apply migrations (see .env.example). Nothing was applied.");
    process.exitCode = 1;
} else {
    // This script has its own pool, without the API's query timeout (db.config.ts, which it never imports: it needs
    // DATABASE_URL, and this script needs only MIGRATION_DATABASE_URL): a migration can take longer than
    // any query the API runs, and waiting for the advisory lock below lasts as long as another process takes to migrate.
    const migrationPool = createPool({ connectionString: migrationUrl });

    try {
        await migrate(migrationPool);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        await migrationPool.end();
    }
}
