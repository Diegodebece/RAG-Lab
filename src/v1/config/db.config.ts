import type { Pool, PoolClient } from "pg";
import { createPool, runInTransaction } from "./pool.config.js";

// The API's own connection, made with the rag_lab_api role: it reads and changes rows and nothing else (see
// migrations/002_api_role.sql). The migration script connects with MIGRATION_DATABASE_URL instead, as the owner, and
// never imports this file: it would refuse to load without DATABASE_URL.
const apiConnectionString = process.env.DATABASE_URL;

// fail at startup instead of on the first request
if (!apiConnectionString) {
    throw new Error("DATABASE_URL is not set");
}

// The longest the API waits for any one query before giving up on it and dropping its connection. Without it, a
// connection that is still open but no longer answers (a network that drops packets, a frozen PostgreSQL) holds
// its request forever. Far above what the API's own queries take; the migration script does not use it.
const API_QUERY_TIMEOUT_MS = 30_000;

// The keys of the advisory locks the API takes (pg_advisory_xact_lock). One number per lock, and none of them is the
// migration script's (72617001, in migrate.ts), which runs against the same database.
export const LOCK_KEYS = {
    // held by the transaction that accepts a document or an index build, so the global caps are counted one request at a time
    indexingQueue: 72617002
} as const;

// One pool for the whole process, as the API role (the migration script makes its own, as the owner and without the
// query timeout).
export const pool = createPool({ connectionString: apiConnectionString, queryTimeoutMs: API_QUERY_TIMEOUT_MS });

// A transaction on the API's pool, or on the pool given.
export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>, targetPool: Pool = pool): Promise<T> =>
    runInTransaction(targetPool, callback);
