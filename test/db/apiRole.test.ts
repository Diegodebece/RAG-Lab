import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { pool } from "../../src/v1/config/db.config.js";
import { closeTestPools, emptyTestDatabase, ownerPool, resetTestDatabase } from "./testDatabase.js";

const execFileAsync = promisify(execFile);

// The API runs as rag_lab_api, a role that can read and write the data and can do nothing else: no schema changes,
// no TRUNCATE, no new tables, no roles. Migration 002 gives it exactly that, and these tests check it the way a
// flaw in the API would use it: by trying.
//
// The rights are read as the owner. Without USAGE on the schema, to_regclass answers NULL and information_schema
// hides the tables from the API role, so an inspection through its own pool can pass while checking nothing; and
// has_table_privilege with a list of privileges is true when any one is held, so each privilege is asked alone.
const API_ROLE = "rag_lab_api";
const ROOT = path.join(import.meta.dirname, "..", "..");

before(resetTestDatabase);

after(closeTestPools);

const publicTables = async (): Promise<string[]> => {
    const { rows } = await ownerPool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    return rows.map((row) => row.tablename);
};

const holds = async (table: string, privilege: string): Promise<boolean> => {
    const { rows } = await ownerPool.query<{ held: boolean }>(
        "SELECT has_table_privilege($1::name, format('public.%I', $2::text), $3::text) AS held",
        [API_ROLE, table, privilege]
    );
    return rows[0].held;
};

// the privileges the API role holds on a table, each asked on its own
const privilegesOn = async (table: string): Promise<string[]> => {
    const held: string[] = [];

    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        if (await holds(table, privilege)) {
            held.push(privilege);
        }
    }

    return held;
};

// what the API role gets when it tries to change the schema: the SQLSTATE of the refusal
const failureCodeOf = async (statement: string): Promise<string | undefined> => {
    try {
        await pool.query(statement);
        return undefined;
    } catch (error) {
        return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "not a database error";
    }
};

const checkTheRights = (): void => {
    it("holds SELECT, INSERT, UPDATE and DELETE on every table of the schema except schema_migrations, and nothing more", async () => {
        const tables = (await publicTables()).filter((table) => table !== "schema_migrations");

        assert.ok(tables.includes("users"), "the users table is among them");

        for (const table of tables) {
            assert.deepEqual(await privilegesOn(table), ["SELECT", "INSERT", "UPDATE", "DELETE"], table);
        }
    });

    it("holds only SELECT on schema_migrations", async () => {
        assert.deepEqual(await privilegesOn("schema_migrations"), ["SELECT"]);
    });

    it("is refused every change to the schema with 'permission denied' (42501)", async () => {
        const statements: Record<string, string> = {
            "CREATE TABLE": "CREATE TABLE api_made_this (id integer)",
            "ALTER TABLE users": "ALTER TABLE users ADD COLUMN api_made_this integer",
            "DROP TABLE users": "DROP TABLE users",
            "DROP TABLE schema_migrations": "DROP TABLE schema_migrations",
            "TRUNCATE users": "TRUNCATE users",
            "CREATE FUNCTION": "CREATE FUNCTION api_made_this() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
            "CREATE SCHEMA": "CREATE SCHEMA api_made_this",
            "INSERT INTO schema_migrations": "INSERT INTO schema_migrations (version) VALUES ('999_api_made_this.sql')",
            "DELETE FROM schema_migrations": "DELETE FROM schema_migrations",
            "UPDATE schema_migrations": "UPDATE schema_migrations SET version = 'x'"
        };

        for (const [label, statement] of Object.entries(statements)) {
            assert.equal(await failureCodeOf(statement), "42501", label);
        }

        assert.ok((await publicTables()).includes("users"), "users is still there");
        assert.ok(!(await publicTables()).includes("api_made_this"));
    });

    it("can use the schema but not create in it", async () => {
        const { rows } = await ownerPool.query<{ usage: boolean; create: boolean }>(
            "SELECT has_schema_privilege($1::name, 'public', 'USAGE') AS usage, has_schema_privilege($1::name, 'public', 'CREATE') AS create",
            [API_ROLE]
        );

        assert.deepEqual(rows[0], { usage: true, create: false }, "CREATE is revoked from everyone, PUBLIC included");
    });
};

describe("the API role", () => {
    it("is the one the app's pool connects with", async () => {
        const { rows } = await pool.query<{ role: string }>("SELECT current_user AS role");

        assert.equal(rows[0].role, API_ROLE);
    });

    it("is a plain login role: not a superuser, and it cannot create roles or databases, bypass row security or replicate", async () => {
        const { rows } = await ownerPool.query(
            "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = $1",
            [API_ROLE]
        );

        assert.deepEqual(rows, [{ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false }]);
    });

    checkTheRights();

    it("reads and writes the users table, the way the API does", async () => {
        const { rows: inserted } = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('api.probe@example.com', 'x') RETURNING id");
        const id = inserted[0].id;

        await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [id]);
        const { rows } = await pool.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [id]);
        assert.equal(rows[0].status, "disabled");

        await pool.query("DELETE FROM users WHERE id = $1", [id]);
        assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount, 0);
    });

    it("reads schema_migrations, which is how the server checks the schema at startup", async () => {
        const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");

        assert.deepEqual(rows.map((row) => row.version), ["001_init.sql", "002_api_role.sql", "003_users.sql"]);
    });

    it("can use pgvector's type and operators, which live in the schema it was given USAGE on", async () => {
        const vector = JSON.stringify(new Array(1024).fill(0.1));

        const { rows } = await pool.query<{ distance: number }>("SELECT ($1::vector(1024) <=> $1::vector(1024))::float8 AS distance", [vector]);

        assert.ok(Math.abs(rows[0].distance) < 1e-6);
    });
});

// The tables the next layers add are made by the owner after these migrations ran, so the role has to get its rights
// on them without a new migration: through default privileges, on the table and on its sequence.
describe("a table the owner creates after the migrations", () => {
    before(async () => {
        await ownerPool.query("CREATE TABLE later_layer_probe (id serial PRIMARY KEY, body text NOT NULL)");
    });

    it("takes inserts from the API role, with its serial id", async () => {
        const first = await pool.query<{ id: number }>("INSERT INTO later_layer_probe (body) VALUES ('one') RETURNING id");
        const second = await pool.query<{ id: number }>("INSERT INTO later_layer_probe (body) VALUES ('two') RETURNING id");

        assert.deepEqual([first.rows[0].id, second.rows[0].id], [1, 2]);
    });

    it("can be read, changed and emptied row by row by the API role, but not truncated", async () => {
        await pool.query("INSERT INTO later_layer_probe (body) VALUES ('three')");

        await pool.query("UPDATE later_layer_probe SET body = 'changed' WHERE body = 'three'");
        const { rows } = await pool.query<{ body: string }>("SELECT body FROM later_layer_probe WHERE body = 'changed'");
        assert.equal(rows.length, 1);

        await pool.query("DELETE FROM later_layer_probe");
        assert.equal(await failureCodeOf("TRUNCATE later_layer_probe"), "42501");
        assert.deepEqual(await privilegesOn("later_layer_probe"), ["SELECT", "INSERT", "UPDATE", "DELETE"]);
    });
});

// Every test file empties the schema and migrates again: the rights have to come back each time.
describe("the API role after the database is emptied and migrated a second time", () => {
    before(resetTestDatabase);

    checkTheRights();

    it("takes inserts into a table the owner creates after that second migration", async () => {
        await ownerPool.query("CREATE TABLE second_round_probe (id serial PRIMARY KEY, body text)");

        const { rows } = await pool.query<{ id: number }>("INSERT INTO second_round_probe (body) VALUES ('x') RETURNING id");

        assert.equal(rows[0].id, 1);
    });
});

// A migration that gives rights to a role that does not exist must say what to do, and not fail with a bare
// "role does not exist". The test runs a copy of 002 that names a role nobody created.
describe("migration 002 when the API role was never created", () => {
    let workFolder = "";

    before(async () => {
        // a run that was killed before its `after` leaves its copy behind
        for (const entry of await readdir(import.meta.dirname)) {
            if (entry.startsWith(".role-copy-")) {
                await rm(path.join(import.meta.dirname, entry), { recursive: true, force: true });
            }
        }

        workFolder = await mkdtemp(path.join(import.meta.dirname, ".role-copy-"));
        // an empty .env, so the child process does not read the real one
        await writeFile(path.join(workFolder, "empty.env"), "");
        await cp(path.join(ROOT, "src"), path.join(workFolder, "src"), { recursive: true });
        await mkdir(path.join(workFolder, "migrations"));
        await cp(path.join(ROOT, "migrations", "001_init.sql"), path.join(workFolder, "migrations", "001_init.sql"));
        await cp(path.join(ROOT, "migrations", "003_users.sql"), path.join(workFolder, "migrations", "003_users.sql"));

        const real = await readFile(path.join(ROOT, "migrations", "002_api_role.sql"), "utf8");
        await writeFile(path.join(workFolder, "migrations", "002_api_role.sql"), real.replaceAll(API_ROLE, "rag_lab_role_nobody_created"));

        await emptyTestDatabase();
    });

    after(() => rm(workFolder, { recursive: true, force: true }));

    it("fails and names scripts/create-api-role.sql, applying nothing after it", { timeout: 60_000 }, async () => {
        await assert.rejects(
            execFileAsync(process.execPath, ["--import", "tsx", path.join(workFolder, "src", "migrate.ts")], {
                cwd: ROOT,
                env: cleanChildEnvironment({ DOTENV_CONFIG_PATH: path.join(workFolder, "empty.env"), DOTENV_CONFIG_QUIET: "true" }),
                timeout: 50_000
            }),
            (error: unknown) => {
                const failure = error as { code?: number; stdout?: string; stderr?: string };

                assert.equal(typeof failure.code, "number", "the script exits with a failure, not a timeout");
                assert.notEqual(failure.code, 0);
                assert.match(failure.stderr ?? "", /002_api_role\.sql/, "it names the migration that failed");
                assert.match(failure.stderr ?? "", /scripts[\\/]create-api-role\.sql/, "it says which script creates the role");
                assert.match(failure.stdout ?? "", /Applied 001_init\.sql/);
                assert.doesNotMatch(failure.stdout ?? "", /Applied 002|Applied 003/);
                return true;
            }
        );

        const { rows } = await ownerPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["001_init.sql"], "the failed migration was not recorded");
        assert.ok(!(await publicTables()).includes("users"), "003 did not run");
    });
});
