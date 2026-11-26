import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";

// These tests start the real src/server.ts in a child process, as `npm run dev` does, and look at what it prints,
// how it exits and what it answers.

const ROOT = path.join(import.meta.dirname, "..");
const VALID_SECRET = "test-secret-only-for-these-tests-0123456789";
// nothing listens on port 1: the database is unreachable and the connection is refused at once
const UNREACHABLE_DATABASE_URL = "postgres://rag_lab:wrong@127.0.0.1:1/rag_lab_test";

interface RunningServer {
    port: number;
    child: ChildProcess;
    output: () => { stdout: string; stderr: string };
    exited: Promise<number | null>;
}

const running: RunningServer[] = [];
let emptyEnvDirectory = "";
let emptyEnvFile = "";
let openedPool: Pool | undefined;

before(async () => {
    // an empty .env, so the child process does not read the real one
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-server-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");
});

// Always kills the servers a test started, so a failing test does not leave a process holding the port.
afterEach(() => {
    for (const server of running.splice(0)) {
        server.child.kill();
    }
});

after(async () => {
    await openedPool?.end();
    await rm(emptyEnvDirectory, { recursive: true, force: true });
});

// The database helpers import db.config, which needs DATABASE_URL: load them only in the tests that use the database.
const loadDatabase = async () => {
    const helpers = await import("./db/testDatabase.js");
    const { pool } = await import("../src/v1/config/db.config.js");
    openedPool = pool;
    return { ...helpers, pool };
};

const getFreePort = (): Promise<number> => new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
    });
});

const startServer = async (overrides: Record<string, string | undefined> = {}): Promise<RunningServer> => {
    const port = await getFreePort();
    const env: Record<string, string | undefined> = {
        ...process.env,
        PORT: String(port),
        SECRET_KEY: VALID_SECRET,
        DOTENV_CONFIG_PATH: emptyEnvFile,
        DOTENV_CONFIG_QUIET: "true",
        ...overrides
    };

    for (const name of Object.keys(env)) {
        if (env[name] === undefined) {
            delete env[name];
        }
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
    });
    const server: RunningServer = { port, child, output: () => ({ stdout, stderr }), exited };
    running.push(server);

    return server;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the server to exit, and returns its exit code.
const waitForExit = async (server: RunningServer, timeoutMs = 12_000): Promise<number | null> => {
    const result = await Promise.race([server.exited, sleep(timeoutMs).then(() => "timeout" as const)]);

    assert.notEqual(result, "timeout", `the server did not exit within ${timeoutMs} ms; output: ${JSON.stringify(server.output())}`);
    return result as number | null;
};

// Waits until the server has printed the text, failing early when it exits instead.
const waitForOutput = async (server: RunningServer, text: string, timeoutMs = 12_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let hasExited = false;
    void server.exited.then(() => { hasExited = true; });

    while (!server.output().stdout.includes(text)) {
        assert.ok(!hasExited, `the server exited before printing "${text}"; output: ${JSON.stringify(server.output())}`);
        assert.ok(Date.now() < deadline, `the server did not print "${text}" within ${timeoutMs} ms; output: ${JSON.stringify(server.output())}`);
        await sleep(50);
    }
};

const getHealth = async (server: RunningServer): Promise<{ status: number; body: { data: Record<string, string> } }> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/health`, { signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json() as { data: Record<string, string> } };
};

const allOutput = (server: RunningServer): string => {
    const { stdout, stderr } = server.output();
    return `${stdout}\n${stderr}`;
};

describe("server startup: configuration", () => {
    it("refuses to start without SECRET_KEY", { timeout: 15_000 }, async () => {
        const server = await startServer({ SECRET_KEY: undefined, DATABASE_URL: UNREACHABLE_DATABASE_URL });

        assert.equal(await waitForExit(server), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /SECRET_KEY/);
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("refuses to start with the placeholder SECRET_KEY from .env.example", { timeout: 15_000 }, async () => {
        const server = await startServer({ SECRET_KEY: "change-me", DATABASE_URL: UNREACHABLE_DATABASE_URL });

        assert.equal(await waitForExit(server), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /SECRET_KEY/);
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });
});

describe("server startup: database schema", () => {
    it("refuses to start when the database has a pending migration", { timeout: 15_000 }, async () => {
        const { emptyTestDatabase } = await loadDatabase();
        await emptyTestDatabase();
        const server = await startServer();

        assert.equal(await waitForExit(server), 1);
        assert.match(allOutput(server), /001_init\.sql/, "it names the pending migration");
        assert.match(allOutput(server), /npm run migrate|DATABASE_URL/, "it says what to do");
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("refuses to start when the database has a migration this checkout does not have", { timeout: 15_000 }, async () => {
        const { resetTestDatabase, pool } = await loadDatabase();
        await resetTestDatabase();
        await pool.query("INSERT INTO schema_migrations (version) VALUES ('002_upload_usage.sql')");
        const server = await startServer();

        assert.equal(await waitForExit(server), 1);
        assert.match(allOutput(server), /002_upload_usage\.sql/, "it names the unknown migration");
        assert.match(allOutput(server), /npm run migrate|DATABASE_URL/, "it says what to check");
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("starts when every migration is applied, and reports the database as up", { timeout: 15_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const server = await startServer();

        await waitForOutput(server, "Server running");

        const health = await getHealth(server);
        assert.equal(health.status, 200);
        assert.equal(health.body.data.database, "up");
    });

    it("starts when the database cannot be reached, and health reports it as down", { timeout: 15_000 }, async () => {
        const server = await startServer({ DATABASE_URL: UNREACHABLE_DATABASE_URL });

        await waitForOutput(server, "Server running");

        const health = await getHealth(server);
        assert.equal(health.status, 200);
        assert.equal(health.body.data.database, "down");
    });
});
