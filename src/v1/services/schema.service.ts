import { readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/db.config.js";
import type { MigrationState } from "../types/schema.type.js";

// migrations/ sits next to src/ and dist/, so this path works both with tsx and from the compiled files
export const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "..", "migrations");

// Compares the migration files of this checkout with the ones recorded in the database:
// applied: in both; pending: only in this checkout (npm run migrate applies them);
// unknown: recorded in the database but missing here, which means the database belongs to another checkout or project.
// A database without the schema_migrations table has had nothing applied.
export const getMigrationStateService = async (): Promise<MigrationState> => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

    const { rows: tables } = await pool.query<{ found: string | null }>("SELECT to_regclass('schema_migrations') AS found");
    const recorded: string[] = [];

    if (tables[0].found !== null) {
        const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        recorded.push(...rows.map((row) => row.version));
    }

    return {
        applied: files.filter((file) => recorded.includes(file)),
        pending: files.filter((file) => !recorded.includes(file)),
        unknown: recorded.filter((version) => !files.includes(version))
    };
};
