import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Server as NetServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanChildEnvironment } from "./childEnvironment.js";
import { SECRET_KEY_PLACEHOLDER } from "./config/placeholder.js";

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
let closeDatabasePools: (() => Promise<void>) | undefined;

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
    await closeDatabasePools?.();
    await rm(emptyEnvDirectory, { recursive: true, force: true });
});

// The database helpers import db.config, which needs DATABASE_URL: load them only in the tests that use the database.
// Everything the tests do to the schema goes through the owner's pool (ownerPool); the servers they start connect
// as the API role, because DATABASE_URL is the API's URL in the test process too.
const loadDatabase = async () => {
    const helpers = await import("./db/testDatabase.js");
    closeDatabasePools = helpers.closeTestPools;
    return helpers;
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
    // starts from the test defaults, not from whatever the test process's environment holds
    const env = cleanChildEnvironment({
        PORT: String(port),
        SECRET_KEY: VALID_SECRET,
        DOTENV_CONFIG_PATH: emptyEnvFile,
        DOTENV_CONFIG_QUIET: "true",
        ...overrides
    });

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

    // the placeholder is long enough for the length rule, so only the check for the placeholder itself rejects it
    it("refuses to start with the placeholder SECRET_KEY from .env.example", { timeout: 15_000 }, async () => {
        const server = await startServer({ SECRET_KEY: SECRET_KEY_PLACEHOLDER, DATABASE_URL: UNREACHABLE_DATABASE_URL });

        assert.equal(await waitForExit(server, 8_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /SECRET_KEY/);
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("refuses to start when OLLAMA_BASE_URL is not an http or https address", { timeout: 15_000 }, async () => {
        const server = await startServer({ OLLAMA_BASE_URL: "localhost:11434", DATABASE_URL: UNREACHABLE_DATABASE_URL });

        assert.equal(await waitForExit(server, 8_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /OLLAMA_BASE_URL/);
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("does not take its settings from the test process's own environment", { timeout: 15_000 }, async () => {
        // a value that would stop any server at startup, if the child process inherited it
        const previous = process.env.HEALTH_CACHE_SECONDS;
        process.env.HEALTH_CACHE_SECONDS = "not-a-number";
        let server: RunningServer;

        try {
            server = await startServer({ DATABASE_URL: UNREACHABLE_DATABASE_URL });
        } finally {
            if (previous === undefined) {
                delete process.env.HEALTH_CACHE_SECONDS;
            } else {
                process.env.HEALTH_CACHE_SECONDS = previous;
            }
        }

        await waitForOutput(server, "Server running");
    });
});

describe("server startup: port", () => {
    it("exits with an error when the port is already in use, and never says it is running", { timeout: 15_000 }, async () => {
        const occupant = createServer();
        await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));

        try {
            const { port } = occupant.address() as AddressInfo;
            const server = await startServer({ PORT: String(port), DATABASE_URL: UNREACHABLE_DATABASE_URL });

            assert.equal(await waitForExit(server, 8_000), 1);
            assert.match(server.output().stderr, /Cannot start the server/);
            assert.match(server.output().stderr, /EADDRINUSE|in use/i, "it says why");
            assert.doesNotMatch(server.output().stdout, /Server running/);
        } finally {
            await new Promise<void>((resolve) => {
                occupant.close(() => resolve());
            });
        }
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
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await ownerPool.query("INSERT INTO schema_migrations (version) VALUES ('002_upload_usage.sql')");
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

// The API must run with the least rights it needs: a server whose connection could change the schema, create roles
// or databases, or take over the tables would turn any flaw in a route into a flaw in the whole database. The
// server stops at startup and says which role to use, without printing the URL or the password it was given.
describe("server startup: the database role", () => {
    const PROBE_ROLE = "rag_lab_probe_role";

    const dropProbeRole = async (): Promise<void> => {
        const { ownerPool } = await loadDatabase();
        await ownerPool.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
                    DROP OWNED BY ${PROBE_ROLE};
                    DROP ROLE ${PROBE_ROLE};
                END IF;
            END $$
        `);
    };

    afterEach(dropProbeRole);

    // a role that can log in to the test database and use its schema, like the API role, plus what the test adds
    const createProbeRole = async (attributes: string, extraStatements: string[] = []): Promise<string> => {
        const { ownerPool } = await loadDatabase();
        const password = randomBytes(12).toString("hex");

        await dropProbeRole();
        await ownerPool.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${password}' ${attributes}`);
        await ownerPool.query(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${PROBE_ROLE}', current_database()); END $$`);
        await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
        await ownerPool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);

        for (const statement of extraStatements) {
            await ownerPool.query(statement);
        }

        assert.ok(process.env.RAG_LAB_TEST_API_DATABASE_URL, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");
        const url = new URL(process.env.RAG_LAB_TEST_API_DATABASE_URL);
        url.username = PROBE_ROLE;
        url.password = password;

        return url.toString();
    };

    // every one of these starts as the API role does: on a fully migrated database, so the only thing wrong is the role
    const expectRefusal = async (databaseUrl: string, secrets: string[]): Promise<void> => {
        const server = await startServer({ DATABASE_URL: databaseUrl });

        assert.equal(await waitForExit(server), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(allOutput(server), /rag_lab_api/, "it says which role to use");
        assert.doesNotMatch(server.output().stdout, /Server running/);

        for (const secret of [databaseUrl, ...secrets]) {
            assert.ok(!allOutput(server).includes(secret), "it never prints the URL or the password");
        }
    };

    it("refuses to start when DATABASE_URL connects as the database owner, and says to use rag_lab_api", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();

        const ownerUrl = process.env.RAG_LAB_TEST_DATABASE_URL;
        assert.ok(ownerUrl, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");
        const ownerPassword = new URL(ownerUrl).password;
        assert.ok(ownerPassword, "the owner's test URL has a password");

        await expectRefusal(ownerUrl, [ownerPassword]);
    });

    it("refuses to start when the role can create databases", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("CREATEDB");

        await expectRefusal(url, [new URL(url).password]);
    });

    it("refuses to start when the role can create roles", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("CREATEROLE");

        await expectRefusal(url, [new URL(url).password]);
    });

    it("refuses to start when the role can create objects in the public schema", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("", [`GRANT CREATE ON SCHEMA public TO ${PROBE_ROLE}`]);

        await expectRefusal(url, [new URL(url).password]);
    });

    it("refuses to start when the role owns tables in the public schema", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("", [
            "CREATE TABLE owned_by_the_probe_role (id integer)",
            `ALTER TABLE owned_by_the_probe_role OWNER TO ${PROBE_ROLE}`
        ]);

        await expectRefusal(url, [new URL(url).password]);
    });

    // The control for the refusals above: a role with none of those rights is accepted, so they are refused for what
    // they can do and not because they are not called rag_lab_api.
    it("starts as a role without any of those rights, whatever its name", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("");
        const server = await startServer({ DATABASE_URL: url });

        await waitForOutput(server, "Server running");

        // the role is dropped right after this test: end the server's connections to it first
        server.child.kill();
        await Promise.race([server.exited, sleep(5000)]);
    });
});

// Only a database that cannot be reached is a reason to start anyway (the API reports it as down and recovers
// when it comes back). A database that answers and says no, such as a wrong password or a missing database,
// will not get better by itself: the server must stop and say what is wrong.
describe("server startup: a database that answers with an error", () => {
    const testDatabaseUrl = (): URL => {
        assert.ok(process.env.RAG_LAB_TEST_API_DATABASE_URL, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");
        return new URL(process.env.RAG_LAB_TEST_API_DATABASE_URL);
    };

    const openSockets = new Set<Socket>();
    const fakes: NetServer[] = [];

    // a server that speaks just enough of PostgreSQL's protocol to answer the startup with the given reply
    const startFakePostgres = async (onConnection: (socket: Socket) => void): Promise<number> => {
        const fake = createServer((socket) => {
            openSockets.add(socket);
            socket.on("error", () => {});
            socket.on("close", () => openSockets.delete(socket));
            onConnection(socket);
        });
        fakes.push(fake);
        await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
        return (fake.address() as AddressInfo).port;
    };

    afterEach(async () => {
        for (const socket of openSockets) {
            socket.destroy();
        }
        await Promise.all(fakes.splice(0).map((fake) => new Promise<void>((resolve) => {
            fake.close(() => resolve());
        })));
    });

    // a PostgreSQL ErrorResponse message: 'E', its length, then fields (code letter and text, ending in a zero byte)
    const errorResponse = (sqlState: string, message: string): Buffer => {
        const field = (code: string, value: string): Buffer => Buffer.concat([Buffer.from(code), Buffer.from(value), Buffer.from([0])]);
        const fields = Buffer.concat([field("S", "FATAL"), field("V", "FATAL"), field("C", sqlState), field("M", message), Buffer.from([0])]);
        const header = Buffer.alloc(5);
        header.write("E");
        header.writeInt32BE(fields.length + 4, 1);
        return Buffer.concat([header, fields]);
    };

    it("refuses to start with a wrong password, and names the problem", { timeout: 15_000 }, async () => {
        const url = testDatabaseUrl();
        url.password = "not-the-password";
        const server = await startServer({ DATABASE_URL: url.toString() });

        assert.equal(await waitForExit(server, 8_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /password|authentication|credentials/i, "it says the login was refused");
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    it("refuses to start when the database does not exist, and names the problem", { timeout: 15_000 }, async () => {
        const url = testDatabaseUrl();
        url.pathname = "/rag_lab_database_that_does_not_exist_test";
        const server = await startServer({ DATABASE_URL: url.toString() });

        assert.equal(await waitForExit(server, 8_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(server.output().stderr, /does not exist/i, "it says the database is missing");
        assert.doesNotMatch(server.output().stdout, /Server running/);
    });

    // The next three keep working today and must keep working: they stop the check for "any other failure" from
    // becoming a check that refuses every failure.
    it("still starts, with a warning, when PostgreSQL is starting up (57P03)", { timeout: 15_000 }, async () => {
        const port = await startFakePostgres((socket) => {
            socket.once("data", () => socket.end(errorResponse("57P03", "the database system is starting up")));
        });
        const server = await startServer({ DATABASE_URL: `postgres://rag_lab:secret@127.0.0.1:${port}/rag_lab_test` });

        await waitForOutput(server, "Server running");
        assert.match(server.output().stderr + server.output().stdout, /warning/i, "it warns");
    });

    it("still starts, with a warning, when the database host does not exist", { timeout: 20_000 }, async () => {
        // .invalid never resolves (RFC 2606)
        const server = await startServer({ DATABASE_URL: "postgres://rag_lab:secret@no-such-host.invalid:5432/rag_lab_test" });

        await waitForOutput(server, "Server running", 15_000);
        assert.match(server.output().stderr + server.output().stdout, /warning/i, "it warns");
    });

    it("still starts, with a warning, when the database accepts the connection and never answers", { timeout: 20_000 }, async () => {
        const port = await startFakePostgres(() => {});
        const server = await startServer({ DATABASE_URL: `postgres://rag_lab:secret@127.0.0.1:${port}/rag_lab_test` });

        await waitForOutput(server, "Server running", 15_000);
        assert.match(server.output().stderr + server.output().stdout, /warning/i, "it warns");
    });
});
