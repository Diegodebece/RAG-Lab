import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";
import { pool } from "../../src/v1/config/db.config.js";
import { closeTestPools, emptyTestDatabase, ownerPool, resetTestDatabase } from "./testDatabase.js";

const execFileAsync = promisify(execFile);

// The API runs as rag_lab_api, a role that can read and write the data and can do nothing else: no schema changes,
// no TRUNCATE, no new tables, no roles. Migration 002 gives it exactly that, and these tests check it the way a
// flaw in the API would use it: by trying.
//
// The rights are read as the owner. Without USAGE on the schema, to_regclass answers NULL and information_schema
// hides the tables from the API role, so an inspection through its own pool can pass while checking nothing; and
// has_table_privilege with a list of privileges is true when any one is held, so each privilege is asked alone.
const API_ROLE = "rag_lab_api";
const ROOT = path.join(import.meta.dirname, "..", "..");

before(resetTestDatabase);

after(closeTestPools);

const publicTables = async (): Promise<string[]> => {
    const { rows } = await ownerPool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    return rows.map((row) => row.tablename);
};

const holds = async (table: string, privilege: string): Promise<boolean> => {
    const { rows } = await ownerPool.query<{ held: boolean }>(
        "SELECT has_table_privilege($1::name, format('public.%I', $2::text), $3::text) AS held",
        [API_ROLE, table, privilege]
    );
    return rows[0].held;
};

// the privileges the API role holds on a table, each asked on its own
const privilegesOn = async (table: string): Promise<string[]> => {
    const held: string[] = [];

    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        if (await holds(table, privilege)) {
            held.push(privilege);
        }
    }

    return held;
};

// what the API role gets when it tries to change the schema: the SQLSTATE of the refusal
const failureCodeOf = async (statement: string): Promise<string | undefined> => {
    try {
        await pool.query(statement);
        return undefined;
    } catch (error) {
        return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "not a database error";
    }
};

// whether the role may update one column of a table: has_column_privilege is also true when the whole table can be updated
const canUpdateColumn = async (table: string, column: string): Promise<boolean> => {
    const { rows } = await ownerPool.query<{ held: boolean }>(
        "SELECT has_column_privilege($1::name, format('public.%I', $2::text), $3::text, 'UPDATE') AS held",
        [API_ROLE, table, column]
    );
    return rows[0].held;
};

// the columns of profiles the service changes: the name, the settings, the version and the date
const UPDATABLE_PROFILE_COLUMNS = ["name", "settings", "updated_at", "version"];
const FIXED_PROFILE_COLUMNS = ["created_at", "id", "user_id"];

// The tables of layer 4 and what the services change in them. A document is written once and never changed (not even to
// move it to another user), an index changes only as its build goes on, a chunk gets its vector and nothing else, and a
// usage row is written once and only ever counted. The columns are listed in alphabetical order, as the database lists them.
const UPDATABLE_INDEX_COLUMNS = ["attempts", "embedded_count", "embedding_tokens", "error", "finished_at", "queued_at", "started_at", "status"];
const FIXED_INDEX_COLUMNS = ["chunk_count", "chunk_size", "created_at", "document_id", "embedding_model", "id"];
const DOCUMENT_COLUMNS = ["character_count", "content_hash", "created_at", "filename", "id", "text", "user_id"];
const CHUNK_COLUMNS = ["chunk_index", "embedding", "index_id", "text"];
const USAGE_COLUMNS = ["accepted_at", "id", "user_id"];
// The count of the day's questions (layer 5, round 2): written once for every embedding done for a question, and only ever counted.
const QUESTION_USAGE_COLUMNS = ["id", "used_at", "user_id"];
// The table of layer 5: a run is written once, by the search, and never changed or given back. The columns, in alphabetical order.
const RUN_COLUMNS = [
    "configuration", "configuration_hash", "created_at", "document_id", "embedding_ms", "embedding_tokens", "fragments", "id", "index_id", "kind",
    "profile_id", "question_characters", "question_hash", "retrieval_ms", "status", "total_ms", "user_id", "wait_ms"
];

// the columns of a table the API role may update, in alphabetical order, and the columns the table has
const updatableColumnsOf = async (table: string): Promise<{ all: string[]; updatable: string[] }> => {
    const { rows } = await ownerPool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
        [table]
    );
    const updatable: string[] = [];

    for (const { column_name: column } of rows) {
        if (await canUpdateColumn(table, column)) {
            updatable.push(column);
        }
    }

    return { all: rows.map((row) => row.column_name), updatable };
};

interface DocumentProbe {
    userId: string;
    documentId: string;
    indexId: string;
}

// A user with a document, an index of two chunks and a usage row, made the way the API makes them (as the API role).
const makeDocumentProbe = async (email: string): Promise<DocumentProbe> => {
    const { rows: users } = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);
    const userId = users[0].id;
    const { rows: documents } = await pool.query<{ id: string }>(
        "INSERT INTO documents (user_id, filename, text, character_count, content_hash) VALUES ($1, 'probe.txt', 'probe text', 10, repeat('a', 64)) RETURNING id",
        [userId]
    );
    const { rows: indexes } = await pool.query<{ id: string }>(
        "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 1000, 'probe-model:1', 2) RETURNING id",
        [documents[0].id]
    );
    await pool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'one'), ($1, 1, 'two')", [indexes[0].id]);
    await pool.query("INSERT INTO index_build_usage (user_id) VALUES ($1)", [userId]);

    return { userId, documentId: documents[0].id, indexId: indexes[0].id };
};

// every row of the probe's four tables, as the owner reads them: a refused statement must leave all of it as it was
const readProbe = async (probe: DocumentProbe): Promise<unknown[]> => [
    (await ownerPool.query("SELECT * FROM documents WHERE id = $1", [probe.documentId])).rows,
    (await ownerPool.query("SELECT * FROM document_indexes WHERE id = $1", [probe.indexId])).rows,
    (await ownerPool.query("SELECT index_id, chunk_index, text, embedding::text AS embedding FROM chunks WHERE index_id = $1 ORDER BY chunk_index", [probe.indexId])).rows,
    (await ownerPool.query("SELECT * FROM index_build_usage WHERE user_id = $1", [probe.userId])).rows
];

// the tables of layers 4 and 5, each with rights of its own
const NEW_TABLES = ["documents", "document_indexes", "chunks", "index_build_usage", "runs", "question_usage"];

const checkTheRights = (): void => {
    it("holds SELECT, INSERT, UPDATE and DELETE on every table of the schema except schema_migrations, default_profile, profiles and the tables of documents, indexes and runs, and nothing more", async () => {
        const tables = (await publicTables()).filter((table) => !["schema_migrations", "default_profile", "profiles", ...NEW_TABLES].includes(table));

        assert.ok(tables.includes("users"), "the users table is among them");

        for (const table of tables) {
            assert.deepEqual(await privilegesOn(table), ["SELECT", "INSERT", "UPDATE", "DELETE"], table);
        }
    });

    // a profile belongs to the user who made it for as long as it exists, and its id and creation date never change: the
    // role may change only the columns the service changes, so a flaw in a route cannot hand a profile to another user
    it("holds SELECT, INSERT and DELETE on profiles as a whole, and UPDATE only on some of its columns (which is not UPDATE on the table)", async () => {
        assert.deepEqual(await privilegesOn("profiles"), ["SELECT", "INSERT", "DELETE"]);
    });

    it("may update name, settings, version and updated_at of profiles, and not id, user_id or created_at", async () => {
        for (const column of UPDATABLE_PROFILE_COLUMNS) {
            assert.equal(await canUpdateColumn("profiles", column), true, `${column} can be updated`);
        }

        for (const column of FIXED_PROFILE_COLUMNS) {
            assert.equal(await canUpdateColumn("profiles", column), false, `${column} cannot be updated`);
        }
    });

    it("may update no column of profiles besides those four, so a column added later is a decision and not an accident", async () => {
        const { rows } = await ownerPool.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' ORDER BY column_name"
        );
        const updatable: string[] = [];

        for (const { column_name: column } of rows) {
            if (await canUpdateColumn("profiles", column)) {
                updatable.push(column);
            }
        }

        assert.deepEqual(rows.map((row) => row.column_name).sort(), [...UPDATABLE_PROFILE_COLUMNS, ...FIXED_PROFILE_COLUMNS].sort(), "the columns the test knows");
        assert.deepEqual(updatable, UPDATABLE_PROFILE_COLUMNS);
    });

    it("is refused an UPDATE of the id, the owner or the creation date of a profile (42501), also next to a column it may change, and the row is unchanged", async () => {
        const { rows: users } = await pool.query<{ id: string }>(
            "INSERT INTO users (email, password_hash) VALUES ('owner.probe@example.com', 'x'), ('thief.probe@example.com', 'x') RETURNING id"
        );
        const [ownerId, thiefId] = users.map((user) => user.id);

        try {
            const { rows: created } = await pool.query<{ id: string }>(
                "INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, 'Probe', 1, '{}'::jsonb) RETURNING id",
                [ownerId]
            );
            const id = created[0].id;
            const read = async () => (await ownerPool.query("SELECT id, user_id, name, version, settings, created_at, updated_at FROM profiles WHERE user_id = ANY($1::uuid[])", [[ownerId, thiefId]])).rows;
            const before = await read();

            assert.equal(before.length, 1);
            assert.equal(before[0].user_id, ownerId);

            const statements: Record<string, string> = {
                "user_id": `UPDATE profiles SET user_id = '${thiefId}' WHERE id = '${id}'`,
                "user_id of every row": `UPDATE profiles SET user_id = '${thiefId}'`,
                "id": `UPDATE profiles SET id = gen_random_uuid() WHERE id = '${id}'`,
                "created_at": `UPDATE profiles SET created_at = now() WHERE id = '${id}'`,
                "name together with user_id": `UPDATE profiles SET name = 'Seized', user_id = '${thiefId}' WHERE id = '${id}'`,
                "user_id set to itself": `UPDATE profiles SET user_id = user_id WHERE id = '${id}'`
            };

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await read(), before, "the row is as it was, the name included");
        } finally {
            await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ownerId, thiefId]]);
        }
    });

    it("still does what the profile service does: updates name, settings, version and updated_at, with the owner in the WHERE and a RETURNING", async () => {
        const { rows: users } = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('service.probe@example.com', 'x') RETURNING id");
        const userId = users[0].id;

        try {
            const { rows: created } = await pool.query<{ id: string }>(
                "INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, 'Probe', 1, '{\"topK\": 5}'::jsonb) RETURNING id",
                [userId]
            );
            const id = created[0].id;

            const { rows } = await pool.query<{ id: string; name: string; settings: object; updatedAt: Date }>(
                `UPDATE profiles SET
                     name = COALESCE($3::text, name),
                     settings = COALESCE($4::jsonb, settings),
                     version = $5,
                     updated_at = now()
                 WHERE id = $1 AND user_id = $2
                 RETURNING id, name, settings, updated_at AS "updatedAt"`,
                [id, userId, "Renamed", "{\"topK\": 9}", 1]
            );

            assert.equal(rows.length, 1);
            assert.equal(rows[0].id, id);
            assert.equal(rows[0].name, "Renamed");
            assert.deepEqual(rows[0].settings, { topK: 9 });
        } finally {
            await pool.query("DELETE FROM users WHERE id = $1", [userId]);
        }
    });

    it("holds SELECT, INSERT and DELETE on documents, and no UPDATE on any column of it", async () => {
        assert.deepEqual(await privilegesOn("documents"), ["SELECT", "INSERT", "DELETE"]);
        assert.deepEqual(await updatableColumnsOf("documents"), { all: DOCUMENT_COLUMNS, updatable: [] });
    });

    it("holds SELECT, INSERT and DELETE on document_indexes as a whole, and UPDATE on exactly the eight columns a build changes", async () => {
        assert.deepEqual(await privilegesOn("document_indexes"), ["SELECT", "INSERT", "DELETE"]);

        const { all, updatable } = await updatableColumnsOf("document_indexes");

        assert.deepEqual(all, [...UPDATABLE_INDEX_COLUMNS, ...FIXED_INDEX_COLUMNS].sort(), "the columns the test knows: a column added later is a decision and not an accident");
        assert.deepEqual(updatable, UPDATABLE_INDEX_COLUMNS);
    });

    it("holds SELECT and INSERT on chunks as a whole, and UPDATE on the embedding column only", async () => {
        assert.deepEqual(await privilegesOn("chunks"), ["SELECT", "INSERT"]);
        assert.deepEqual(await updatableColumnsOf("chunks"), { all: CHUNK_COLUMNS, updatable: ["embedding"] });
    });

    it("holds only SELECT and INSERT on index_build_usage, and no UPDATE on any column of it", async () => {
        assert.deepEqual(await privilegesOn("index_build_usage"), ["SELECT", "INSERT"]);
        assert.deepEqual(await updatableColumnsOf("index_build_usage"), { all: USAGE_COLUMNS, updatable: [] });
    });

    it("holds only SELECT and INSERT on runs, and no UPDATE on any column of it", async () => {
        assert.deepEqual(await privilegesOn("runs"), ["SELECT", "INSERT"]);
        assert.deepEqual(await updatableColumnsOf("runs"), { all: RUN_COLUMNS, updatable: [] });
    });

    it("holds only SELECT and INSERT on question_usage, and no UPDATE on any column of it", async () => {
        assert.deepEqual(await privilegesOn("question_usage"), ["SELECT", "INSERT"]);
        assert.deepEqual(await updatableColumnsOf("question_usage"), { all: QUESTION_USAGE_COLUMNS, updatable: [] });
    });

    it("is refused UPDATE and DELETE on question_usage (42501), so a question cannot be given back, and the rows are unchanged", async () => {
        const { rows: users } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('question.usage.probe@example.com', 'x') RETURNING id");
        const userId = users[0].id;

        try {
            await pool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [userId]);
            const read = async () => (await ownerPool.query("SELECT * FROM question_usage WHERE user_id = $1", [userId])).rows;
            const before = await read();
            const statements: Record<string, string> = {
                "UPDATE of used_at": `UPDATE question_usage SET used_at = now() - interval '2 days' WHERE user_id = '${userId}'`,
                "UPDATE of user_id": "UPDATE question_usage SET user_id = user_id",
                "DELETE of one user's rows": `DELETE FROM question_usage WHERE user_id = '${userId}'`,
                "DELETE of every row": "DELETE FROM question_usage"
            };

            assert.equal(before.length, 1);

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await read(), before, "the rows are as they were");
        } finally {
            await ownerPool.query("DELETE FROM users WHERE id = $1", [userId]);
        }
    });

    it("is refused UPDATE and DELETE on runs (42501), so a question cannot be given back and the day's count cannot be rewritten, and the rows are unchanged", async () => {
        const { rows: users } = await ownerPool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('runs.probe@example.com', 'x') RETURNING id");
        const userId = users[0].id;

        try {
            await ownerPool.query(
                `INSERT INTO runs (user_id, kind, status, configuration, configuration_hash, question_hash, question_characters, fragments, embedding_tokens, wait_ms, embedding_ms, retrieval_ms, total_ms)
                 VALUES ($1, 'retrieval', 'matched', '{"kind": "retrieval"}'::jsonb, repeat('a', 64), repeat('b', 64), 5, '[]'::jsonb, 1, 0, 0, 0, 0)`,
                [userId]
            );
            const read = async () => (await ownerPool.query("SELECT * FROM runs WHERE user_id = $1", [userId])).rows;
            const before = await read();
            const statements: Record<string, string> = {
                "UPDATE of created_at": `UPDATE runs SET created_at = now() - interval '2 days' WHERE user_id = '${userId}'`,
                "UPDATE of status": `UPDATE runs SET status = 'no_match' WHERE user_id = '${userId}'`,
                "UPDATE of user_id": "UPDATE runs SET user_id = user_id",
                "DELETE of one user's runs": `DELETE FROM runs WHERE user_id = '${userId}'`,
                "DELETE of every run": "DELETE FROM runs"
            };

            assert.equal(before.length, 1);

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await read(), before, "the rows are as they were");
        } finally {
            await ownerPool.query("DELETE FROM users WHERE id = $1", [userId]);
        }
    });

    it("is refused an UPDATE of any column of documents (42501), the owner included, and the rows are unchanged", async () => {
        const probe = await makeDocumentProbe("update.documents.probe@example.com");
        const other = await makeDocumentProbe("update.documents.other@example.com");

        try {
            const before = await readProbe(probe);
            const statements: Record<string, string> = {
                "user_id": `UPDATE documents SET user_id = '${other.userId}' WHERE id = '${probe.documentId}'`,
                "user_id of every row": `UPDATE documents SET user_id = '${other.userId}'`,
                "text": `UPDATE documents SET text = 'rewritten' WHERE id = '${probe.documentId}'`,
                "filename": `UPDATE documents SET filename = 'renamed.txt' WHERE id = '${probe.documentId}'`,
                "content_hash": `UPDATE documents SET content_hash = repeat('b', 64) WHERE id = '${probe.documentId}'`,
                "character_count": `UPDATE documents SET character_count = 99 WHERE id = '${probe.documentId}'`,
                "a column set to itself": `UPDATE documents SET text = text WHERE id = '${probe.documentId}'`
            };

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await readProbe(probe), before, "the rows are as they were");
        } finally {
            await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[probe.userId, other.userId]]);
        }
    });

    it("is refused an UPDATE of the document, the size, the model, the chunk count, the id or the creation date of an index (42501), also next to a column it may change", async () => {
        const probe = await makeDocumentProbe("update.index.probe@example.com");
        const other = await makeDocumentProbe("update.index.other@example.com");

        try {
            const before = await readProbe(probe);
            const where = `WHERE id = '${probe.indexId}'`;
            const statements: Record<string, string> = {
                "document_id": `UPDATE document_indexes SET document_id = '${other.documentId}' ${where}`,
                "chunk_size": `UPDATE document_indexes SET chunk_size = 500 ${where}`,
                "embedding_model": `UPDATE document_indexes SET embedding_model = 'other-model:1' ${where}`,
                "chunk_count": `UPDATE document_indexes SET chunk_count = 5 ${where}`,
                "id": `UPDATE document_indexes SET id = gen_random_uuid() ${where}`,
                "created_at": `UPDATE document_indexes SET created_at = now() ${where}`,
                "chunk_size together with status": `UPDATE document_indexes SET status = 'indexing', chunk_size = 500 ${where}`,
                "document_id set to itself": `UPDATE document_indexes SET document_id = document_id ${where}`
            };

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await readProbe(probe), before, "the rows are as they were, the status included");
        } finally {
            await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[probe.userId, other.userId]]);
        }
    });

    it("is refused an UPDATE of the text, the number or the index of a chunk, and a DELETE of chunks (42501), and the chunks are unchanged", async () => {
        const probe = await makeDocumentProbe("update.chunks.probe@example.com");
        const other = await makeDocumentProbe("update.chunks.other@example.com");

        try {
            const before = await readProbe(probe);
            const statements: Record<string, string> = {
                "text": `UPDATE chunks SET text = 'rewritten' WHERE index_id = '${probe.indexId}'`,
                "chunk_index": `UPDATE chunks SET chunk_index = chunk_index + 10 WHERE index_id = '${probe.indexId}'`,
                "index_id": `UPDATE chunks SET index_id = '${other.indexId}' WHERE index_id = '${probe.indexId}'`,
                "text together with embedding": `UPDATE chunks SET embedding = embedding, text = 'rewritten' WHERE index_id = '${probe.indexId}'`,
                "DELETE of one index's chunks": `DELETE FROM chunks WHERE index_id = '${probe.indexId}'`,
                "DELETE of every chunk": "DELETE FROM chunks"
            };

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await readProbe(probe), before, "the chunks are as they were");
        } finally {
            await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[probe.userId, other.userId]]);
        }
    });

    it("is refused UPDATE and DELETE on index_build_usage (42501), so a user's day cannot be given back, and the rows are unchanged", async () => {
        const probe = await makeDocumentProbe("usage.probe@example.com");

        try {
            const before = await readProbe(probe);
            const statements: Record<string, string> = {
                "UPDATE of accepted_at": `UPDATE index_build_usage SET accepted_at = now() - interval '2 days' WHERE user_id = '${probe.userId}'`,
                "UPDATE of user_id": `UPDATE index_build_usage SET user_id = user_id`,
                "DELETE of one user's rows": `DELETE FROM index_build_usage WHERE user_id = '${probe.userId}'`,
                "DELETE of every row": "DELETE FROM index_build_usage"
            };

            for (const [label, statement] of Object.entries(statements)) {
                assert.equal(await failureCodeOf(statement), "42501", label);
            }

            assert.deepEqual(await readProbe(probe), before, "the rows are as they were");
        } finally {
            await pool.query("DELETE FROM users WHERE id = $1", [probe.userId]);
        }
    });

    it("still does what the services do: updates the columns of a build, writes the vectors of a batch, and deletes an index", async () => {
        const probe = await makeDocumentProbe("service.documents.probe@example.com");

        try {
            const { rows: started } = await pool.query<{ id: string }>(
                "UPDATE document_indexes SET status = 'indexing', started_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1 RETURNING id",
                [probe.indexId]
            );
            assert.equal(started.length, 1);

            const vector = JSON.stringify(new Array(1024).fill(0.5));
            const { rowCount } = await pool.query(
                `UPDATE chunks SET embedding = batch.embedding::vector
                 FROM unnest($2::int[], $3::text[]) AS batch(chunk_index, embedding)
                 WHERE chunks.index_id = $1 AND chunks.chunk_index = batch.chunk_index`,
                [probe.indexId, [0, 1], [vector, vector]]
            );
            assert.equal(rowCount, 2);

            await pool.query("UPDATE document_indexes SET embedded_count = 2, embedding_tokens = embedding_tokens + 7 WHERE id = $1", [probe.indexId]);
            await pool.query("UPDATE document_indexes SET status = 'ready', finished_at = now() WHERE id = $1", [probe.indexId]);
            await pool.query("UPDATE document_indexes SET status = 'queued', queued_at = now(), started_at = NULL, finished_at = NULL, error = 'Indexing failed' WHERE id = $1", [probe.indexId]);

            const { rows } = await ownerPool.query("SELECT status, embedded_count, embedding_tokens, attempts, error FROM document_indexes WHERE id = $1", [probe.indexId]);
            assert.deepEqual(rows, [{ status: "queued", embedded_count: 2, embedding_tokens: 7, attempts: 1, error: "Indexing failed" }]);

            assert.equal((await pool.query("DELETE FROM document_indexes WHERE id = $1", [probe.indexId])).rowCount, 1);
            assert.equal((await pool.query("DELETE FROM documents WHERE id = $1", [probe.documentId])).rowCount, 1);
        } finally {
            await pool.query("DELETE FROM users WHERE id = $1", [probe.userId]);
        }
    });

    // The chunks of an index go with it although the API role may not delete chunks: the cascade of a foreign key is
    // carried out with the rights of the table's owner.
    it("deletes the chunks of an index when it deletes the index, and of a document when it deletes the document, although it cannot delete chunks itself", async () => {
        const probe = await makeDocumentProbe("cascade.probe@example.com");

        try {
            assert.equal((await ownerPool.query("SELECT 1 FROM chunks WHERE index_id = $1", [probe.indexId])).rowCount, 2, "the probe has its chunks");

            await pool.query("DELETE FROM document_indexes WHERE id = $1", [probe.indexId]);
            assert.equal((await ownerPool.query("SELECT 1 FROM chunks WHERE index_id = $1", [probe.indexId])).rowCount, 0, "the index took its chunks with it");

            const { rows: indexes } = await pool.query<{ id: string }>(
                "INSERT INTO document_indexes (document_id, chunk_size, embedding_model, chunk_count) VALUES ($1, 500, 'probe-model:1', 1) RETURNING id",
                [probe.documentId]
            );
            await pool.query("INSERT INTO chunks (index_id, chunk_index, text) VALUES ($1, 0, 'one')", [indexes[0].id]);

            await pool.query("DELETE FROM documents WHERE id = $1", [probe.documentId]);
            assert.equal((await ownerPool.query("SELECT 1 FROM chunks WHERE index_id = $1", [indexes[0].id])).rowCount, 0, "the document took the chunks of its indexes with it");
            assert.equal((await ownerPool.query("SELECT 1 FROM document_indexes WHERE id = $1", [indexes[0].id])).rowCount, 0);
        } finally {
            await pool.query("DELETE FROM users WHERE id = $1", [probe.userId]);
        }
    });

    it("writes a vector into a chunk and orders chunks by cosine distance, the way retrieval will", async () => {
        const probe = await makeDocumentProbe("vector.probe@example.com");

        try {
            // a vector with a weight on its first number and a weight on its second, and zeros everywhere else
            const mix = (first: number, second: number): number[] => Array.from({ length: 1024 }, (_, index) => (index === 0 ? first : index === 1 ? second : 0));
            await pool.query("UPDATE chunks SET embedding = $2::vector WHERE index_id = $1 AND chunk_index = 0", [probe.indexId, JSON.stringify(mix(1, 0))]);
            await pool.query("UPDATE chunks SET embedding = $2::vector WHERE index_id = $1 AND chunk_index = 1", [probe.indexId, JSON.stringify(mix(0, 1))]);

            const nearest = async (query: number[]): Promise<number[]> => (await pool.query<{ chunk_index: number }>(
                "SELECT chunk_index FROM chunks WHERE index_id = $1 ORDER BY embedding <=> $2::vector",
                [probe.indexId, JSON.stringify(query)]
            )).rows.map((row) => row.chunk_index);

            assert.deepEqual(await nearest(mix(0.9, 0.1)), [0, 1]);
            assert.deepEqual(await nearest(mix(0.1, 0.9)), [1, 0]);
        } finally {
            await pool.query("DELETE FROM users WHERE id = $1", [probe.userId]);
        }
    });

    it("holds only SELECT on schema_migrations", async () => {
        assert.deepEqual(await privilegesOn("schema_migrations"), ["SELECT"]);
    });

    // The default profile is what every user's configuration falls back on: only the owner, through a migration,
    // may change it, so a flaw in a route cannot rewrite the defaults (and the caps they are checked against).
    it("holds only SELECT on default_profile", async () => {
        assert.deepEqual(await privilegesOn("default_profile"), ["SELECT"]);
    });

    it("is refused INSERT, UPDATE and DELETE on default_profile (42501), and the row is unchanged", async () => {
        const read = async () => (await ownerPool.query("SELECT singleton, version, settings, updated_at FROM default_profile")).rows;
        const before = await read();

        assert.equal(before.length, 1, "the migration seeded one row");

        const statements: Record<string, string> = {
            "INSERT": "INSERT INTO default_profile (version, settings) VALUES (1, '{}')",
            "UPDATE of the settings": "UPDATE default_profile SET settings = '{}'",
            "UPDATE of the version": "UPDATE default_profile SET version = 2",
            "DELETE": "DELETE FROM default_profile"
        };

        for (const [label, statement] of Object.entries(statements)) {
            assert.equal(await failureCodeOf(statement), "42501", label);
        }

        assert.deepEqual(await read(), before, "the row is as the migration made it");
    });

    it("reads default_profile, the way the API does", async () => {
        const { rows } = await pool.query<{ version: number; settings: Record<string, unknown> }>("SELECT version, settings FROM default_profile");

        assert.equal(rows.length, 1);
        assert.equal(rows[0].version, 1);
        assert.equal(rows[0].settings.topK, 3);
    });

    it("is refused every change to the schema with 'permission denied' (42501)", async () => {
        const statements: Record<string, string> = {
            "CREATE TABLE": "CREATE TABLE api_made_this (id integer)",
            "ALTER TABLE users": "ALTER TABLE users ADD COLUMN api_made_this integer",
            "DROP TABLE users": "DROP TABLE users",
            "DROP TABLE schema_migrations": "DROP TABLE schema_migrations",
            "TRUNCATE users": "TRUNCATE users",
            "ALTER TABLE profiles": "ALTER TABLE profiles ADD COLUMN api_made_this integer",
            "DROP TABLE profiles": "DROP TABLE profiles",
            "TRUNCATE profiles": "TRUNCATE profiles",
            "CREATE INDEX ON profiles": "CREATE INDEX ON profiles (name)",
            "ALTER TABLE default_profile": "ALTER TABLE default_profile ADD COLUMN api_made_this integer",
            "DROP TABLE default_profile": "DROP TABLE default_profile",
            "TRUNCATE default_profile": "TRUNCATE default_profile",
            "CREATE FUNCTION": "CREATE FUNCTION api_made_this() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
            "CREATE SCHEMA": "CREATE SCHEMA api_made_this",
            "INSERT INTO schema_migrations": "INSERT INTO schema_migrations (version) VALUES ('999_api_made_this.sql')",
            "DELETE FROM schema_migrations": "DELETE FROM schema_migrations",
            "UPDATE schema_migrations": "UPDATE schema_migrations SET version = 'x'"
        };

        for (const [label, statement] of Object.entries(statements)) {
            assert.equal(await failureCodeOf(statement), "42501", label);
        }

        for (const table of ["users", "profiles", "default_profile"]) {
            assert.ok((await publicTables()).includes(table), `${table} is still there`);
        }
        assert.ok(!(await publicTables()).includes("api_made_this"));
    });

    it("can use the schema but not create in it", async () => {
        const { rows } = await ownerPool.query<{ usage: boolean; create: boolean }>(
            "SELECT has_schema_privilege($1::name, 'public', 'USAGE') AS usage, has_schema_privilege($1::name, 'public', 'CREATE') AS create",
            [API_ROLE]
        );

        assert.deepEqual(rows[0], { usage: true, create: false }, "CREATE is revoked from everyone, PUBLIC included");
    });
};

describe("the API role", () => {
    it("is the one the app's pool connects with", async () => {
        const { rows } = await pool.query<{ role: string }>("SELECT current_user AS role");

        assert.equal(rows[0].role, API_ROLE);
    });

    it("is a plain login role: not a superuser, and it cannot create roles or databases, bypass row security or replicate", async () => {
        const { rows } = await ownerPool.query(
            "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = $1",
            [API_ROLE]
        );

        assert.deepEqual(rows, [{ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false }]);
    });

    checkTheRights();

    it("reads and writes the users table, the way the API does", async () => {
        const { rows: inserted } = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('api.probe@example.com', 'x') RETURNING id");
        const id = inserted[0].id;

        await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [id]);
        const { rows } = await pool.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [id]);
        assert.equal(rows[0].status, "disabled");

        await pool.query("DELETE FROM users WHERE id = $1", [id]);
        assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount, 0);
    });

    it("reads and writes the profiles table, the way the API does", async () => {
        const { rows: owners } = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash) VALUES ('profile.probe@example.com', 'x') RETURNING id");
        const userId = owners[0].id;

        const { rows: inserted } = await pool.query<{ id: string }>(
            "INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, 'Probe', 1, '{\"topK\": 5}'::jsonb) RETURNING id",
            [userId]
        );
        const id = inserted[0].id;

        await pool.query("UPDATE profiles SET name = 'Renamed', settings = '{}'::jsonb, updated_at = now() WHERE id = $1", [id]);
        const { rows } = await pool.query<{ name: string; settings: object }>("SELECT name, settings FROM profiles WHERE id = $1", [id]);
        assert.deepEqual(rows, [{ name: "Renamed", settings: {} }]);

        await pool.query("DELETE FROM profiles WHERE id = $1", [id]);
        assert.equal((await pool.query("SELECT 1 FROM profiles WHERE id = $1", [id])).rowCount, 0);

        await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    });

    it("reads schema_migrations, which is how the server checks the schema at startup", async () => {
        const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");

        assert.deepEqual(rows.map((row) => row.version), [
            "001_init.sql", "002_api_role.sql", "003_users.sql", "004_default_profile.sql", "005_profiles.sql",
            "006_documents.sql", "007_document_indexes.sql", "008_index_build_usage.sql", "009_runs.sql"
        ]);
    });

    it("can use pgvector's type and operators, which live in the schema it was given USAGE on", async () => {
        const vector = JSON.stringify(new Array(1024).fill(0.1));

        const { rows } = await pool.query<{ distance: number }>("SELECT ($1::vector(1024) <=> $1::vector(1024))::float8 AS distance", [vector]);

        assert.ok(Math.abs(rows[0].distance) < 1e-6);
    });
});

// The tables the next layers add are made by the owner after these migrations ran, so the role has to get its rights
// on them without a new migration: through default privileges, on the table and on its sequence.
describe("a table the owner creates after the migrations", () => {
    before(async () => {
        await ownerPool.query("CREATE TABLE later_layer_probe (id serial PRIMARY KEY, body text NOT NULL)");
    });

    it("takes inserts from the API role, with its serial id", async () => {
        const first = await pool.query<{ id: number }>("INSERT INTO later_layer_probe (body) VALUES ('one') RETURNING id");
        const second = await pool.query<{ id: number }>("INSERT INTO later_layer_probe (body) VALUES ('two') RETURNING id");

        assert.deepEqual([first.rows[0].id, second.rows[0].id], [1, 2]);
    });

    it("can be read, changed and emptied row by row by the API role, but not truncated", async () => {
        await pool.query("INSERT INTO later_layer_probe (body) VALUES ('three')");

        await pool.query("UPDATE later_layer_probe SET body = 'changed' WHERE body = 'three'");
        const { rows } = await pool.query<{ body: string }>("SELECT body FROM later_layer_probe WHERE body = 'changed'");
        assert.equal(rows.length, 1);

        await pool.query("DELETE FROM later_layer_probe");
        assert.equal(await failureCodeOf("TRUNCATE later_layer_probe"), "42501");
        assert.deepEqual(await privilegesOn("later_layer_probe"), ["SELECT", "INSERT", "UPDATE", "DELETE"]);
    });
});

// Every test file empties the schema and migrates again: the rights have to come back each time.
describe("the API role after the database is emptied and migrated a second time", () => {
    before(resetTestDatabase);

    checkTheRights();

    it("takes inserts into a table the owner creates after that second migration", async () => {
        await ownerPool.query("CREATE TABLE second_round_probe (id serial PRIMARY KEY, body text)");

        const { rows } = await pool.query<{ id: number }>("INSERT INTO second_round_probe (body) VALUES ('x') RETURNING id");

        assert.equal(rows[0].id, 1);
    });
});

// A migration that gives rights to a role that does not exist must say what to do, and not fail with a bare
// "role does not exist". The test runs a copy of 002 that names a role nobody created.
describe("migration 002 when the API role was never created", () => {
    let workFolder = "";

    before(async () => {
        // a run that was killed before its `after` leaves its copy behind
        for (const entry of await readdir(import.meta.dirname)) {
            if (entry.startsWith(".role-copy-")) {
                await rm(path.join(import.meta.dirname, entry), { recursive: true, force: true });
            }
        }

        workFolder = await mkdtemp(path.join(import.meta.dirname, ".role-copy-"));
        // an empty .env, so the child process does not read the real one
        await writeFile(path.join(workFolder, "empty.env"), "");
        await cp(path.join(ROOT, "src"), path.join(workFolder, "src"), { recursive: true });
        await mkdir(path.join(workFolder, "migrations"));
        await cp(path.join(ROOT, "migrations", "001_init.sql"), path.join(workFolder, "migrations", "001_init.sql"));
        await cp(path.join(ROOT, "migrations", "003_users.sql"), path.join(workFolder, "migrations", "003_users.sql"));

        const real = await readFile(path.join(ROOT, "migrations", "002_api_role.sql"), "utf8");
        await writeFile(path.join(workFolder, "migrations", "002_api_role.sql"), real.replaceAll(API_ROLE, "rag_lab_role_nobody_created"));

        await emptyTestDatabase();
    });

    after(() => rm(workFolder, { recursive: true, force: true }));

    it("fails and names scripts/create-api-role.sql, applying nothing after it", { timeout: 60_000 }, async () => {
        await assert.rejects(
            execFileAsync(process.execPath, ["--import", "tsx", path.join(workFolder, "src", "migrate.ts")], {
                cwd: ROOT,
                env: cleanChildEnvironment({ DOTENV_CONFIG_PATH: path.join(workFolder, "empty.env"), DOTENV_CONFIG_QUIET: "true" }),
                timeout: 50_000
            }),
            (error: unknown) => {
                const failure = error as { code?: number; stdout?: string; stderr?: string };

                assert.equal(typeof failure.code, "number", "the script exits with a failure, not a timeout");
                assert.notEqual(failure.code, 0);
                assert.match(failure.stderr ?? "", /002_api_role\.sql/, "it names the migration that failed");
                assert.match(failure.stderr ?? "", /scripts[\\/]create-api-role\.sql/, "it says which script creates the role");
                assert.match(failure.stdout ?? "", /Applied 001_init\.sql/);
                assert.doesNotMatch(failure.stdout ?? "", /Applied 002|Applied 003/);
                return true;
            }
        );

        const { rows } = await ownerPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
        assert.deepEqual(rows.map((row) => row.version), ["001_init.sql"], "the failed migration was not recorded");
        assert.ok(!(await publicTables()).includes("users"), "003 did not run");
    });
});
