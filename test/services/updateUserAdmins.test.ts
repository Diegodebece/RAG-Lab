import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeTestPools, ownerPool, resetTestDatabase } from "../db/testDatabase.js";
import { updateUserService } from "../../src/v1/services/users.service.js";
import { AppError } from "../../src/v1/utils/appError.util.js";

// updateUserService(actorId, id, changes): the actor is the admin who asked, id is the account to change. Two admins
// who change each other at the same moment have each been checked as an admin before the other's change was made,
// so the service has to check again, inside the transaction that makes the change, that the actor still is one.
// These tests run the two calls one after the other, which is what the second one sees when it comes second.
const FORBIDDEN = "You do not have permission to perform this action";

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const seed = async (email: string, role: "user" | "admin" = "admin", status: "active" | "disabled" = "active"): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, 'x', $2, $3) RETURNING id",
        [email, role, status]
    );

    return rows[0].id;
};

const rowOf = async (id: string): Promise<{ role: string; status: string; token_version: number }> =>
    (await ownerPool.query<{ role: string; status: string; token_version: number }>("SELECT role, status, token_version FROM users WHERE id = $1", [id])).rows[0];

const forbidden = (error: unknown): boolean => {
    assert.ok(error instanceof AppError, "an AppError, not a database error");
    assert.equal(error.status, 403);
    assert.equal(error.message, FORBIDDEN);
    return true;
};

describe("updateUserService: an actor who stopped being an active admin", () => {
    it("refuses with 403 an admin who was demoted by the other admin a moment earlier, and leaves them an admin", { timeout: 15_000 }, async () => {
        const ana = await seed("ana.admin@example.com");
        const bob = await seed("bob.admin@example.com");

        const first = await updateUserService(ana, bob, { role: "user" });
        assert.equal(first.role, "user");

        await assert.rejects(updateUserService(bob, ana, { role: "user" }), forbidden);

        assert.equal((await rowOf(ana)).role, "admin", "the first admin is still an admin");
        assert.equal((await rowOf(bob)).role, "user");
    });

    it("refuses with 403 an admin who was disabled by the other admin a moment earlier, and leaves them active", { timeout: 15_000 }, async () => {
        const ana = await seed("ana.admin@example.com");
        const bob = await seed("bob.admin@example.com");

        const first = await updateUserService(ana, bob, { status: "disabled" });
        assert.equal(first.status, "disabled");

        await assert.rejects(updateUserService(bob, ana, { status: "disabled" }), forbidden);

        const row = await rowOf(ana);
        assert.deepEqual([row.role, row.status, row.token_version], ["admin", "active", 0], "nothing changed on the first admin");
    });

    it("refuses with 403 a disabled admin who tries to promote someone, and changes nothing", { timeout: 15_000 }, async () => {
        const ana = await seed("ana.admin@example.com", "admin", "disabled");
        const bob = await seed("bob@example.com", "user");

        await assert.rejects(updateUserService(ana, bob, { role: "admin" }), forbidden);

        assert.equal((await rowOf(bob)).role, "user");
    });

    it("refuses with 403 an actor that is a plain user, and changes nothing", { timeout: 15_000 }, async () => {
        const ana = await seed("ana@example.com", "user");
        const bob = await seed("bob@example.com", "user");

        await assert.rejects(updateUserService(ana, bob, { status: "disabled" }), forbidden);

        assert.equal((await rowOf(bob)).status, "active");
    });

    it("refuses with 403 an actor whose account no longer exists, and changes nothing", { timeout: 15_000 }, async () => {
        const bob = await seed("bob@example.com", "user");

        await assert.rejects(updateUserService(randomUUID(), bob, { role: "admin" }), forbidden);

        assert.equal((await rowOf(bob)).role, "user");
    });
});

describe("updateUserService: what keeps working", () => {
    it("lets an active admin promote, demote and disable another account, as before", { timeout: 15_000 }, async () => {
        const ana = await seed("ana.admin@example.com");
        const bob = await seed("bob@example.com", "user");

        assert.equal((await updateUserService(ana, bob, { role: "admin" })).role, "admin");
        assert.equal((await updateUserService(ana, bob, { role: "user", status: "disabled" })).status, "disabled");

        const row = await rowOf(bob);
        assert.deepEqual([row.role, row.status, row.token_version], ["user", "disabled", 1], "disabling raised the token version once");
    });

    it("still answers 409 when an admin changes themselves, and 404 for an account that is not there", { timeout: 15_000 }, async () => {
        const ana = await seed("ana.admin@example.com");

        await assert.rejects(updateUserService(ana, ana, { role: "user" }), { status: 409 });
        await assert.rejects(updateUserService(ana, randomUUID(), { role: "user" }), { status: 404, message: "User not found" });
        await assert.rejects(updateUserService(ana, "not-a-uuid", { role: "user" }), { status: 404, message: "User not found" });

        assert.equal((await rowOf(ana)).role, "admin");
    });
});
