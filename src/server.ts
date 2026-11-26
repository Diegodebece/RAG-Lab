import { app } from "./app.js";
import { closeServerGracefully } from "./shutdown.js";
import { pool } from "./v1/config/db.config.js";
import { getStartupConfigProblems } from "./v1/config/env.config.js";
import { HOST, PORT } from "./v1/config/server.config.js";
import { getMigrationStateService } from "./v1/services/schema.service.js";

// Docker waits 10 seconds after SIGTERM before killing the container
const SHUTDOWN_TIMEOUT_MS = 9_000;

const problems = getStartupConfigProblems(process.env);

if (problems.length > 0) {
    console.error(`Cannot start the server:\n- ${problems.join("\n- ")}`);
    process.exit(1);
}

// Refuses to run against a database whose schema is not this checkout's: pending migrations would fail on the
// first query that needs them, and migrations this checkout does not have mean the wrong database. A database
// that cannot be reached is not a reason to stay down: the API starts and GET /v1/health reports it as down.
const checkDatabaseSchema = async (): Promise<void> => {
    try {
        await pool.query("SELECT 1");
    } catch {
        console.warn("Warning: the database cannot be reached; the API starts and GET /v1/health reports it as down");
        return;
    }

    const { pending, unknown } = await getMigrationStateService();
    const schemaProblems: string[] = [];

    if (pending.length > 0) {
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

const server = app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});

// On docker stop (SIGTERM) or Ctrl+C (SIGINT): let the requests in progress finish, then close the database.
// There are no streams or background work yet.
const shutDown = async (signal: string): Promise<void> => {
    console.log(`${signal} received: finishing the requests in progress`);

    try {
        await closeServerGracefully(server, () => {}, SHUTDOWN_TIMEOUT_MS);
        await pool.end();
        console.log("Server stopped");
        process.exit(0);
    } catch (error) {
        console.error("Could not shut down cleanly", error);
        process.exit(1);
    }
};

process.once("SIGTERM", () => void shutDown("SIGTERM"));
process.once("SIGINT", () => void shutDown("SIGINT"));
