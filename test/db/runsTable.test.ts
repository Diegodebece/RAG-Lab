import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { closeTestPools, ownerPool, resetTestDatabase } from "./testDatabase.js";
import { sha256Of } from "../documentsFixtures.js";

// The runs table (layer 5, migration 009): one row per question that was answered, the record of what ran and the count the
// daily limit of questions reads. Layer 5 stores only retrieval runs. Everything is done as the owner, except what the API role may
// and may not do with it, which is done through the app's own pool on purpose.
const { pool } = await import("../../src/v1/config/db.config.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

const HASH = sha256Of("some invented configuration");
const CONFIGURATION = JSON.stringify({
    kind: "retrieval",
    version: 1,
    settings: { chunkSize: 1000, embeddingModel: "qwen3-embedding:0.6b", retrievalMode: "vector", topK: 3, minScore: 0.3, neighborWindow: 1 }
});

interface Failure {
    code: string;
    message: string;
}

// what the database said when it refused the statement, or undefined when the statement worked
const failureOf = async (run: () => Promise<unknown>): Promise<Failure | undefined> => {
    try {
        await run();
        return undefined;
    } catch (error) {
        const details = error as { code?: string; message?: string };
        return { code: details.code ?? "not a database error", message: details.message ?? "" };
    }
};

const seedUser = async (email: string): Promise<string> => {
    const { rows } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    return rows[0].id;
};

// a complete, valid row for the user; every test changes the column it is about
const validRow = (userId: string): Record<string, unknown> => ({
    user_id: userId,
    kind: "retrieval",
    status: "matched",
    configuration: CONFIGURATION,
    configuration_hash: HASH,
    question_hash: HASH,
    question_characters: 20,
    fragments: "[]",
    embedding_tokens: 5,
    wait_ms: 0.5,
    embedding_ms: 40.25,
    retrieval_ms: 3.1,
    total_ms: 51.7
});

const insertRun = async (row: Record<string, unknown>, queryable: Pool = ownerPool): Promise<string> => {
    const names = Object.keys(row);
    const { rows } = await queryable.query<{ id: string }>(
        `INSERT INTO runs (${names.join(", ")}) VALUES (${names.map((name, index) => (["configuration", "fragments"].includes(name) ? `$${index + 1}::jsonb` : `$${index + 1}`)).join(", ")}) RETURNING id`,
        names.map((name) => row[name])
    );
    return rows[0].id;
};

const refusalOf = async (row: Record<string, unknown>): Promise<string | undefined> => (await failureOf(() => insertRun(row)))?.code;

const count = async (): Promise<number> => (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM runs")).rows[0].count;

// the columns of each index of the table, in the order the index has them
const indexColumnsOf = async (table: string): Promise<string[][]> => {
    const { rows } = await ownerPool.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY k.position) AS columns
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = $1::regclass
         GROUP BY i.indexrelid`,
        [`public.${table}`]
    );
    return rows.map((row) => row.columns);
};

describe("the runs table: its shape", () => {
    it("has the planned columns, with these types, and only profile_id, document_id and index_id optional", async () => {
        const { rows } = await ownerPool.query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' ORDER BY column_name"
        );

        assert.deepEqual(rows, [
            { column_name: "configuration", data_type: "jsonb", is_nullable: "NO" },
            { column_name: "configuration_hash", data_type: "text", is_nullable: "NO" },
            { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
            { column_name: "document_id", data_type: "uuid", is_nullable: "YES" },
            { column_name: "embedding_ms", data_type: "double precision", is_nullable: "NO" },
            { column_name: "embedding_tokens", data_type: "integer", is_nullable: "NO" },
            { column_name: "fragments", data_type: "jsonb", is_nullable: "NO" },
            { column_name: "id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "index_id", data_type: "uuid", is_nullable: "YES" },
            { column_name: "kind", data_type: "text", is_nullable: "NO" },
            { column_name: "profile_id", data_type: "uuid", is_nullable: "YES" },
            { column_name: "question_characters", data_type: "integer", is_nullable: "NO" },
            { column_name: "question_hash", data_type: "text", is_nullable: "NO" },
            { column_name: "retrieval_ms", data_type: "double precision", is_nullable: "NO" },
            { column_name: "status", data_type: "text", is_nullable: "NO" },
            { column_name: "total_ms", data_type: "double precision", is_nullable: "NO" },
            { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
            { column_name: "wait_ms", data_type: "double precision", is_nullable: "NO" }
        ]);
    });

    it("defaults only the id (a generated UUID) and the creation time (now), and nothing else", async () => {
        const { rows } = await ownerPool.query<{ column_name: string; column_default: string | null }>(
            "SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs' AND column_default IS NOT NULL ORDER BY column_name"
        );

        assert.deepEqual(rows.map((row) => row.column_name), ["created_at", "id"], "no other column has a default");
        assert.match(rows[0].column_default ?? "", /now\(\)/);
        assert.match(rows[1].column_default ?? "", /gen_random_uuid\(\)/);

        const userId = await seedUser("ana@example.com");
        const id = await insertRun(validRow(userId));
        const { rows: stored } = await ownerPool.query<{ id: string; created_at: Date }>("SELECT id, created_at FROM runs WHERE id = $1", [id]);

        assert.match(stored[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.ok(Math.abs(Date.now() - stored[0].created_at.getTime()) < 60_000);
    });

    it("stores a valid row with no profile, document or index, and returns its numbers as they were written", async () => {
        const userId = await seedUser("ana@example.com");
        const id = await insertRun(validRow(userId));

        const { rows } = await ownerPool.query("SELECT profile_id, document_id, index_id, embedding_tokens, wait_ms, embedding_ms, retrieval_ms, total_ms, configuration FROM runs WHERE id = $1", [id]);

        assert.deepEqual(rows[0], {
            profile_id: null, document_id: null, index_id: null, embedding_tokens: 5, wait_ms: 0.5, embedding_ms: 40.25, retrieval_ms: 3.1, total_ms: 51.7, configuration: JSON.parse(CONFIGURATION)
        });
    });

    it("has the five indexes: user and creation time, configuration hash, profile, document and index", async () => {
        const indexes = (await indexColumnsOf("runs")).map((columns) => columns.join(","));

        for (const expected of ["user_id,created_at", "configuration_hash", "profile_id", "document_id", "index_id"]) {
            assert.ok(indexes.includes(expected), `an index on ${expected}; the table has ${JSON.stringify(indexes)}`);
        }
    });

    it("refuses a row of a user that does not exist (23503)", async () => {
        assert.equal(await refusalOf(validRow(randomUUID())), "23503");
    });
});

describe("the runs table: what its CHECKs refuse", () => {
    it("refuses a kind that is not retrieval, and a status that is not matched or no_match (23514), and accepts both statuses", async () => {
        const userId = await seedUser("ana@example.com");

        for (const kind of ["answer", "Retrieval", "", "retrieval "]) {
            assert.equal(await refusalOf({ ...validRow(userId), kind, configuration: CONFIGURATION.replace("\"retrieval\"", JSON.stringify(kind)) }), "23514", `kind ${JSON.stringify(kind)}`);
        }

        for (const status of ["error", "Matched", "", "answered"]) {
            assert.equal(await refusalOf({ ...validRow(userId), status }), "23514", `status ${JSON.stringify(status)}`);
        }

        assert.equal(await refusalOf({ ...validRow(userId), status: "matched" }), undefined);
        assert.equal(await refusalOf({ ...validRow(userId), status: "no_match" }), undefined);
        assert.equal(await count(), 2, "only the two valid rows were stored");
    });

    it("refuses a configuration hash and a question hash that are not 64 lowercase hexadecimal digits (23514), and accepts a real SHA-256", async () => {
        const userId = await seedUser("ana@example.com");
        const refused: Record<string, string> = {
            "empty": "",
            "63 digits": HASH.slice(1),
            "65 digits": `${HASH}0`,
            "upper case": HASH.toUpperCase(),
            "not hexadecimal": `${HASH.slice(0, 63)}g`,
            "with spaces around": ` ${HASH.slice(2)} `
        };

        for (const column of ["configuration_hash", "question_hash"]) {
            for (const [label, hash] of Object.entries(refused)) {
                assert.equal(await refusalOf({ ...validRow(userId), [column]: hash }), "23514", `${column}: ${label}`);
            }
        }

        assert.equal(await refusalOf({ ...validRow(userId), configuration_hash: HASH, question_hash: sha256Of("another") }), undefined);
    });

    it("refuses fragments that are not a JSON array (23514), and accepts an empty array and a list of fragments", async () => {
        const userId = await seedUser("ana@example.com");

        for (const fragments of ["{}", "\"text\"", "null", "5", "{\"chunkIndex\": 1}"]) {
            assert.equal(await refusalOf({ ...validRow(userId), fragments }), "23514", fragments);
        }

        assert.equal(await refusalOf({ ...validRow(userId), fragments: "[]" }), undefined);
        assert.equal(await refusalOf({ ...validRow(userId), fragments: "[{\"chunkIndex\": 3, \"retrieval\": \"match\", \"score\": 0.7}, {\"chunkIndex\": 2, \"retrieval\": \"neighbor\"}]" }), undefined);
    });

    it("refuses a configuration that is not a JSON object (23514)", async () => {
        const userId = await seedUser("ana@example.com");

        for (const configuration of ["[]", "\"retrieval\"", "null", "5"]) {
            assert.equal(await refusalOf({ ...validRow(userId), configuration }), "23514", configuration);
        }
    });

    it("refuses a configuration whose kind is not the row's kind (23514)", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await refusalOf({ ...validRow(userId), configuration: JSON.stringify({ kind: "answer", version: 1, settings: {} }) }), "23514", "another kind inside");
        assert.equal(await refusalOf({ ...validRow(userId), configuration: JSON.stringify({ kind: 1, version: 1, settings: {} }) }), "23514", "a kind that is not text");
        assert.equal(await refusalOf({ ...validRow(userId), configuration: CONFIGURATION }), undefined, "the matching one is stored");
    });

    // Added to the plan: a CHECK that compares configuration ->> 'kind' with kind is satisfied when the key is missing, because a
    // comparison with NULL is NULL and a CHECK lets NULL through. A configuration with no kind is not one "whose kind is the row's".
    it("refuses a configuration that has no kind at all (23514)", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await refusalOf({ ...validRow(userId), configuration: JSON.stringify({ version: 1, settings: {} }) }), "23514", "no kind key");
        assert.equal(await refusalOf({ ...validRow(userId), configuration: "{}" }), "23514", "an empty object");
        assert.equal(await count(), 0);
    });

    it("refuses a negative time, NaN, and a time over an hour (23514), in each of the four time columns, and accepts the ends of the range", async () => {
        const userId = await seedUser("ana@example.com");

        for (const column of ["wait_ms", "embedding_ms", "retrieval_ms", "total_ms"]) {
            for (const value of [-0.01, -1, "NaN", 3_600_000.01, 3_600_001, "Infinity", "-Infinity"]) {
                assert.equal(await refusalOf({ ...validRow(userId), [column]: value }), "23514", `${column} = ${String(value)}`);
            }

            assert.equal(await refusalOf({ ...validRow(userId), [column]: 0 }), undefined, `${column} = 0`);
            assert.equal(await refusalOf({ ...validRow(userId), [column]: 3_600_000 }), undefined, `${column} = 3600000`);
        }
    });

    it("refuses a question of 0 or more than 1000 characters (23514), and accepts 1 and 1000", async () => {
        const userId = await seedUser("ana@example.com");

        for (const characters of [0, -1, 1001, 5000]) {
            assert.equal(await refusalOf({ ...validRow(userId), question_characters: characters }), "23514", String(characters));
        }

        assert.equal(await refusalOf({ ...validRow(userId), question_characters: 1 }), undefined);
        assert.equal(await refusalOf({ ...validRow(userId), question_characters: 1000 }), undefined);
    });

    it("refuses a negative number of embedding tokens (23514), and accepts 0", async () => {
        const userId = await seedUser("ana@example.com");

        assert.equal(await refusalOf({ ...validRow(userId), embedding_tokens: -1 }), "23514");
        assert.equal(await refusalOf({ ...validRow(userId), embedding_tokens: 0 }), undefined);
    });
});

describe("the runs table: what the API role may do with it", () => {
    it("may insert and read a run, the way the search does, and the profile, document and index it names are kept as written", async () => {
        const userId = await seedUser("ana@example.com");
        const { rows: documents } = await ownerPool.query<{ id: string }>(
            "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', 'abc', 3, $2) RETURNING id",
            [userId, sha256Of("abc")]
        );
        const { rows: indexes } = await ownerPool.query<{ id: string }>(
            "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'qwen3-embedding:0.6b', 1) RETURNING id",
            [documents[0].id]
        );

        const id = await insertRun({ ...validRow(userId), document_id: documents[0].id, index_id: indexes[0].id }, pool);
        const { rows } = await pool.query<{ document_id: string; index_id: string; status: string }>("SELECT document_id, index_id, status FROM runs WHERE id = $1", [id]);

        assert.deepEqual(rows, [{ document_id: documents[0].id, index_id: indexes[0].id, status: "matched" }]);
    });

    it("is refused every UPDATE and DELETE (42501), also of one column set to itself, so a run cannot be rewritten or given back, and the row is unchanged", async () => {
        const userId = await seedUser("ana@example.com");
        const id = await insertRun(validRow(userId));
        const read = async () => (await ownerPool.query("SELECT * FROM runs WHERE id = $1", [id])).rows;
        const before = await read();
        const statements: Record<string, string> = {
            "UPDATE of the status": `UPDATE runs SET status = 'no_match' WHERE id = '${id}'`,
            "UPDATE of the creation time (the day's count)": `UPDATE runs SET created_at = now() - interval '2 days' WHERE id = '${id}'`,
            "UPDATE of the owner": `UPDATE runs SET user_id = '${randomUUID()}' WHERE id = '${id}'`,
            "UPDATE of fragments": `UPDATE runs SET fragments = '[]'::jsonb WHERE id = '${id}'`,
            "UPDATE of a column set to itself": `UPDATE runs SET status = status WHERE id = '${id}'`,
            "UPDATE of every row": "UPDATE runs SET total_ms = 0",
            "DELETE of one run": `DELETE FROM runs WHERE id = '${id}'`,
            "DELETE of every run": "DELETE FROM runs"
        };

        for (const [label, statement] of Object.entries(statements)) {
            assert.equal((await failureOf(() => pool.query(statement)))?.code, "42501", label);
        }

        assert.deepEqual(await read(), before, "the row is as it was written");
    });

    it("holds exactly SELECT and INSERT on the table, and no right to UPDATE any column of it", async () => {
        const holds = async (privilege: string): Promise<boolean> =>
            (await ownerPool.query<{ held: boolean }>("SELECT has_table_privilege('rag_lab_api', 'public.runs', $1) AS held", [privilege])).rows[0].held;
        const canUpdate = async (column: string): Promise<boolean> =>
            (await ownerPool.query<{ held: boolean }>("SELECT has_column_privilege('rag_lab_api', 'public.runs', $1, 'UPDATE') AS held", [column])).rows[0].held;

        assert.equal(await holds("SELECT"), true);
        assert.equal(await holds("INSERT"), true);

        for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
            assert.equal(await holds(privilege), false, privilege);
        }

        const { rows } = await ownerPool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'runs'");

        for (const { column_name: column } of rows) {
            assert.equal(await canUpdate(column), false, `UPDATE of ${column}`);
        }
    });
});

// The count of the day's questions (round 2, finding F6): one row of question_usage for every embedding that was done for a question,
// written whether or not the run was stored afterwards (a client that hangs up during the embedding still used the model). Like
// index_build_usage (migration 008): written once and only ever counted, and it goes with its user. It is part of migration 009,
// which was not merged yet, so there is no migration of its own.
describe("the question_usage table", () => {
    const usageCount = async (): Promise<number> => (await ownerPool.query<{ count: number }>("SELECT count(*)::int AS count FROM question_usage")).rows[0].count;

    it("has an identity id, the user and the time, and defaults the time to now", async () => {
        const { rows } = await ownerPool.query(
            "SELECT column_name, data_type, is_nullable, is_identity, identity_generation FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'question_usage' ORDER BY column_name"
        );

        assert.deepEqual(rows, [
            { column_name: "id", data_type: "bigint", is_nullable: "NO", is_identity: "YES", identity_generation: "ALWAYS" },
            { column_name: "used_at", data_type: "timestamp with time zone", is_nullable: "NO", is_identity: "NO", identity_generation: null },
            { column_name: "user_id", data_type: "uuid", is_nullable: "NO", is_identity: "NO", identity_generation: null }
        ]);

        const userId = await seedUser("ana@example.com");
        await ownerPool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [userId]);
        const { rows: stored } = await ownerPool.query<{ used_at: Date }>("SELECT used_at FROM question_usage");

        assert.ok(Math.abs(Date.now() - stored[0].used_at.getTime()) < 60_000, "used_at is now");
    });

    it("has an index on the user and the time: the foreign key's, and the daily count's", async () => {
        const indexes = (await indexColumnsOf("question_usage")).map((columns) => columns.join(","));

        assert.ok(indexes.includes("user_id,used_at"), `an index on user_id, used_at; the table has ${JSON.stringify(indexes)}`);
    });

    it("refuses a row of a user that does not exist (23503), and removes the rows of a user, and only theirs, when the user is deleted", async () => {
        assert.equal((await failureOf(() => ownerPool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [randomUUID()])))?.code, "23503");

        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");
        await ownerPool.query("INSERT INTO question_usage (user_id) VALUES ($1), ($1), ($2)", [ana, bob]);

        await ownerPool.query("DELETE FROM users WHERE id = $1", [ana]);

        assert.equal(await usageCount(), 1);
        assert.equal((await ownerPool.query("SELECT 1 FROM question_usage WHERE user_id = $1", [bob])).rowCount, 1, "bob's row is still there");
    });

    it("lets the API role insert and read it, the way the search does", async () => {
        const userId = await seedUser("ana@example.com");

        await pool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [userId]);
        const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM question_usage WHERE user_id = $1 AND used_at > now() - interval '24 hours'", [userId]);

        assert.equal(rows[0].count, 1);
    });

    it("is refused every UPDATE and DELETE by the API role (42501), so a question cannot be given back and the day's count cannot be rewritten, and the row is unchanged", async () => {
        const userId = await seedUser("ana@example.com");
        await ownerPool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [userId]);
        const read = async () => (await ownerPool.query("SELECT * FROM question_usage")).rows;
        const before = await read();
        const statements: Record<string, string> = {
            "UPDATE of the time (the day's count)": "UPDATE question_usage SET used_at = now() - interval '2 days'",
            "UPDATE of the owner": `UPDATE question_usage SET user_id = '${randomUUID()}'`,
            "UPDATE of a column set to itself": "UPDATE question_usage SET user_id = user_id",
            "DELETE of one user's rows": `DELETE FROM question_usage WHERE user_id = '${userId}'`,
            "DELETE of every row": "DELETE FROM question_usage"
        };

        assert.equal(before.length, 1);

        for (const [label, statement] of Object.entries(statements)) {
            assert.equal((await failureOf(() => pool.query(statement)))?.code, "42501", label);
        }

        assert.deepEqual(await read(), before, "the row is as it was written");
    });
});

// The foreign keys of a run set to NULL when what they point at goes: a run is a record and the day's count, and it stays. The
// delete is made by the API role, which has no UPDATE on runs: the action of a foreign key runs with the rights of the table's owner.
describe("the runs table: what happens to a run when what it names is deleted", () => {
    // a user with a profile, a document and an index, and one run that names all three
    const seedEverything = async (email: string) => {
        const userId = await seedUser(email);
        const { rows: profiles } = await ownerPool.query<{ id: string }>("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, 'Mine', 1, '{}'::jsonb) RETURNING id", [userId]);
        const { rows: documents } = await ownerPool.query<{ id: string }>(
            "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'a.txt', $2, 3, $3) RETURNING id",
            [userId, `abc ${email}`, sha256Of(`abc ${email}`)]
        );
        const { rows: indexes } = await ownerPool.query<{ id: string }>(
            "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'qwen3-embedding:0.6b', 1) RETURNING id",
            [documents[0].id]
        );
        const runId = await insertRun({ ...validRow(userId), profile_id: profiles[0].id, document_id: documents[0].id, index_id: indexes[0].id });

        return { userId, profileId: profiles[0].id, documentId: documents[0].id, indexId: indexes[0].id, runId };
    };

    const readLinks = async (runId: string) =>
        (await ownerPool.query<{ profile_id: string | null; document_id: string | null; index_id: string | null }>("SELECT profile_id, document_id, index_id FROM runs WHERE id = $1", [runId])).rows;

    it("sets profile_id to NULL when the API role deletes the profile, and keeps the document and the index", async () => {
        const ana = await seedEverything("ana@example.com");

        await pool.query("DELETE FROM profiles WHERE id = $1", [ana.profileId]);

        assert.deepEqual(await readLinks(ana.runId), [{ profile_id: null, document_id: ana.documentId, index_id: ana.indexId }]);
    });

    it("sets index_id to NULL when the API role deletes the index, and keeps the document and the profile", async () => {
        const ana = await seedEverything("ana@example.com");

        await pool.query("DELETE FROM document_indexes WHERE id = $1", [ana.indexId]);

        assert.deepEqual(await readLinks(ana.runId), [{ profile_id: ana.profileId, document_id: ana.documentId, index_id: null }]);
    });

    it("sets document_id to NULL, and index_id too (the index goes with its document), when the API role deletes the document", async () => {
        const ana = await seedEverything("ana@example.com");

        await pool.query("DELETE FROM documents WHERE id = $1", [ana.documentId]);

        assert.deepEqual(await readLinks(ana.runId), [{ profile_id: ana.profileId, document_id: null, index_id: null }]);
    });

    it("keeps the run itself in every one of those cases: it is still counted", async () => {
        const ana = await seedEverything("ana@example.com");

        await pool.query("DELETE FROM profiles WHERE id = $1", [ana.profileId]);
        await pool.query("DELETE FROM documents WHERE id = $1", [ana.documentId]);

        assert.equal(await count(), 1);
    });

    it("removes the runs of a user, and only theirs, when the user is deleted", async () => {
        const ana = await seedEverything("ana@example.com");
        const bob = await seedEverything("bob@example.com");

        await ownerPool.query("DELETE FROM users WHERE id = $1", [ana.userId]);

        assert.equal(await count(), 1);
        assert.deepEqual((await readLinks(bob.runId)).length, 1, "bob's run is still there");
        assert.equal((await ownerPool.query("SELECT 1 FROM runs WHERE user_id = $1", [ana.userId])).rowCount, 0);
    });
});
