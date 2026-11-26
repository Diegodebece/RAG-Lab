import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { startPausableProxy, urlThroughProxy } from "../doubles/pausableProxy.js";

// The database is reached through a proxy that can go silent: the connection stays established, but nothing
// answers, as when a network drops packets or PostgreSQL freezes. Set before the app is imported. The app's
// connection is the API role's, as in production.
const apiDatabaseUrl = process.env.RAG_LAB_TEST_API_DATABASE_URL;
assert.ok(apiDatabaseUrl, "RAG_LAB_TEST_API_DATABASE_URL must be set to run the database tests");

const target = new URL(apiDatabaseUrl);
const proxy = await startPausableProxy({ host: target.hostname, port: Number(target.port || 5432) });
process.env.DATABASE_URL = urlThroughProxy(apiDatabaseUrl, proxy.port);

// every request checks again, so the cache cannot hide the stuck connection
process.env.HEALTH_CACHE_SECONDS = "0";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");

// the request that hangs, so the cleanup can wait for it
let pending: Promise<unknown> = Promise.resolve();

// Without this, the pool would wait for the stuck connection forever and the test process would never exit.
after(async () => {
    await proxy.close();
    await Promise.allSettled([pending]);
    await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The longest a health check may take once the database stops answering. Above the few seconds a probe timeout
// takes (the model server's check gives up after 2), and below the 10 seconds Docker gives a container to stop.
const ANSWER_WITHIN_MS = 6000;

describe("GET /v1/health with a database connection that stops answering", () => {
    it("reports the database as down within a few seconds instead of hanging", { timeout: 20_000 }, async () => {
        // a first healthy request, so the pool holds an open connection that the next check reuses
        const healthy = await request(app).get("/v1/health");
        assert.equal(healthy.status, 200);
        assert.equal(healthy.body.data.database, "up");

        proxy.pause();
        const started = Date.now();
        const check = Promise.resolve(request(app).get("/v1/health"));
        pending = check;

        const outcome = await Promise.race([check, sleep(ANSWER_WITHIN_MS).then(() => "no answer" as const)]);

        assert.notEqual(outcome, "no answer", `the health check did not answer within ${ANSWER_WITHIN_MS} ms`);
        assert.ok(Date.now() - started < ANSWER_WITHIN_MS);

        const response = outcome as Awaited<typeof check>;
        assert.equal(response.status, 200);
        assert.equal(response.body.data.database, "down");
        assert.equal(response.body.data.status, "down");
    });
});
