import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool, withTransaction } from "../../src/v1/config/db.config.js";
import { emptyTestDatabase } from "./testDatabase.js";

const countRows = async (): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM tx_probe");
    return Number(rows[0].count);
};

after(() => pool.end());

describe("withTransaction", () => {
    before(async () => {
        await emptyTestDatabase();
        await pool.query("CREATE TABLE tx_probe (id integer PRIMARY KEY)");
    });

    beforeEach(() => pool.query("TRUNCATE tx_probe"));

    it("commits every query when the callback succeeds", async () => {
        await withTransaction(async (client) => {
            await client.query("INSERT INTO tx_probe (id) VALUES (1)");
            await client.query("INSERT INTO tx_probe (id) VALUES (2)");
        });

        assert.equal(await countRows(), 2);
    });

    it("rolls back every query and rethrows when the callback fails", async () => {
        await assert.rejects(
            withTransaction(async (client) => {
                await client.query("INSERT INTO tx_probe (id) VALUES (1)");
                await client.query("INSERT INTO tx_probe (id) VALUES (1)");
            }),
            { code: "23505" }
        );

        assert.equal(await countRows(), 0);
    });

    it("survives its connection breaking mid-transaction, and reports the original error", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});

        // another connection ends this one while it runs a query, as a PostgreSQL restart would
        const attempt = withTransaction(async (client) => {
            const { rows: [{ pid }] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            await Promise.all([client.query("SELECT pg_sleep(5)"), pool.query("SELECT pg_terminate_backend($1)", [pid])]);
        });

        // 57P01 is "terminating connection due to administrator command": the failed query, not the failed ROLLBACK
        await assert.rejects(attempt, { code: "57P01" });

        // more queries than the pool has connections: a broken connection that went back to the pool would show up
        for (let query = 0; query < 12; query++) {
            assert.equal((await pool.query<{ one: number }>("SELECT 1 AS one")).rows[0].one, 1, "the pool still lends working connections");
        }
    });
});
