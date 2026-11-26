import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { Pool } from "pg";
import { startPausableProxy, urlThroughProxy } from "./doubles/pausableProxy.js";
import type { PausableProxy } from "./doubles/pausableProxy.js";
import { closeServerGracefully } from "../src/shutdown.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startServer = async (handler: RequestListener): Promise<{ server: Server; port: number }> => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
};

// the status code, or the error message when the connection fails
const fetchStatus = (port: number): Promise<string> => new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolve(String(res.statusCode)));
    });
    req.on("error", (error) => resolve(error.message));
});

// every test has a timeout: a shutdown that never finishes fails the test instead of hanging the suite
describe("closeServerGracefully", () => {
    it("lets a request in progress finish before the server closes", { timeout: 10_000 }, async () => {
        const { server, port } = await startServer((req, res) => {
            setTimeout(() => res.end("done"), 300);
        });
        const inProgress = fetchStatus(port);
        await sleep(50);

        await closeServerGracefully(server, () => {}, 5000);

        assert.equal(await inProgress, "200");
    });

    it("ends the event streams and refuses new connections", { timeout: 10_000 }, async () => {
        const { server, port } = await startServer((req, res) => res.end());
        let streamsEnded = false;

        await closeServerGracefully(server, () => {
            streamsEnded = true;
        }, 5000);

        assert.equal(streamsEnded, true);
        assert.match(await fetchStatus(port), /ECONNREFUSED/);
    });

    it("closes a request that outlasts the timeout, so the process can exit", { timeout: 5000 }, async () => {
        // a handler that never answers, like a stream that was not ended
        const { server, port } = await startServer(() => {});
        const stuck = fetchStatus(port);
        await sleep(50);
        const started = Date.now();

        await closeServerGracefully(server, () => {}, 200);

        assert.ok(Date.now() - started < 2000, "it did not wait for the stuck request");
        assert.match(await stuck, /socket hang up|ECONNRESET/);
    });
});

// The pools under test connect as the API role, like the app. The connections are counted as the owner, who can see
// every session's application name (a role sees the details of its own sessions only).
const apiDatabaseUrl = process.env.RAG_LAB_TEST_API_DATABASE_URL;
const ownerDatabaseUrl = process.env.RAG_LAB_TEST_DATABASE_URL;

// The function is loaded inside the tests, so while it does not exist the tests above still run and only these fail.
const loadClosePoolGracefully = async (): Promise<(pool: Pool, timeoutMs: number) => Promise<void>> => {
    const shutdown = await import("../src/shutdown.js");
    assert.equal(typeof shutdown.closePoolGracefully, "function", "src/shutdown.ts must export closePoolGracefully");
    return shutdown.closePoolGracefully;
};

// how many server-side connections carry this application name, seen through a direct connection
// (not the proxy), so it keeps answering when the proxied connection is frozen
const countConnections = async (applicationName: string): Promise<number> => {
    const direct = new pg.Client({ connectionString: ownerDatabaseUrl });
    await direct.connect();
    try {
        const result = await direct.query<{ total: string }>(
            "SELECT count(*) AS total FROM pg_stat_activity WHERE application_name = $1",
            [applicationName]
        );
        return Number(result.rows[0]?.total);
    } finally {
        await direct.end();
    }
};

describe("closePoolGracefully", () => {
    let proxy: PausableProxy;
    const pools: Pool[] = [];

    before(async () => {
        assert.ok(apiDatabaseUrl && ownerDatabaseUrl, "RAG_LAB_TEST_API_DATABASE_URL and RAG_LAB_TEST_DATABASE_URL must be set to run the database tests");
        const target = new URL(apiDatabaseUrl);
        proxy = await startPausableProxy({ host: target.hostname, port: Number(target.port || 5432) });
    });

    // Whatever a failing test leaves behind is destroyed, or the pool would keep the test process alive.
    after(async () => {
        await proxy?.close();
        await Promise.allSettled(pools.map((pool) => pool.end()));
    });

    it("resolves within the timeout and drops the connection when a client is stuck on a frozen database", { timeout: 15_000 }, async () => {
        const closePoolGracefully = await loadClosePoolGracefully();
        const applicationName = `shutdown_stuck_${process.pid}_${Date.now()}`;
        const pool = new pg.Pool({
            connectionString: urlThroughProxy(apiDatabaseUrl as string, proxy.port),
            application_name: applicationName,
            max: 2
        });
        pools.push(pool);

        // a client that is checked out and never released, like a request handler waiting on a frozen database
        const client = await pool.connect();
        // a dropped connection must reach the query below, not crash the process as an unhandled error event
        client.on("error", () => {});
        await client.query("SELECT 1");
        assert.equal(await countConnections(applicationName), 1, "the server sees the pool's connection");

        proxy.pause();
        const stuckQuery = client.query("SELECT 2").then(() => "answered", () => "rejected");

        // 500 ms is the deadline given to the function; 3 s leaves room for a slow machine and is far below
        // the 10 s that Docker gives a container to stop. Nothing is allowed to make it reject.
        const SHUTDOWN_DEADLINE_MS = 500;
        const RESOLVE_WITHIN_MS = 3000;
        const started = Date.now();
        const outcome = await Promise.race([
            closePoolGracefully(pool, SHUTDOWN_DEADLINE_MS).then(() => "resolved" as const, (error: unknown) => error),
            sleep(RESOLVE_WITHIN_MS).then(() => "no answer" as const)
        ]);

        assert.notEqual(outcome, "no answer", `it did not resolve within ${RESOLVE_WITHIN_MS} ms`);
        assert.equal(outcome, "resolved", "a stuck client must not make it reject");
        assert.ok(Date.now() - started >= 400, "it gave the clients about the deadline to finish before giving up");

        // the stuck query was cut, so nothing waits on it
        assert.equal(await Promise.race([stuckQuery, sleep(2000).then(() => "still pending")]), "rejected");

        // the socket was destroyed: the proxy closed its side to the database too, and the server lost the backend
        let remaining = await countConnections(applicationName);
        for (let attempt = 0; attempt < 20 && remaining > 0; attempt++) {
            await sleep(100);
            remaining = await countConnections(applicationName);
        }
        assert.equal(remaining, 0, "the stuck connection is no longer open");
    });

    it("resolves promptly and ends the pool when no client is stuck", { timeout: 15_000 }, async () => {
        const closePoolGracefully = await loadClosePoolGracefully();
        const pool = new pg.Pool({ connectionString: apiDatabaseUrl, max: 2 });
        pools.push(pool);
        await pool.query("SELECT 1");

        // far below the 5 s deadline it is given: with nothing checked out, it must not wait for the deadline
        const started = Date.now();
        const outcome = await Promise.race([
            closePoolGracefully(pool, 5000).then(() => "resolved" as const, (error: unknown) => error),
            sleep(2000).then(() => "no answer" as const)
        ]);

        assert.equal(outcome, "resolved", "it resolves without waiting for the deadline");
        assert.ok(Date.now() - started < 2000);
        assert.equal(pool.ending, true);
        await assert.rejects(pool.query("SELECT 1"), "the pool no longer accepts queries");
    });
});
