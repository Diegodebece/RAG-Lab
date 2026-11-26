import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool, withTransaction } from "../../src/v1/config/db.config.js";
import { closeTestPools, ownerPool, resetTestDatabase } from "./testDatabase.js";

// what a test needs from the spy on client.release: the arguments of each call
interface ReleaseSpy {
    mock: { calls: { arguments: unknown[] }[] };
}

// The transactions run on the app's pool, as the API role. The probe table is made by the owner, after the
// migrations, so it also checks that a table a later layer adds is usable by the API without a new grant.
const countRows = async (): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM tx_probe");
    return Number(rows[0].count);
};

after(closeTestPools);

describe("withTransaction", () => {
    before(async () => {
        await resetTestDatabase();
        await ownerPool.query("CREATE TABLE tx_probe (id integer PRIMARY KEY)");
    });

    // TRUNCATE is a schema-level right the API role does not have
    beforeEach(() => ownerPool.query("TRUNCATE tx_probe"));

    it("commits every query when the callback succeeds", async () => {
        await withTransaction(async (client) => {
            await client.query("INSERT INTO tx_probe (id) VALUES (1)");
            await client.query("INSERT INTO tx_probe (id) VALUES (2)");
        });

        assert.equal(await countRows(), 2);
    });

    it("rolls back every query and rethrows when the callback fails, and keeps the healthy connection", async (t) => {
        let release: ReleaseSpy | undefined;

        await assert.rejects(
            withTransaction(async (client) => {
                release = t.mock.method(client, "release");
                await client.query("INSERT INTO tx_probe (id) VALUES (1)");
                await client.query("INSERT INTO tx_probe (id) VALUES (1)");
            }),
            { code: "23505" }
        );

        assert.equal(await countRows(), 0);
        assert.deepEqual(release?.mock.calls.map((call) => call.arguments), [[false]], "a connection that rolled back fine goes back to the pool");
    });

    it("survives its connection breaking mid-transaction, closes that connection, and reports the original error", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        let release: ReleaseSpy | undefined;

        // another connection ends this one while it runs a query, as a PostgreSQL restart would; the terminating
        // connection is the owner's, because the API role has no business ending connections
        const attempt = withTransaction(async (client) => {
            release = t.mock.method(client, "release");
            const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            await Promise.all([client.query("SELECT pg_sleep(5)"), ownerPool.query("SELECT pg_terminate_backend($1)", [pid])]);
        });

        // 57P01 is "terminating connection due to administrator command": the failed query, not the failed ROLLBACK
        await assert.rejects(attempt, { code: "57P01" });

        // release(true) makes the pool close the connection instead of keeping it. Without it, the broken connection
        // would go back as the most recently released one, and the pool lends the most recently released one first
        // (last in, first out), so the very next query would run on it.
        assert.deepEqual(release?.mock.calls.map((call) => call.arguments), [[true]], "the broken connection is released with release(true)");

        for (let query = 0; query < 3; query++) {
            assert.equal((await pool.query<{ one: number }>("SELECT 1 AS one")).rows[0].one, 1, "the pool still lends working connections");
        }
    });
});
