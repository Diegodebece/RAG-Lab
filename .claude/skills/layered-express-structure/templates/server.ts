import { app } from "./app.js";
import { closePoolGracefully, closeServerGracefully } from "./shutdown.js";
import { pool } from "./v1/config/db.config.js";
import { getStartupConfigProblems } from "./v1/config/env.config.js";
import { HOST, PORT } from "./v1/config/server.config.js";
import { setDatabaseReadyService } from "./v1/services/databaseReadiness.service.js";
import { getDatabaseRoleProblemsService } from "./v1/services/databaseRole.service.js";
import { getMigrationStateService } from "./v1/services/schema.service.js";
import { isDatabaseUnreachableError } from "./v1/utils/databaseError.util.js";

// Docker waits 10 seconds after SIGTERM before killing the container: the requests in progress get 6 seconds,
// then the database connections get 2 more (a request stuck on a frozen database holds its connection until then).
const SHUTDOWN_TIMEOUT_MS = 6_000;
const POOL_CLOSE_TIMEOUT_MS = 2_000;

// how long after a check that found the database unreachable the next one starts
const DATABASE_RETRY_INTERVAL_MS = 3_000;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const problems = getStartupConfigProblems(process.env);

if (problems.length > 0) {
    console.error(`Cannot start the server:\n- ${problems.join("\n- ")}`);
    process.exit(1);
}

let stopping = false;
let retryTimer: NodeJS.Timeout | undefined;

// Refuses to run against a database whose schema is not this checkout's: pending migrations would fail on the
// first query that needs them, and migrations this checkout does not have mean the wrong database.
const checkRoleAndSchema = async (): Promise<void> => {
    // The API runs with the least rights it needs: the role rag_lab_api. A connection that can change the schema, create
    // roles or databases, or own the tables is the owner's, and it must not be the API's. The message names the role
    // to use and never the URL, which has the password in it.
    const roleProblems = await getDatabaseRoleProblemsService();

    if (roleProblems.length > 0) {
        console.error(
            `Cannot start the server: DATABASE_URL must connect as the role rag_lab_api, which has no rights beyond reading and changing rows:\n- ${roleProblems.join("\n- ")}\n`
            + "Create the role with scripts/create-api-role.sql and apply the migrations (see the README)."
        );
        process.exit(1);
    }

    const { pending, unknown, foreignTables } = await getMigrationStateService(pool);
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

// True when the database passed the check; false when it cannot be reached right now. A PostgreSQL that is restarting
// and ends the connection (57P01) counts as unreachable: it comes back, so it is a reason to try again, not to stop.
// A database that answers and refuses (a wrong password, a missing database), a role or a schema that is wrong, or
// any other failure will not get better by itself: the process exits with code 1 and says what is wrong. While the
// server shuts down, a check that fails is not a reason to exit with an error: the shutdown is already on its way.
const checkDatabase = async (): Promise<boolean> => {
    try {
        await pool.query("SELECT 1");
    } catch (error) {
        if (stopping || isDatabaseUnreachableError(error)) {
            return false;
        }

        console.error(`Cannot start the server: the database refused the connection (${describeError(error)}). Check DATABASE_URL.`);
        process.exit(1);
    }

    try {
        await checkRoleAndSchema();
        return true;
    } catch (error) {
        if (stopping || isDatabaseUnreachableError(error)) {
            return false;
        }

        console.error("Cannot start the server: the database schema could not be checked", error);
        process.exit(1);
    }
};

// Repeats the check until it passes, then lets the routes through. The next check starts DATABASE_RETRY_INTERVAL_MS
// after the last one ended, so two never overlap. The timer does not keep the process alive, and shutDown stops it.
const retryDatabaseCheck = (): void => {
    retryTimer = setTimeout(async () => {
        retryTimer = undefined;

        if (await checkDatabase()) {
            setDatabaseReadyService(true);
            console.log("The database answers and passed the check: the API serves requests");
            return;
        }

        if (!stopping) {
            retryDatabaseCheck();
        }
    }, DATABASE_RETRY_INTERVAL_MS);
    retryTimer.unref();
};

// A database that cannot be reached is not a reason to stay down: the API starts, GET /v1/health reports it as down,
// and every other route answers 503 (databaseReadyMiddleware) until a later check has passed.
if (!(await checkDatabase())) {
    setDatabaseReadyService(false);
    console.warn("Warning: the database cannot be reached; the API starts and GET /v1/health reports it as down. The role and the migrations are checked again until the database answers; until then the other routes answer 503");
    retryDatabaseCheck();
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

// On docker stop (SIGTERM) or Ctrl+C (SIGINT): stop the background check, let the requests in progress finish, then
// close the database. Pass a function that ends long-lived responses (event streams), if the API has any.
const shutDown = async (signal: string): Promise<void> => {
    console.log(`${signal} received: finishing the requests in progress`);
    stopping = true;
    clearTimeout(retryTimer);

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
