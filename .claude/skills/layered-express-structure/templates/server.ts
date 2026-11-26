import { app } from "./app.js";
import { closePoolGracefully, closeServerGracefully } from "./shutdown.js";
import { pool } from "./v1/config/db.config.js";
import { getStartupConfigProblems } from "./v1/config/env.config.js";
import { HOST, PORT } from "./v1/config/server.config.js";
import { getMigrationStateService } from "./v1/services/schema.service.js";
import { isDatabaseUnreachableError } from "./v1/utils/databaseError.util.js";

// Docker waits 10 seconds after SIGTERM before killing the container: the requests in progress get 6 seconds,
// then the database connections get 2 more (a request stuck on a frozen database holds its connection until then).
const SHUTDOWN_TIMEOUT_MS = 6_000;
const POOL_CLOSE_TIMEOUT_MS = 2_000;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const problems = getStartupConfigProblems(process.env);

if (problems.length > 0) {
    console.error(`Cannot start the server:\n- ${problems.join("\n- ")}`);
    process.exit(1);
}

// Refuses to run against a database whose schema is not this checkout's: pending migrations would fail on the
// first query that needs them, and migrations this checkout does not have mean the wrong database. A database
// that cannot be reached is not a reason to stay down: the API starts and GET /v1/health reports it as down.
// A database that answers and refuses (a wrong password, a missing database) will not get better by itself, so
// the server stops and says what is wrong.
const checkDatabaseSchema = async (): Promise<void> => {
    try {
        await pool.query("SELECT 1");
    } catch (error) {
        if (!isDatabaseUnreachableError(error)) {
            console.error(`Cannot start the server: the database refused the connection (${describeError(error)}). Check DATABASE_URL.`);
            process.exit(1);
        }

        console.warn("Warning: the database cannot be reached; the API starts and GET /v1/health reports it as down");
        return;
    }

    const { pending, unknown, foreignTables } = await getMigrationStateService();
    const schemaProblems: string[] = [];

    if (foreignTables.length > 0) {
        schemaProblems.push("The database looks like another project's: it has tables but no schema_migrations table. Check that DATABASE_URL points at the right database.");
    } else if (pending.length > 0) {
        schemaProblems.push(`The database has pending migrations: ${pending.join(", ")}. Run npm run migrate, or check that DATABASE_URL points at the right database.`);
    }

    if (unknown.length > 0) {
        schemaProblems.push(`The database has applied migrations this checkout does not have: ${unknown.join(", ")}. Check that DATABASE_URL points at the right database.`);
    }

    if (schemaProblems.length > 0) {
        console.error(`Cannot start the server:\n- ${schemaProblems.join("\n- ")}`);
        process.exit(1);
    }
};

try {
    await checkDatabaseSchema();
} catch (error) {
    console.error("Cannot start the server: the database schema could not be checked", error);
    process.exit(1);
}

// Express 5 calls the callback with the error when listening fails (the port is in use, for example), so
// "Server running" is only printed when the server really is listening.
const server = app.listen(PORT, HOST, (error?: Error) => {
    if (error) {
        console.error(`Cannot start the server: ${describeError(error)}`);
        process.exit(1);
    }

    console.log(`Server running on http://${HOST}:${PORT}`);
});

// On docker stop (SIGTERM) or Ctrl+C (SIGINT): stop background work, let the requests in progress finish, then
// close the database. Pass a function that ends long-lived responses (event streams), if the API has any.
const shutDown = async (signal: string): Promise<void> => {
    console.log(`${signal} received: finishing the requests in progress`);

    try {
        await closeServerGracefully(server, () => {}, SHUTDOWN_TIMEOUT_MS);
        await closePoolGracefully(pool, POOL_CLOSE_TIMEOUT_MS);
        console.log("Server stopped");
        process.exit(0);
    } catch (error) {
        console.error("Could not shut down cleanly", error);
        process.exit(1);
    }
};

process.once("SIGTERM", () => void shutDown("SIGTERM"));
process.once("SIGINT", () => void shutDown("SIGINT"));
