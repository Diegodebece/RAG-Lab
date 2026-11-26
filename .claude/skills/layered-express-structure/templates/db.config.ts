import pg from "pg";
import type { Pool, PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;

// fail at startup instead of on the first request
if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
}

// The longest the API waits for any one query before giving up on it and dropping its connection. Without it, a
// connection that is still open but no longer answers (a network that drops packets, a frozen PostgreSQL) holds
// its request forever. Far above what the API's own queries take; the migration script does not use it.
const API_QUERY_TIMEOUT_MS = 30_000;

interface PoolOptions {
    // gives up on a query that takes longer than this (milliseconds); no limit when missing
    queryTimeoutMs?: number;
}

// A pool keeps a few connections open and lends one to each query.
// Without a connection timeout, a query waits forever when PostgreSQL is down instead of failing.
// keepAlive makes the operating system probe an idle connection, so a connection that died silently is noticed.
export const createPool = ({ queryTimeoutMs }: PoolOptions = {}): Pool => {
    const newPool = new pg.Pool({
        connectionString,
        connectionTimeoutMillis: 5000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        ...(queryTimeoutMs === undefined ? {} : { query_timeout: queryTimeoutMs })
    });

    // An idle connection can break (for example when PostgreSQL restarts). Without a listener,
    // that "error" event would crash the process; the pool replaces the connection on its own.
    newPool.on("error", (error) => {
        console.error("Unexpected error on an idle PostgreSQL connection", error);
    });

    return newPool;
};

// One pool for the whole process (the migration script makes its own, without the query timeout).
export const pool = createPool({ queryTimeoutMs: API_QUERY_TIMEOUT_MS });

// Runs every query of the callback on one connection, inside one transaction:
// COMMIT when the callback resolves, ROLLBACK when it throws (and the error is rethrown).
export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>, targetPool: Pool = pool): Promise<T> => {
    const client = await targetPool.connect();
    // A connection lent by the pool has no "error" listener of its own: if it broke during the transaction
    // (PostgreSQL restarting, for example), the unhandled event would crash the process. The query that was
    // running fails anyway, and that failure is what the caller gets.
    let broken = false;
    const onError = (error: Error): void => {
        broken = true;
        console.error("A PostgreSQL connection broke during a transaction", error);
    };
    client.on("error", onError);

    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            // the original error says what went wrong; a failed ROLLBACK must not replace it
            broken = true;
            console.error("Could not roll back a transaction", rollbackError);
        }
        throw error;
    } finally {
        client.off("error", onError);
        // a broken connection is closed instead of going back to the pool
        client.release(broken);
    }
};
