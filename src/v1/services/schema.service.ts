import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { pool } from "../config/db.config.js";
import type { MigrationState } from "../types/schema.type.js";

// migrations/ sits next to src/ and dist/, so this path works both with tsx and from the compiled files
export const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "..", "migrations");

// Compares the migration files of this checkout with the ones recorded in the database:
// applied: in both; pending: only in this checkout (npm run migrate applies them);
// unknown: recorded in the database but missing here, which means the database belongs to another checkout or project.
// A database without the schema_migrations table has had nothing applied; if it already has tables of its own,
// foreignTables lists them, because it looks like another project's database.
// The migration script passes its own pool, which has no query timeout.
export const getMigrationStateService = async (targetPool: Pool = pool): Promise<MigrationState> => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    const { rows: tables } = await targetPool.query<{ found: string | null }>("SELECT to_regclass('schema_migrations') AS found");
    const recorded: string[] = [];
    let foreignTables: string[] = [];

    if (tables[0].found !== null) {
        const { rows } = await targetPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        recorded.push(...rows.map((row) => row.version));
    } else {
        const { rows } = await targetPool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
        foreignTables = rows.map((row) => row.tablename);
    }

    return {
        applied: files.filter((file) => recorded.includes(file)),
        pending: files.filter((file) => !recorded.includes(file)),
        unknown: recorded.filter((version) => !files.includes(version)),
        foreignTables
    };
};
