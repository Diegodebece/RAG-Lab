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
import jwt from "jsonwebtoken";
import { cleanChildEnvironment } from "./childEnvironment.js";
import { SECRET_KEY_PLACEHOLDER } from "./config/placeholder.js";
import { startPausableProxy, urlThroughProxy } from "./doubles/pausableProxy.js";
import type { PausableProxy } from "./doubles/pausableProxy.js";
import { makePasswordHash } from "./routes/testUsers.js";

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

    // The migration script runs with MIGRATION_DATABASE_URL alone, but the API is the API role's: without its URL the
    // server stops at once and says which variable is missing.
    it("refuses to start without DATABASE_URL, even with MIGRATION_DATABASE_URL set", { timeout: 15_000 }, async () => {
        const server = await startServer({ DATABASE_URL: undefined, MIGRATION_DATABASE_URL: UNREACHABLE_DATABASE_URL });

        assert.notEqual(await waitForExit(server, 8_000), 0);
        assert.match(allOutput(server), /DATABASE_URL/, "it names the missing setting");
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

// The configuration is data in the database (layer 3): the default profile every user's settings fall back on, and
// the stored profiles. A default that is missing, or outside the caps the code enforces, would give every question a
// configuration nobody checked, and profiles at another configuration version cannot be read by this code. The server
// stops at startup and says which. Each test tampers as the owner (the API role cannot change default_profile), and
// the database is migrated again afterwards so no later test sees the damage.
describe("server startup: configuration data", () => {
    after(async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
    });

    // The server prints one header and the problems under it, one per line. The sentences are checked whole, in the
    // exact text of the message, and as the only problems: a word like "default" or "version" would also be found in a
    // refusal for any other reason.
    const HEADER = "Cannot start the server: the configuration data in the database is not valid:";

    const expectRefusal = async (problems: string[]): Promise<void> => {
        const server = await startServer();

        assert.equal(await waitForExit(server), 1);
        assert.ok(
            server.output().stderr.includes(`${HEADER}\n- ${problems.join("\n- ")}`),
            `expected the header and exactly these problems: ${JSON.stringify(problems)}; stderr was ${JSON.stringify(server.output().stderr)}`
        );
        assert.doesNotMatch(server.output().stdout, /Server running/);
    };

    it("refuses to start, saying the default profile is missing from its table, when it was deleted", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await ownerPool.query("DELETE FROM default_profile");

        await expectRefusal(["The default profile is missing from the default_profile table"]);
    });

    it("refuses to start, naming the setting and its cap, when a default setting is outside its cap", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '31')");

        await expectRefusal(["Top K must be at most 30"]);
    });

    it("refuses to start, naming both versions, when the default profile is at another configuration version", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await ownerPool.query("UPDATE default_profile SET version = 2");

        await expectRefusal(["The default profile is at configuration version 2, and this server reads version 1"]);
    });

    it("refuses to start, counting them, when stored profiles are at another configuration version", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x') RETURNING id");
        await ownerPool.query("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'Old one', 2), ($1, 'Old two', 3), ($1, 'Current', 1)", [rows[0].id]);

        await expectRefusal(["2 stored profiles are not at configuration version 1"]);
    });

    it("refuses to start, saying 'profile is' for one profile at another configuration version", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x') RETURNING id");
        await ownerPool.query("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'Old one', 2)", [rows[0].id]);

        await expectRefusal(["1 stored profile is not at configuration version 1"]);
    });

    it("refuses to start, listing every problem under the header, when the default and the profiles are both wrong", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x') RETURNING id");
        await ownerPool.query("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'Old one', 2)", [rows[0].id]);
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{topK}', '31')");

        await expectRefusal(["Top K must be at most 30", "1 stored profile is not at configuration version 1"]);
    });

    // the control for the refusals above: the check is not a refusal of every database that has profiles
    it("starts when the stored profiles are at version 1, whatever their settings hold", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x') RETURNING id");
        await ownerPool.query("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, 'Empty', 1, '{}'), ($1, 'Sparse', 1, '{\"topK\": 5}')", [rows[0].id]);

        const server = await startServer();

        await waitForOutput(server, "Server running");
        assert.equal((await getHealth(server)).body.data.database, "up");
    });
});

// The API must run with the least rights it needs: a server whose connection could change the schema, create roles
// or databases, or take over the tables would turn any flaw in a route into a flaw in the whole database. The
// server stops at startup and says which role to use, without printing the URL or the password it was given.
describe("server startup: the database role", () => {
    const PROBE_ROLE = "rag_lab_probe_role";
    // a role the probe role is made a member of, in the test that needs it
    const PARENT_ROLE = "rag_lab_probe_parent_role";

    const dropProbeRole = async (): Promise<void> => {
        const { ownerPool } = await loadDatabase();

        for (const role of [PROBE_ROLE, PARENT_ROLE]) {
            await ownerPool.query(`
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
                        DROP OWNED BY ${role};
                        DROP ROLE ${role};
                    END IF;
                END $$
            `);
        }
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

    // A superuser owns nothing and may hold none of the other attributes: the refusal must still say it is a superuser,
    // so that dropping the superuser check cannot go unnoticed behind the lines of the other checks (a superuser can
    // also create in the public schema, which is a line of its own).
    it("refuses to start when the role is a superuser that owns nothing, and lists the superuser problem", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("SUPERUSER NOCREATEDB NOCREATEROLE");
        const server = await startServer({ DATABASE_URL: url });

        assert.equal(await waitForExit(server), 1);
        assert.match(server.output().stderr, /^- .*superuser/im, "one of the problem lines is the superuser one");
        assert.match(allOutput(server), /rag_lab_api/);
        assert.doesNotMatch(server.output().stdout, /Server running/);
        assert.ok(!allOutput(server).includes(new URL(url).password), "it never prints the password");
    });

    // The checks read what the session is allowed to do, so a session that connects as one role and then acts as another
    // (the connection option role=..., or SET ROLE) could show the checks a harmless role while the rights of the
    // session's own login stay behind it.
    it("refuses to start when the session acts as another role than the one that logged in", { timeout: 25_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await createProbeRole("");
        // the owner may act as the probe role (PostgreSQL 16 and later need the SET option for it)
        await ownerPool.query(`
            DO $$ BEGIN
                IF current_setting('server_version_num')::int >= 160000 THEN
                    EXECUTE format('GRANT %I TO %I WITH SET TRUE', '${PROBE_ROLE}', current_user);
                ELSE
                    EXECUTE format('GRANT %I TO %I', '${PROBE_ROLE}', current_user);
                END IF;
            END $$
        `);

        const ownerUrl = process.env.RAG_LAB_TEST_DATABASE_URL;
        assert.ok(ownerUrl, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");
        const url = `${ownerUrl}${ownerUrl.includes("?") ? "&" : "?"}options=-c%20role%3D${PROBE_ROLE}`;

        await expectRefusal(url, [new URL(ownerUrl).password]);
    });

    it("refuses to start when the role is a member of another role", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("", [`CREATE ROLE ${PARENT_ROLE} NOLOGIN`, `GRANT ${PARENT_ROLE} TO ${PROBE_ROLE}`]);

        await expectRefusal(url, [new URL(url).password]);
    });

    it("refuses to start when the role can create objects in the database", { timeout: 25_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const url = await createProbeRole("", [`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${PROBE_ROLE}', current_database()); END $$`]);

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

// A server that starts while the database cannot be reached still has to check the role and the migrations once the
// database answers: it keeps trying in the background, stops with the same message as at a normal startup when
// something is wrong, and answers 503 on every route that needs the database until the check has passed. The
// database "comes back" when the test starts a proxy on the port the server was given, a port where nothing listened
// before. The server's retry interval must be short enough for the waits below (10 seconds at most).
describe("server startup: a database that cannot be reached at first and comes back", () => {
    const PASSWORD = "correct horse battery staple";
    const UNAVAILABLE = { message: "The database is not available, please try again later" };
    // none of the limits is the subject here, and the tests poll the server
    const RELAXED = { HEALTH_CACHE_SECONDS: "0", AUTHENTICATED_REQUESTS_PER_MINUTE: "100000", REQUESTS_PER_ADDRESS_PER_MINUTE: "100000", LOGINS_PER_15_MINUTES: "100000" };
    const proxies: PausableProxy[] = [];

    afterEach(async () => {
        await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
    });

    const databaseTarget = (): { host: string; port: number } => {
        assert.ok(process.env.RAG_LAB_TEST_DATABASE_URL, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");
        const url = new URL(process.env.RAG_LAB_TEST_DATABASE_URL);

        return { host: url.hostname, port: Number(url.port || 5432) };
    };

    // from now on the port reaches the real test database
    const bringDatabaseBack = async (port: number): Promise<void> => {
        proxies.push(await startPausableProxy(databaseTarget(), port));
    };

    const call = async (server: RunningServer, method: string, route: string, options: { token?: string; body?: object } = {}): Promise<{ status: number; body: unknown }> => {
        const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
            method,
            headers: {
                ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
                ...(options.body ? { "Content-Type": "application/json" } : {})
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(8000)
        });

        return { status: response.status, body: await response.json() as unknown };
    };

    const tokenFor = (userId: string): string =>
        jwt.sign({ sub: userId, ver: 0, iss: "rag-lab", aud: "rag-lab-api" }, VALID_SECRET, { algorithm: "HS256", expiresIn: "1h" });

    const seedAccount = async (): Promise<string> => {
        const { ownerPool } = await loadDatabase();
        const { rows } = await ownerPool.query<{ id: string }>(
            "INSERT INTO users (email, password_hash) VALUES ('ana@example.com', $1) RETURNING id",
            [await makePasswordHash(PASSWORD)]
        );

        return rows[0].id;
    };

    it("starts, answers 503 on the routes that need the database while it is away, and works once it is back", { timeout: 60_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();
        const token = tokenFor(await seedAccount());
        const port = await getFreePort();
        assert.ok(process.env.RAG_LAB_TEST_API_DATABASE_URL, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");
        const server = await startServer({ DATABASE_URL: urlThroughProxy(process.env.RAG_LAB_TEST_API_DATABASE_URL, port), ...RELAXED });

        await waitForOutput(server, "Server running");

        // while the database is away, and for longer than the server takes to try again once
        await sleep(3000);
        assert.equal(server.child.exitCode, null, `the server is still running; output: ${JSON.stringify(server.output())}`);

        const login = await call(server, "POST", "/v1/auth/login", { body: { email: "ana@example.com", password: PASSWORD } });
        assert.equal(login.status, 503, "a login");
        assert.deepEqual(login.body, UNAVAILABLE);

        for (const [method, route] of [["GET", "/v1/users/me"], ["POST", "/v1/auth/logout"], ["GET", "/v1/nothing-here"]] as const) {
            const response = await call(server, method, route, { token });
            assert.equal(response.status, 503, `${method} ${route}`);
            assert.deepEqual(response.body, UNAVAILABLE, `${method} ${route}`);
        }

        const health = await getHealth(server);
        assert.equal(health.status, 200, "the health check keeps answering");
        assert.equal(health.body.data.database, "down");

        // the database comes back: the check passes, and the routes work
        await bringDatabaseBack(port);
        const deadline = Date.now() + 25_000;

        for (;;) {
            assert.equal(server.child.exitCode, null, `the server is still running; output: ${JSON.stringify(server.output())}`);
            const response = await call(server, "GET", "/v1/users/me", { token });

            if (response.status === 200) {
                break;
            }

            assert.equal(response.status, 503, `until the check passes the answer is 503, not ${JSON.stringify(response)}`);
            assert.ok(Date.now() < deadline, `the routes did not start working within 25 seconds; output: ${JSON.stringify(server.output())}`);
            await sleep(300);
        }

        const loggedIn = await call(server, "POST", "/v1/auth/login", { body: { email: "ana@example.com", password: PASSWORD } });
        assert.equal(loggedIn.status, 200);
        assert.equal((await getHealth(server)).body.data.database, "up");
        assert.equal(server.child.exitCode, null, "the server kept running");
    });

    // The owner's URL gets the same refusal as at a normal startup, only later: the check was not skipped because the
    // database happened to be away at that moment.
    it("stops with the message about rag_lab_api when the database comes back and DATABASE_URL is the owner's", { timeout: 60_000 }, async () => {
        const { resetTestDatabase } = await loadDatabase();
        await resetTestDatabase();

        const ownerUrl = process.env.RAG_LAB_TEST_DATABASE_URL;
        assert.ok(ownerUrl, "RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");
        const ownerPassword = new URL(ownerUrl).password;
        assert.ok(ownerPassword, "the owner's test URL has a password");
        const port = await getFreePort();
        const databaseUrl = urlThroughProxy(ownerUrl, port);
        const server = await startServer({ DATABASE_URL: databaseUrl, ...RELAXED });

        await waitForOutput(server, "Server running");
        await bringDatabaseBack(port);

        assert.equal(await waitForExit(server, 20_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(allOutput(server), /rag_lab_api/, "it says which role to use");

        for (const secret of [databaseUrl, ownerUrl, ownerPassword]) {
            assert.ok(!allOutput(server).includes(secret), "it never prints the URL or the password");
        }
    });

    it("stops, naming the migration, when the database comes back with a pending migration", { timeout: 60_000 }, async () => {
        const { emptyTestDatabase } = await loadDatabase();
        await emptyTestDatabase();
        assert.ok(process.env.RAG_LAB_TEST_API_DATABASE_URL, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");
        const port = await getFreePort();
        const server = await startServer({ DATABASE_URL: urlThroughProxy(process.env.RAG_LAB_TEST_API_DATABASE_URL, port), ...RELAXED });

        await waitForOutput(server, "Server running");
        await bringDatabaseBack(port);

        assert.equal(await waitForExit(server, 20_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(allOutput(server), /001_init\.sql/, "it names the pending migration");
        assert.match(allOutput(server), /npm run migrate|DATABASE_URL/, "it says what to do");
    });

    // The configuration check is part of the check that repeats, not only of the first one.
    it("stops, naming the problem, when the database comes back and the default profile is missing", { timeout: 60_000 }, async () => {
        const { resetTestDatabase, ownerPool } = await loadDatabase();
        await resetTestDatabase();
        await ownerPool.query("DELETE FROM default_profile");
        assert.ok(process.env.RAG_LAB_TEST_API_DATABASE_URL, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");
        const port = await getFreePort();
        const server = await startServer({ DATABASE_URL: urlThroughProxy(process.env.RAG_LAB_TEST_API_DATABASE_URL, port), ...RELAXED });

        await waitForOutput(server, "Server running");
        await bringDatabaseBack(port);

        assert.equal(await waitForExit(server, 20_000), 1);
        assert.match(server.output().stderr, /Cannot start the server/);
        assert.match(allOutput(server), /default/i, "it names the problem");
    });

    it("keeps running while the database stays away, however many times it has tried", { timeout: 30_000 }, async () => {
        const server = await startServer({ DATABASE_URL: UNREACHABLE_DATABASE_URL, ...RELAXED });

        await waitForOutput(server, "Server running");
        await sleep(12_000);

        assert.equal(server.child.exitCode, null, `the server is still running; output: ${JSON.stringify(server.output())}`);
        assert.equal((await getHealth(server)).body.data.database, "down");
    });
});
