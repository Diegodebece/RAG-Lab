import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { pool } from "../../src/v1/config/db.config.js";

const execFileAsync = promisify(execFile);

// Two connections to the test database, with the two roles of production:
// - `pool` (from db.config.ts) is the app's own pool, DATABASE_URL, the API role. It only does what the API does.
// - `ownerPool` is the database owner, MIGRATION_DATABASE_URL. Schema changes, TRUNCATE, seeding, inspecting the
//   schema and pg_terminate_backend go through it, because the API role can do none of them.
// Without USAGE on the schema the API role cannot even see the tables (to_regclass answers NULL and
// information_schema hides them), so an inspection through its pool can pass while checking nothing.
const ownerUrl = process.env.MIGRATION_DATABASE_URL;

if (!ownerUrl) {
    throw new Error("MIGRATION_DATABASE_URL is not set: the database tests need the owner's connection");
}

export const ownerPool = new pg.Pool({ connectionString: ownerUrl, connectionTimeoutMillis: 5000 });

// an idle connection that breaks must not crash the test process
ownerPool.on("error", () => {});

// The name of the database a URL points at, or "" when it is not a URL. Never the rest of the URL: it has a password.
const databaseNameOf = (url: string | undefined): string => {
    try {
        return decodeURIComponent(new URL(url ?? "").pathname.slice(1));
    } catch {
        return "";
    }
};

// First line of defense: the two URLs must name the same database, and its name must end in _test. A mistake in
// either variable (the development database in one of them) stops the reset before any connection is made.
const assertTestDatabaseUrls = (): void => {
    const appDatabase = databaseNameOf(process.env.DATABASE_URL);
    const ownerDatabase = databaseNameOf(ownerUrl);

    if (appDatabase !== ownerDatabase) {
        throw new Error(`Refusing to reset: DATABASE_URL names "${appDatabase}" and MIGRATION_DATABASE_URL names "${ownerDatabase}"; they must be the same database`);
    }

    if (!ownerDatabase.endsWith("_test")) {
        throw new Error(`Refusing to reset "${ownerDatabase}": test databases must end in _test`);
    }
};

// Second line of defense: what the server says it is connected to, not what the URL says.
const assertTestDatabase = async (): Promise<void> => {
    assertTestDatabaseUrls();

    const { rows } = await ownerPool.query<{ name: string }>("SELECT current_database() AS name");

    if (!rows[0].name.endsWith("_test")) {
        throw new Error(`Refusing to reset "${rows[0].name}": test databases must end in _test`);
    }
};

// Runs the real migration script, as `npm run migrate` would, against the test database, with the owner's URL in
// MIGRATION_DATABASE_URL (the script uses no other variable). It rejects when the script exits with a non-zero
// code; the error carries stdout, stderr and code.
export const runMigrateScript = async (): Promise<string> => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
        env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
        timeout: 60_000
    });

    return stdout;
};

// Drops every table (and the vector extension, which lives in the same schema) so each test file starts empty.
// The new schema has no grants: only the migrations give the API role its rights.
export const emptyTestDatabase = async (): Promise<void> => {
    await assertTestDatabase();
    await ownerPool.query("DROP SCHEMA public CASCADE");
    await ownerPool.query("CREATE SCHEMA public");
};

// Empty schema, then all migrations applied.
export const resetTestDatabase = async (): Promise<void> => {
    await emptyTestDatabase();
    await runMigrateScript();
};

// Closes both pools once; safe to call when a pool is already closed.
export const closeTestPools = async (): Promise<void> => {
    if (!pool.ending) {
        await pool.end();
    }

    if (!ownerPool.ending) {
        await ownerPool.end();
    }
};
