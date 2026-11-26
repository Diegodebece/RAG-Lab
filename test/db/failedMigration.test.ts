import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { closeTestPools, emptyTestDatabase, ownerPool } from "./testDatabase.js";

const execFileAsync = promisify(execFile);

// The migration script reads migrations/ next to src/. To run it on a migration that fails, these tests copy
// src/ to a temporary folder that has its own migrations/ (the real 001_init.sql plus the broken ones), and run the
// copied script. The code is the same; only the folder it finds the SQL files in differs. The folder is created
// inside test/, so Node finds the project's node_modules and package.json by walking up from it; it is removed
// when the tests end.
const ROOT = path.join(import.meta.dirname, "..", "..");

interface ScriptFailure {
    code: number;
    stdout: string;
    stderr: string;
}

const isScriptFailure = (error: unknown): error is ScriptFailure =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" && "stderr" in error;

let workFolder = "";
let emptyEnvFile = "";

before(async () => {
    // a run that was killed before its `after` leaves its copy of src/ behind; they pile up otherwise
    for (const entry of await readdir(import.meta.dirname)) {
        if (entry.startsWith(".migrations-copy-")) {
            await rm(path.join(import.meta.dirname, entry), { recursive: true, force: true });
        }
    }

    workFolder = await mkdtemp(path.join(import.meta.dirname, ".migrations-copy-"));
    emptyEnvFile = path.join(workFolder, "empty.env");
    await writeFile(emptyEnvFile, "");

    await cp(path.join(ROOT, "src"), path.join(workFolder, "src"), { recursive: true });

    await mkdir(path.join(workFolder, "migrations"));
    await cp(path.join(ROOT, "migrations", "001_init.sql"), path.join(workFolder, "migrations", "001_init.sql"));
    await writeFile(path.join(workFolder, "migrations", "002_broken.sql"), [
        "CREATE TABLE half_done_probe (id integer);",
        "INSERT INTO half_done_probe VALUES (1);",
        "SELECT 1 / 0;"
    ].join("\n"));
    await writeFile(path.join(workFolder, "migrations", "003_after_the_broken_one.sql"), "CREATE TABLE after_probe (id integer);");

    await emptyTestDatabase();
});

after(async () => {
    await closeTestPools();
    await rm(workFolder, { recursive: true, force: true });
});

// through the owner's pool: for the API role a table is invisible until the migrations grant it USAGE on the schema
const tableExists = async (name: string): Promise<boolean> => {
    const { rows } = await ownerPool.query<{ found: string | null }>("SELECT to_regclass($1) AS found", [name]);
    return rows[0].found !== null;
};

describe("migrate script with a migration that fails", () => {
    it("exits with a failure that names the broken migration, and applies nothing after it", { timeout: 30_000 }, async () => {
        await assert.rejects(
            execFileAsync(process.execPath, ["--import", "tsx", path.join(workFolder, "src", "migrate.ts")], {
                cwd: ROOT,
                env: cleanChildEnvironment({ DOTENV_CONFIG_PATH: emptyEnvFile, DOTENV_CONFIG_QUIET: "true" }),
                timeout: 25_000
            }),
            (error: unknown) => {
                assert.ok(isScriptFailure(error), "the script exits with a failure, not a signal or a timeout");
                assert.notEqual(error.code, 0);
                assert.match(error.stderr, /002_broken\.sql/, "it names the migration that failed");
                assert.match(error.stdout, /Applied 001_init\.sql/, "the migration before it was applied");
                assert.doesNotMatch(error.stdout, /Applied 002_broken|Applied 003/);
                return true;
            }
        );

        assert.equal(await tableExists("half_done_probe"), false, "what the broken migration did before failing was rolled back");
        assert.equal(await tableExists("after_probe"), false, "the migration after the broken one was not run");

        const { rows } = await ownerPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["001_init.sql"], "the broken migration was not recorded");
    });

    it("tries the broken migration again on the next run, since it was not recorded", { timeout: 30_000 }, async () => {
        await assert.rejects(
            execFileAsync(process.execPath, ["--import", "tsx", path.join(workFolder, "src", "migrate.ts")], {
                cwd: ROOT,
                env: cleanChildEnvironment({ DOTENV_CONFIG_PATH: emptyEnvFile, DOTENV_CONFIG_QUIET: "true" }),
                timeout: 25_000
            }),
            (error: unknown) => {
                assert.ok(isScriptFailure(error));
                assert.match(error.stderr, /002_broken\.sql/);
                assert.doesNotMatch(error.stdout, /Database is up to date/);
                return true;
            }
        );
    });
});
