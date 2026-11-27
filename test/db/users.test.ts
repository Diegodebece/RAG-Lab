import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeTestPools, ownerPool, resetTestDatabase } from "./testDatabase.js";

// The users table as migration 003 defines it. Everything goes through the owner's pool: these tests are about the
// table's own rules (defaults, checks, the unique index), and what the API role may do is in apiRole.test.ts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

// the SQLSTATE of the error an insert fails with, or "inserted" when it succeeds
const insertOutcome = async (email: string, extra: { role?: unknown; status?: unknown; token_version?: unknown } = {}): Promise<string> => {
    try {
        await ownerPool.query(
            "INSERT INTO users (email, password_hash, role, status, token_version) VALUES ($1, 'x', COALESCE($2, 'user'), COALESCE($3, 'active'), COALESCE($4::integer, 0))",
            [email, extra.role ?? null, extra.status ?? null, extra.token_version ?? null]
        );
        return "inserted";
    } catch (error) {
        return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "not a database error";
    }
};

describe("the users table", () => {
    it("has these columns, all required, with these types", async () => {
        const { rows } = await ownerPool.query<{ column_name: string; data_type: string; is_nullable: string }>(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY column_name"
        );

        assert.deepEqual(rows, [
            { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "email", data_type: "text", is_nullable: "NO" },
            { column_name: "id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "password_hash", data_type: "text", is_nullable: "NO" },
            { column_name: "role", data_type: "text", is_nullable: "NO" },
            { column_name: "status", data_type: "text", is_nullable: "NO" },
            { column_name: "token_version", data_type: "integer", is_nullable: "NO" }
        ]);
    });

    it("gives a new row a UUID, the user role, the active status, token version 0 and the time it was made", async () => {
        const started = Date.now();
        const { rows } = await ownerPool.query<{ id: string; role: string; status: string; token_version: number; created_at: Date }>(
            "INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x') RETURNING id, role, status, token_version, created_at"
        );

        assert.match(rows[0].id, UUID);
        assert.equal(rows[0].role, "user");
        assert.equal(rows[0].status, "active");
        assert.equal(rows[0].token_version, 0);
        assert.ok(Math.abs(rows[0].created_at.getTime() - started) < 60_000, "created_at is now");
    });

    it("gives every row its own id", async () => {
        const { rows } = await ownerPool.query<{ id: string }>(
            "INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'x'), ('b@example.com', 'x') RETURNING id"
        );

        assert.notEqual(rows[0].id, rows[1].id);
    });

    it("accepts both roles, both statuses, and a token version of zero or more", async () => {
        assert.equal(await insertOutcome("admin@example.com", { role: "admin" }), "inserted");
        assert.equal(await insertOutcome("disabled@example.com", { status: "disabled" }), "inserted");
        assert.equal(await insertOutcome("version@example.com", { token_version: 0 }), "inserted");
        assert.equal(await insertOutcome("moved@example.com", { token_version: 41 }), "inserted");
    });
});

describe("the email of a user", () => {
    it("is unique whatever its capitalization (23505)", async () => {
        assert.equal(await insertOutcome("ana@example.com"), "inserted");

        assert.equal(await insertOutcome("ana@example.com"), "23505", "the same email");
        assert.equal(await insertOutcome("Ana@example.com"), "23505", "capital first letter");
        assert.equal(await insertOutcome("ANA@EXAMPLE.COM"), "23505", "all capitals");
        assert.equal(await insertOutcome("bob@example.com"), "inserted", "another email is fine");
    });

    it("is kept unique by a unique index on lower(email), named users_email_unique", async () => {
        const { rows } = await ownerPool.query<{ indexdef: string }>(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_email_unique'"
        );

        assert.equal(rows.length, 1);
        assert.match(rows[0].indexdef, /UNIQUE/i);
        assert.match(rows[0].indexdef, /lower\(\(?email\)?(::text)?\)/i);
    });

    it("can be at most 254 characters (23514 above that)", async () => {
        const emailOf = (length: number): string => `${"a".repeat(length - 12)}@example.com`;

        assert.equal(await insertOutcome(emailOf(254)), "inserted");
        assert.equal(await insertOutcome(emailOf(255)), "23514");
        assert.equal(await insertOutcome(emailOf(5000)), "23514");
    });

    it("cannot be missing, nor can the password hash (23502)", async () => {
        assert.equal(await insertOutcome(null as unknown as string), "23502");

        await assert.rejects(ownerPool.query("INSERT INTO users (email) VALUES ('nohash@example.com')"), { code: "23502" });
    });
});

describe("the role, the status and the token version of a user", () => {
    it("refuse a role outside user and admin (23514), exactly as written", async () => {
        for (const role of ["superadmin", "root", "Admin", "ADMIN", "", " user"]) {
            assert.equal(await insertOutcome(`role-${role.length}-${role.charCodeAt(0) || 0}@example.com`, { role }), "23514", JSON.stringify(role));
        }
    });

    it("refuse a status outside active and disabled (23514), exactly as written", async () => {
        for (const status of ["banned", "inactive", "Active", "DISABLED", "", "active "]) {
            assert.equal(await insertOutcome(`status-${status.length}-${status.charCodeAt(0) || 0}@example.com`, { status }), "23514", JSON.stringify(status));
        }
    });

    it("refuse a negative token version (23514)", async () => {
        assert.equal(await insertOutcome("negative@example.com", { token_version: -1 }), "23514");
    });

    it("refuse the same values when a row is updated, not only when it is inserted", async () => {
        await ownerPool.query("INSERT INTO users (email, password_hash) VALUES ('ana@example.com', 'x')");

        await assert.rejects(ownerPool.query("UPDATE users SET role = 'superadmin'"), { code: "23514" });
        await assert.rejects(ownerPool.query("UPDATE users SET status = 'banned'"), { code: "23514" });
        await assert.rejects(ownerPool.query("UPDATE users SET token_version = -1"), { code: "23514" });
        await assert.rejects(ownerPool.query("UPDATE users SET email = $1", [`${"a".repeat(250)}@example.com`]), { code: "23514" });
    });
});
