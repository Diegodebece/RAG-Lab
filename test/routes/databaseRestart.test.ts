import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// PostgreSQL restarting (or an administrator ending a session) while a request is in progress: the connection the
// request holds is ended by the server with "terminating connection due to administrator command" (57P01), not
// refused. The client is told to try again, as for a database that cannot be reached.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");

const UNAVAILABLE = { message: "The database is not available, please try again later" };

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The process ids of the sessions that are waiting for a lock: here, only the API's request that waits for the row
// the test holds. pg_locks is readable by every role, unlike the activity of other roles' sessions.
const waitingBackends = async (): Promise<number[]> => {
    const { rows } = await ownerPool.query<{ pid: number }>("SELECT DISTINCT pid FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()");
    return rows.map((row) => row.pid);
};

describe("a database connection that PostgreSQL ends during a request", () => {
    it("answers 503 with the usual body when the backend of a blocked admin request is terminated", { timeout: 40_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const target = await createTestUser({ email: "ana@example.com" });

        // the owner holds the row of the account the admin is about to change, so the API's request waits for it
        const holder = await ownerPool.connect();

        try {
            await holder.query("BEGIN");
            await holder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [target.id]);

            const pending = (async () => await request(app).patch(`/v1/users/${target.id}`).set(...admin.auth).send({ status: "disabled" }))();

            let blocked: number[] = [];
            const deadline = Date.now() + 10_000;
            while (blocked.length === 0 && Date.now() < deadline) {
                await sleep(50);
                blocked = await waitingBackends();
            }
            assert.ok(blocked.length > 0, "the API's request is waiting for the row lock");

            for (const pid of blocked) {
                await ownerPool.query("SELECT pg_terminate_backend($1)", [pid]);
            }

            // the timer is cleared once the request is answered, so it does not hold the process open
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), 15_000);
            });
            const response = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));

            assert.notEqual(response, "timeout", "the request was answered after its connection was ended");
            if (response === "timeout") {
                return;
            }
            assert.equal(response.status, 503);
            assert.deepEqual(response.body, UNAVAILABLE);
        } finally {
            await holder.query("ROLLBACK");
            holder.release();
        }

        // the account was not changed, and the API serves the next request on a new connection
        const { rows } = await ownerPool.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [target.id]);
        assert.equal(rows[0].status, "active");
        assert.equal((await request(app).get("/v1/users/me").set(...admin.auth)).status, 200);
    });
});
