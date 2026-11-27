import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeTestPools, ownerPool, resetTestDatabase } from "./testDatabase.js";
import { DEFAULT_SETTINGS } from "../configurationFixtures.js";

// The tables of configuration as data: default_profile (one row, written by a migration) and profiles (one row per
// user profile, with only the settings the user set). Everything is done as the owner; what the API role may do with
// them is in apiRole.test.ts.

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

// the SQLSTATE of the refusal, or undefined when the statement worked
const codeOf = async (statement: string, parameters: unknown[] = []): Promise<string | undefined> => {
    try {
        await ownerPool.query(statement, parameters);
        return undefined;
    } catch (error) {
        return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "not a database error";
    }
};

const columnsOf = async (table: string): Promise<{ column_name: string; data_type: string; is_nullable: string }[]> => {
    const { rows } = await ownerPool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
        [table]
    );
    return rows;
};

const seedUser = async (email: string): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    return rows[0].id;
};

const insertProfile = (userId: string, name: string, settings = "{}", version = 1) =>
    ownerPool.query<{ id: string }>(
        "INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
        [userId, name, version, settings]
    );

describe("the default_profile table", () => {
    it("has the columns singleton, version, settings and updated_at, all required, with these types", async () => {
        assert.deepEqual(await columnsOf("default_profile"), [
            { column_name: "settings", data_type: "jsonb", is_nullable: "NO" },
            { column_name: "singleton", data_type: "boolean", is_nullable: "NO" },
            { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "version", data_type: "integer", is_nullable: "NO" }
        ]);
    });

    it("holds exactly one row, at version 1, seeded by the migration", async () => {
        const { rows } = await ownerPool.query<{ singleton: boolean; version: number }>("SELECT singleton, version FROM default_profile");

        assert.deepEqual(rows, [{ singleton: true, version: 1 }]);
    });

    it("has RAG Web's values as its settings, key for key", async () => {
        const { rows } = await ownerPool.query<{ settings: unknown }>("SELECT settings FROM default_profile");

        assert.deepEqual(rows[0].settings, {
            chunkSize: 1000,
            embeddingModel: "qwen3-embedding:0.6b",
            retrievalMode: "vector",
            topK: 3,
            minScore: 0.3,
            neighborWindow: 1,
            smallModel: "qwen3.5:4b",
            temperature: 0,
            maxTokens: 1024,
            answerLanguage: "en",
            answerMode: "baseline"
        });
        assert.deepEqual(rows[0].settings, DEFAULT_SETTINGS);
    });

    it("refuses a second row (23505)", async () => {
        assert.equal(await codeOf("INSERT INTO default_profile (version, settings) VALUES (1, '{}')"), "23505");
        assert.equal((await ownerPool.query("SELECT 1 FROM default_profile")).rowCount, 1);
    });

    it("refuses a row whose singleton is false (23514)", async () => {
        assert.equal(await codeOf("INSERT INTO default_profile (singleton, version, settings) VALUES (false, 1, '{}')"), "23514");
        assert.equal(await codeOf("UPDATE default_profile SET singleton = false"), "23514");
    });

    it("refuses settings that are a list, a string, a number or a JSON null (23514), and a SQL null (23502)", async () => {
        for (const settings of ["[]", "[1]", "\"text\"", "5", "null"]) {
            assert.equal(await codeOf("UPDATE default_profile SET settings = $1::jsonb", [settings]), "23514", settings);
        }

        assert.equal(await codeOf("UPDATE default_profile SET settings = NULL"), "23502");

        const { rows } = await ownerPool.query<{ settings: unknown }>("SELECT settings FROM default_profile");
        assert.deepEqual(rows[0].settings, DEFAULT_SETTINGS, "the row is unchanged");
    });

    it("refuses a version below 1 (23514)", async () => {
        assert.equal(await codeOf("UPDATE default_profile SET version = 0"), "23514");
        assert.equal(await codeOf("UPDATE default_profile SET version = -1"), "23514");
    });
});

describe("the profiles table", () => {
    it("has the columns id, user_id, name, version, settings, created_at and updated_at, with these types", async () => {
        assert.deepEqual(await columnsOf("profiles"), [
            { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "name", data_type: "text", is_nullable: "NO" },
            { column_name: "settings", data_type: "jsonb", is_nullable: "NO" },
            { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "version", data_type: "integer", is_nullable: "NO" }
        ]);
    });

    it("gives a new row a UUID, empty settings and both dates", async () => {
        const userId = await seedUser("ana@example.com");

        const { rows } = await ownerPool.query<{ id: string; settings: unknown; created_at: Date; updated_at: Date }>(
            "INSERT INTO profiles (user_id, name, version) VALUES ($1, 'Mine', 1) RETURNING id, settings, created_at, updated_at",
            [userId]
        );

        assert.match(rows[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.deepEqual(rows[0].settings, {});
        assert.ok(rows[0].created_at instanceof Date);
        assert.ok(rows[0].updated_at instanceof Date);
    });

    it("needs a version (23502): the app writes it, the database does not guess it", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await codeOf("INSERT INTO profiles (user_id, name) VALUES ($1, 'No version')", [userId]), "23502");
    });

    it("refuses two names of one user that differ only in capitalization (23505)", async () => {
        const userId = await seedUser("ana@example.com");
        await insertProfile(userId, "Precise");

        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'PRECISE', 1)", [userId]), "23505");
        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'precise', 1)", [userId]), "23505");
        assert.equal((await ownerPool.query("SELECT 1 FROM profiles")).rowCount, 1);
    });

    it("lets two users have a profile with the same name", async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");

        await insertProfile(ana, "Precise");
        await insertProfile(bob, "Precise");

        assert.equal((await ownerPool.query("SELECT 1 FROM profiles")).rowCount, 2);
    });

    it("refuses an empty name and one of 101 characters (23514), and accepts one of 100", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, '', 1)", [userId]), "23514", "empty");
        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, $2, 1)", [userId, "a".repeat(101)]), "23514", "101 characters");
        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, $2, 1)", [userId, "a".repeat(100)]), undefined, "100 characters");
    });

    it("refuses, on update too, a name that is empty or too long (23514)", async () => {
        const userId = await seedUser("ana@example.com");
        const { rows } = await insertProfile(userId, "Mine");

        assert.equal(await codeOf("UPDATE profiles SET name = '' WHERE id = $1", [rows[0].id]), "23514");
        assert.equal(await codeOf("UPDATE profiles SET name = $2 WHERE id = $1", [rows[0].id, "a".repeat(101)]), "23514");
    });

    it("refuses settings that are not an object, on insert and on update (23514)", async () => {
        const userId = await seedUser("ana@example.com");
        const { rows } = await insertProfile(userId, "Mine");

        for (const settings of ["[]", "[{\"topK\": 3}]", "\"text\"", "5", "true", "null"]) {
            assert.equal(
                await codeOf("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, 1, $3::jsonb)", [userId, `Other ${settings}`, settings]),
                "23514",
                `insert ${settings}`
            );
            assert.equal(await codeOf("UPDATE profiles SET settings = $2::jsonb WHERE id = $1", [rows[0].id, settings]), "23514", `update ${settings}`);
        }

        assert.equal((await ownerPool.query("SELECT 1 FROM profiles")).rowCount, 1, "nothing was stored");
    });

    it("refuses a version below 1, on insert and on update (23514)", async () => {
        const userId = await seedUser("ana@example.com");
        const { rows } = await insertProfile(userId, "Mine");

        for (const version of [0, -1]) {
            assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, $2, $3)", [userId, `Other ${version}`, version]), "23514", `insert ${version}`);
            assert.equal(await codeOf("UPDATE profiles SET version = $2 WHERE id = $1", [rows[0].id, version]), "23514", `update ${version}`);
        }
    });

    it("refuses a profile of a user that does not exist (23503)", async () => {
        assert.equal(await codeOf("INSERT INTO profiles (user_id, name, version) VALUES ($1, 'Orphan', 1)", [randomUUID()]), "23503");
    });

    it("is emptied of a user's profiles when the user is deleted, and keeps the others'", async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        await insertProfile(ana, "One");
        await insertProfile(ana, "Two");
        await insertProfile(bob, "Three");

        await ownerPool.query("DELETE FROM users WHERE id = $1", [ana]);

        const { rows } = await ownerPool.query<{ name: string }>("SELECT name FROM profiles");
        assert.deepEqual(rows, [{ name: "Three" }]);
    });

    it("has an index whose first column is user_id", async () => {
        const { rows } = await ownerPool.query<{ column_name: string }>(`
            SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
            WHERE i.indrelid = 'public.profiles'::regclass
        `);

        assert.ok(rows.some((row) => row.column_name === "user_id"), "an index starts with user_id: the foreign key is indexed");
    });
});
