import type { Pool, PoolClient } from "pg";
import { createPool, runInTransaction } from "./pool.config.js";

// The API's own connection, made with the low-privilege role (rag_lab_api in RAG Lab): it reads and changes rows and
// nothing else (see the grants migration). The migration script connects with MIGRATION_DATABASE_URL instead, as the
// owner, and never imports this file: it would refuse to load without DATABASE_URL.
const apiConnectionString = process.env.DATABASE_URL;

// fail at startup instead of on the first request
if (!apiConnectionString) {
    throw new Error("DATABASE_URL is not set");
}

// The longest the API waits for any one query before giving up on it and dropping its connection. Without it, a
// connection that is still open but no longer answers (a network that drops packets, a frozen PostgreSQL) holds
// its request forever. Far above what the API's own queries take; the migration script does not use it.
const API_QUERY_TIMEOUT_MS = 30_000;

// One pool for the whole process, as the API role (the migration script makes its own, as the owner and without the
// query timeout).
export const pool = createPool({ connectionString: apiConnectionString, queryTimeoutMs: API_QUERY_TIMEOUT_MS });

// A transaction on the API's pool, or on the pool given.
export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>, targetPool: Pool = pool): Promise<T> =>
    runInTransaction(targetPool, callback);
