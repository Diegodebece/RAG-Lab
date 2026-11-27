import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// Small caps, set before the app is imported (the limits are read once, when their module loads, and each test file is
// its own process). The caps on indexes are wide here: they have their own tests (documentIndexes.test.ts). The upload
// requests per minute are relaxed by the import above, and have their own file (documentLimits.test.ts).
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_DOCUMENTS_PER_USER = "3";
process.env.MAX_DOCUMENT_CHARACTERS = "20000";
process.env.MAX_ACTIVE_INDEX_BUILDS_PER_USER = "100";
process.env.MAX_QUEUED_INDEX_BUILDS = "1000";
process.env.MAX_INDEX_BUILDS_PER_DAY = "1000";
process.env.MAX_INDEX_BUILDS_PER_DAY_TOTAL = "10000";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { chunkText } = await import("../../src/v1/utils/chunkText.util.js");
const { DEFAULT_EMBEDDING_MODEL, countRows, readChunks, seedDocument, seedIndex, sha256Of } = await import("../documentsFixtures.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const MAX_CHARACTERS = 20_000;
// 3 x the longest text (the most bytes a character takes in UTF-8, apart from the 4 of an emoji, which is two units) plus 16 kB
const BODY_LIMIT = 3 * MAX_CHARACTERS + 16 * 1024;

const DOCUMENT_KEYS = ["characterCount", "contentHash", "createdAt", "filename", "id", "indexes"];
const INDEX_KEYS = [
    "attempts", "chunkCount", "chunkSize", "createdAt", "documentId", "embeddedCount", "embeddingModel", "embeddingTokens",
    "error", "finishedAt", "id", "queuePosition", "queuedAt", "startedAt", "status"
];

// about 13,000 characters, different for every label, so two uploads are never the same document
const sampleOf = (label: string): string => Array.from({ length: 300 }, (_, index) => `${label} sentence ${index} about the document.`).join(" ");

const upload = (auth: Auth, body: object = { filename: "notes.txt", text: sampleOf("default") }) =>
    request(app).post("/v1/documents").set(...auth).send(body);

const get = (auth: Auth, id: string) => request(app).get(`/v1/documents/${id}`).set(...auth);

const remove = (auth: Auth, id: string) => request(app).delete(`/v1/documents/${id}`).set(...auth);

interface IndexBody {
    id: string;
    documentId: string;
    chunkSize: number;
    embeddingModel: string;
    status: string;
    chunkCount: number;
    embeddedCount: number;
    embeddingTokens: number;
    attempts: number;
    error: string | null;
    queuePosition: number | null;
    createdAt: string;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

interface DocumentBody {
    id: string;
    filename: string;
    characterCount: number;
    contentHash: string;
    createdAt: string;
    indexes: IndexBody[];
}

// the answer of an upload that was accepted
const uploaded = async (auth: Auth, body?: object): Promise<DocumentBody> => {
    const response = await upload(auth, body);

    assert.equal(response.status, 202, JSON.stringify(response.body));
    return response.body.data as DocumentBody;
};

describe("POST /v1/documents: what is stored", () => {
    it("answers 202 with the document and its one queued index, in exactly the agreed shape", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = sampleOf("shape");

        const response = await upload(ana.auth, { filename: "notes.txt", text });

        assert.equal(response.status, 202);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Document accepted for indexing");

        const document = response.body.data as DocumentBody;
        assert.deepEqual(Object.keys(document).sort(), DOCUMENT_KEYS);
        assert.equal(document.filename, "notes.txt");
        assert.equal(document.characterCount, text.length);
        assert.equal(new Date(document.createdAt).toISOString(), document.createdAt, "the date is written as ISO 8601");
        assert.equal(document.indexes.length, 1);

        const [index] = document.indexes;
        assert.deepEqual(Object.keys(index).sort(), INDEX_KEYS);
        assert.equal(index.documentId, document.id);
        assert.equal(index.chunkSize, 1000);
        assert.equal(index.embeddingModel, DEFAULT_EMBEDDING_MODEL);
        assert.equal(index.status, "queued");
        assert.equal(index.chunkCount, chunkText(text, 1000).length);
        assert.equal(index.embeddedCount, 0);
        assert.equal(index.embeddingTokens, 0);
        assert.equal(index.attempts, 0);
        assert.equal(index.error, null);
        assert.equal(index.startedAt, null);
        assert.equal(index.finishedAt, null);
        assert.equal(new Date(index.createdAt).toISOString(), index.createdAt);
        assert.equal(new Date(index.queuedAt).toISOString(), index.queuedAt);
        assert.equal(index.queuePosition, 1, "nothing else is queued, so it runs next");
    });

    it("never returns the text or the owner of a document, at any depth", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await upload(ana.auth, { filename: "notes.txt", text: sampleOf("private") });
        const listed = await request(app).get("/v1/documents").set(...ana.auth);
        const single = await get(ana.auth, response.body.data.id);

        for (const body of [response.body, listed.body, single.body]) {
            const written = JSON.stringify(body);

            assert.doesNotMatch(written, /"(text|userId|user_id)"\s*:/);
            assert.ok(!written.includes("private sentence"), "no part of the text is in the answer");
            assert.ok(!written.includes(ana.id), "the owner's id is not in the answer");
        }
    });

    it("stores the text cleaned: line breaks kept as \\n, control characters removed, NFC, trimmed", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const document = await uploaded(ana.auth, { filename: "dirty.txt", text: "  First line.\r\nSecond\u0000 line.\u0007 Café  \r\n" });

        const { rows } = await ownerPool.query<{ text: string }>("SELECT text FROM documents WHERE id = $1", [document.id]);
        assert.equal(rows[0].text, "First line.\nSecond line. Café");
        assert.equal(document.characterCount, "First line.\nSecond line. Café".length);

        const chunks = await readChunks(document.indexes[0].id);
        assert.deepEqual(chunks.map((chunk) => chunk.text), ["First line. Second line. Café"], "the chunker collapses the line breaks, the stored text keeps them");
    });

    it("counts the characters in UTF-16 units, as JavaScript does: an emoji counts two", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const document = await uploaded(ana.auth, { filename: "emoji.txt", text: "Hello 😀 world" });

        assert.equal(document.characterCount, 14);
        const { rows } = await ownerPool.query<{ character_count: number }>("SELECT character_count FROM documents WHERE id = $1", [document.id]);
        assert.equal(rows[0].character_count, 14);
    });

    it("gives the SHA-256 of the stored text as its content hash", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const stored = "Café con leche\nsegunda línea";

        const document = await uploaded(ana.auth, { filename: "hash.txt", text: `  Café con leche\r\nsegunda línea \u0000 ` });

        assert.equal(document.contentHash, sha256Of(stored));
        assert.match(document.contentHash, /^[0-9a-f]{64}$/);
        const { rows } = await ownerPool.query<{ content_hash: string }>("SELECT content_hash FROM documents WHERE id = $1", [document.id]);
        assert.equal(rows[0].content_hash, document.contentHash);
    });

    it("stores the chunks of the index numbered from 0, in the order of the text, with no vector yet", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = sampleOf("chunks");

        const document = await uploaded(ana.auth, { filename: "chunks.txt", text });

        const expected = chunkText(text, 1000);
        const chunks = await readChunks(document.indexes[0].id);
        assert.ok(expected.length > 1, "the sample takes more than one chunk");
        assert.deepEqual(chunks.map((chunk) => chunk.chunkIndex), expected.map((_, index) => index));
        assert.deepEqual(chunks.map((chunk) => chunk.text), expected);
        assert.ok(chunks.every((chunk) => chunk.vector === null));
        assert.equal(document.indexes[0].chunkCount, expected.length);
    });

    it("builds an index of the size asked for: chunkSize 500 gives a 500 index with its own chunks", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = sampleOf("small");

        const document = await uploaded(ana.auth, { filename: "small.txt", text, chunkSize: 500 });

        assert.equal(document.indexes.length, 1);
        assert.equal(document.indexes[0].chunkSize, 500);
        assert.equal(document.indexes[0].chunkCount, chunkText(text, 500).length);
        assert.ok((await readChunks(document.indexes[0].id)).every((chunk) => chunk.text.length <= 500));
    });

    it("takes the default profile's chunk size and model when the body gives none, and the model it gives when it does", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{chunkSize}', '2000')");

        try {
            const withDefaults = await uploaded(ana.auth, { filename: "a.txt", text: sampleOf("defaults") });
            const withModel = await uploaded(ana.auth, { filename: "b.txt", text: sampleOf("model"), embeddingModel: DEFAULT_EMBEDDING_MODEL });

            assert.equal(withDefaults.indexes[0].chunkSize, 2000);
            assert.equal(withDefaults.indexes[0].embeddingModel, DEFAULT_EMBEDDING_MODEL);
            assert.equal(withModel.indexes[0].chunkSize, 2000, "the size comes from the default profile whenever the body does not give it");
        } finally {
            await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{chunkSize}', '1000')");
        }
    });

    it("counts one build for the upload, in the usage table, and no more", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        await uploaded(ana.auth);

        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1);
        assert.equal(await countRows("documents"), 1);
        assert.equal(await countRows("document_indexes"), 1);
    });

    it("tells the queue position over every user's queued indexes, oldest first", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const other = await seedDocument(bob.id);
        await seedIndex(other.id, { queuedAt: new Date(Date.now() - 60_000) });
        await seedIndex(other.id, { chunkSize: 500, queuedAt: new Date(Date.now() - 30_000) });

        const document = await uploaded(ana.auth);

        assert.equal(document.indexes[0].queuePosition, 3);
    });
});

describe("POST /v1/documents: what is refused with a 400", () => {
    it("answers 400 and stores nothing and counts no build for a body that is not valid, a question-time setting or a field that is not the client's", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = sampleOf("refused");
        const bodies: Record<string, object> = {
            "no filename": { text },
            "a filename of 256 characters": { filename: "x".repeat(256), text },
            "no text": { filename: "a.txt" },
            "an empty text": { filename: "a.txt", text: "" },
            "a text over the limit": { filename: "a.txt", text: "x".repeat(MAX_CHARACTERS + 1) },
            "a chunk size that is not allowed": { filename: "a.txt", text, chunkSize: 400 },
            "a chunk size written as text": { filename: "a.txt", text, chunkSize: "500" },
            "a model that is not allowed": { filename: "a.txt", text, embeddingModel: "other" },
            "a question-time setting": { filename: "a.txt", text, topK: 5 },
            "an owner": { filename: "a.txt", text, userId: randomUUID() },
            "a status": { filename: "a.txt", text, status: "ready" },
            "a content hash": { filename: "a.txt", text, contentHash: "0".repeat(64) },
            "an id": { filename: "a.txt", text, id: randomUUID() }
        };

        for (const [label, body] of Object.entries(bodies)) {
            const response = await upload(ana.auth, body);

            assert.equal(response.status, 400, label);
            assert.equal(response.body.message, "Validation error", label);
            assert.ok(Array.isArray(response.body.details) && response.body.details.length >= 1, label);
        }

        assert.equal(await countRows("documents"), 0, "no document");
        assert.equal(await countRows("document_indexes"), 0, "no index");
        assert.equal(await countRows("chunks"), 0, "no chunk");
        assert.equal(await countRows("index_build_usage"), 0, "no build counted");
    });

    it("refuses a filename with a control or a text-direction character, and accepts accents, Hebrew and emoji", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const names: Record<string, string> = {
            "null byte": `notes${String.fromCodePoint(0)}.txt`,
            "new line": `notes${String.fromCodePoint(0x0a)}.txt`,
            "right-to-left override": `invoice${String.fromCodePoint(0x202e)}txt.exe`,
            "right-to-left isolate": `invoice${String.fromCodePoint(0x2067)}txt.exe`
        };

        for (const [label, filename] of Object.entries(names)) {
            const response = await upload(ana.auth, { filename, text: sampleOf(label) });

            assert.equal(response.status, 400, label);
            assert.deepEqual(response.body, { message: "Validation error", details: ["Filename contains control or text-direction characters"] }, label);
        }

        assert.equal(await countRows("documents"), 0);

        const accepted = await upload(ana.auth, { filename: `Informe a${String.fromCodePoint(0xf1)}o ${String.fromCodePoint(0x05e9, 0x05dc, 0x05d5, 0x05dd)} 😀.txt`, text: sampleOf("accented") });
        assert.equal(accepted.status, 202);
    });

    it("answers 400 'The document has no readable text' for a text with nothing left after cleaning, and stores nothing and counts no build", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (const text of ["   \n\t  ", `\u0000\u0001 \r\n ${String.fromCodePoint(0xfeff)}`, " \u0007 "]) {
            const response = await upload(ana.auth, { filename: "empty.txt", text });

            assert.equal(response.status, 400, JSON.stringify(text));
            assert.deepEqual(response.body, { message: "The document has no readable text" }, JSON.stringify(text));
        }

        assert.equal(await countRows("documents"), 0);
        assert.equal(await countRows("index_build_usage"), 0);
    });
});

describe("POST /v1/documents: the size of the body", () => {
    // the bytes of a body whose text is made of `length` letters, to put a body exactly at, or one byte over, the limit
    const bodyOfBytes = (bytes: number): string => {
        const overhead = Buffer.byteLength(JSON.stringify({ filename: "big.txt", text: "" }));
        const body = JSON.stringify({ filename: "big.txt", text: "a".repeat(bytes - overhead) });

        assert.equal(Buffer.byteLength(body), bytes);
        return body;
    };

    const sendRaw = (auth: Auth, body: string) => request(app).post("/v1/documents").set(...auth).set("Content-Type", "application/json").send(body);

    it("answers 413 for a body one byte over the limit (3 x the longest text + 16 kB)", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await sendRaw(ana.auth, bodyOfBytes(BODY_LIMIT + 1));

        assert.equal(response.status, 413);
        assert.deepEqual(response.body, { message: "request entity too large" });
        assert.equal(await countRows("documents"), 0);
    });

    it("reads a body of exactly the limit: it is the text that is too long then (400), not the body (413)", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await sendRaw(ana.auth, bodyOfBytes(BODY_LIMIT));

        assert.equal(response.status, 400);
        assert.equal(response.body.message, "Validation error");
    });

    it("accepts a text exactly at the character limit when every character takes 3 bytes (20,000 of them)", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = "€".repeat(MAX_CHARACTERS);
        assert.equal(Buffer.byteLength(text), 3 * MAX_CHARACTERS);

        const response = await upload(ana.auth, { filename: "euros.txt", text });

        assert.equal(response.status, 202, JSON.stringify(response.body).slice(0, 300));
        assert.equal(response.body.data.characterCount, MAX_CHARACTERS);
        assert.equal(response.body.data.indexes[0].chunkCount, chunkText(text, 1000).length);
    });

    it("answers 401, not 413, to an anonymous upload over the limit: the body is not read before the token is checked", { timeout: 20_000 }, async () => {
        // The server answers 401 without reading the body, and may close the connection while the client is still
        // sending it (ECONNRESET): both mean the body was not read.
        let outcome: string;

        try {
            outcome = String((await request(app).post("/v1/documents").set("Content-Type", "application/json").send(bodyOfBytes(BODY_LIMIT + 50_000))).status);
        } catch (error) {
            outcome = error instanceof Error ? error.message : String(error);
        }

        assert.ok(outcome === "401" || /ECONNRESET|EPIPE|socket hang up/i.test(outcome), outcome);
    });
});

describe("POST /v1/documents: the limits of one user", () => {
    it("answers 409 to the upload after MAX_DOCUMENTS_PER_USER (3), stores nothing and counts no build, and makes room when one is deleted", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const documents: DocumentBody[] = [];

        for (let index = 0; index < 3; index++) {
            documents.push(await uploaded(ana.auth, { filename: `doc${index}.txt`, text: sampleOf(`limit ${index}`) }));
        }

        const fourth = await upload(ana.auth, { filename: "fourth.txt", text: sampleOf("limit 4") });

        assert.equal(fourth.status, 409);
        assert.deepEqual(fourth.body, { message: "You have reached the maximum number of documents" });
        assert.equal(await countRows("documents"), 3);
        assert.equal(await countRows("index_build_usage"), 3, "the refused upload counted nothing");

        assert.equal((await remove(ana.auth, documents[0].id)).status, 200);
        assert.equal((await upload(ana.auth, { filename: "fourth.txt", text: sampleOf("limit 4") })).status, 202, "there is room again");
    });

    it("counts each user's documents apart", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });

        for (let index = 0; index < 3; index++) {
            await uploaded(ana.auth, { filename: `doc${index}.txt`, text: sampleOf(`ana ${index}`) });
        }

        assert.equal((await upload(ana.auth, { filename: "more.txt", text: sampleOf("ana more") })).status, 409);
        assert.equal((await upload(bob.auth, { filename: "bob.txt", text: sampleOf("bob") })).status, 202, "the limit is per user");
    });

    it("answers 409 'You already have a document with this text' for the same text twice, also when only the whitespace around it differs, and lets another user upload it", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const text = sampleOf("same");
        await uploaded(ana.auth, { filename: "first.txt", text });

        const again = await upload(ana.auth, { filename: "second.txt", text });
        const spaced = await upload(ana.auth, { filename: "third.txt", text: `\r\n  ${text}  \r\n` });

        assert.equal(again.status, 409);
        assert.deepEqual(again.body, { message: "You already have a document with this text" });
        assert.equal(spaced.status, 409, "the hash is of the cleaned text");
        assert.equal(await countRows("documents"), 1);
        assert.equal(await countRows("index_build_usage"), 1, "the refused uploads counted nothing");

        assert.equal((await upload(bob.auth, { filename: "bobs.txt", text })).status, 202, "another user may upload the same text");
    });

    it("lets exactly one of two uploads that arrive together take the last place", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (let round = 1; round <= 3; round++) {
            await ownerPool.query("DELETE FROM documents WHERE user_id = $1", [ana.id]);
            await seedDocument(ana.id);
            await seedDocument(ana.id);

            const answers = await Promise.all([
                upload(ana.auth, { filename: "a.txt", text: sampleOf(`race ${round} a`) }),
                upload(ana.auth, { filename: "b.txt", text: sampleOf(`race ${round} b`) })
            ]);

            assert.deepEqual(answers.map((answer) => answer.status).sort(), [202, 409], `round ${round}`);
            assert.equal(await countRows("documents", "user_id = $1", [ana.id]), 3, `round ${round}: never more than the limit`);
        }
    });

    it("lets exactly one of five uploads that arrive together take the last place", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await seedDocument(ana.id);
        await seedDocument(ana.id);

        const answers = await Promise.all([1, 2, 3, 4, 5].map((index) => upload(ana.auth, { filename: `crowd${index}.txt`, text: sampleOf(`crowd ${index}`) })));

        assert.equal(answers.filter((answer) => answer.status === 202).length, 1);
        assert.equal(answers.filter((answer) => answer.status === 409).length, 4);
        assert.equal(await countRows("documents", "user_id = $1", [ana.id]), 3);
    });

    it("lets exactly one of two uploads of the same text that arrive together through", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const text = sampleOf("twins");

        const answers = await Promise.all([upload(ana.auth, { filename: "a.txt", text }), upload(ana.auth, { filename: "b.txt", text })]);

        assert.deepEqual(answers.map((answer) => answer.status).sort(), [202, 409]);
        assert.equal(await countRows("documents"), 1);
        assert.equal(await countRows("index_build_usage"), 1);
    });

    it("serializes the uploads of one user by locking the user's row: an upload waits while another transaction holds it", { timeout: 20_000 }, async () => {
        // FOR NO KEY UPDATE conflicts with the service's FOR UPDATE but not with the light lock PostgreSQL takes when it
        // checks the documents.user_id foreign key, so only the service's own lock makes the upload wait.
        const ana = await createTestUser({ email: "ana@example.com" });
        const client = await ownerPool.connect();
        let finished = false;

        try {
            await client.query("BEGIN");
            await client.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [ana.id]);

            const pending = (async () => {
                const response = await upload(ana.auth);
                finished = true;
                return response;
            })();

            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.equal(finished, false, "the upload must wait while another transaction holds the user's row");

            await client.query("COMMIT");
            assert.equal((await pending).status, 202);
        } finally {
            await client.query("ROLLBACK").catch(() => {});
            client.release();
        }
    });

    it("checks the queue and the day's capacity of all users under one shared lock: an upload waits while it is held", { timeout: 20_000 }, async () => {
        // 72617002 is LOCK_KEYS.indexingQueue (migrate uses 72617001). Without the shared lock, uploads of different users
        // could all read the same queue length and the same count of the day's builds, and all go past the limits.
        const bob = await createTestUser({ email: "bob@example.com" });
        const client = await ownerPool.connect();
        let finished = false;

        try {
            await client.query("SELECT pg_advisory_lock(72617002)");

            const pending = (async () => {
                const response = await upload(bob.auth);
                finished = true;
                return response;
            })();

            await new Promise((resolve) => setTimeout(resolve, 400));
            assert.equal(finished, false, "the upload must wait while the queue lock is held");

            await client.query("SELECT pg_advisory_unlock(72617002)");
            assert.equal((await pending).status, 202);
        } finally {
            await client.query("SELECT pg_advisory_unlock_all()").catch(() => {});
            client.release();
        }
    });
});

describe("GET /v1/documents", () => {
    it("lists only the caller's documents, newest first, each with its indexes ordered by chunk size and then by model", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const older = await seedDocument(ana.id, { filename: "older.txt", createdAt: "2026-01-01T10:00:00Z" });
        const newer = await seedDocument(ana.id, { filename: "newer.txt", createdAt: "2026-02-01T10:00:00Z" });
        await seedDocument(bob.id, { filename: "bobs.txt", createdAt: "2026-03-01T10:00:00Z" });
        await seedIndex(older.id, { chunkSize: 2000 });
        await seedIndex(older.id, { chunkSize: 500, embeddingModel: "zz-model:1" });
        await seedIndex(older.id, { chunkSize: 500, embeddingModel: "aa-model:1" });
        await seedIndex(older.id, { chunkSize: 300 });
        await seedIndex(newer.id, { chunkSize: 1000 });

        const response = await request(app).get("/v1/documents").set(...ana.auth);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Documents retrieved successfully");

        const documents = response.body.data as DocumentBody[];
        assert.deepEqual(documents.map((document) => document.filename), ["newer.txt", "older.txt"]);
        assert.deepEqual(documents[1].indexes.map((index) => [index.chunkSize, index.embeddingModel]), [
            [300, DEFAULT_EMBEDDING_MODEL],
            [500, "aa-model:1"],
            [500, "zz-model:1"],
            [2000, DEFAULT_EMBEDDING_MODEL]
        ]);

        for (const document of documents) {
            assert.deepEqual(Object.keys(document).sort(), DOCUMENT_KEYS);

            for (const index of document.indexes) {
                assert.deepEqual(Object.keys(index).sort(), INDEX_KEYS);
                assert.equal(index.documentId, document.id);
            }
        }
    });

    it("lists a document that has no index with an empty list of indexes", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        await seedDocument(ana.id, { filename: "bare.txt" });

        const response = await request(app).get("/v1/documents").set(...ana.auth);

        assert.equal(response.body.data.length, 1);
        assert.deepEqual(response.body.data[0].indexes, []);
    });

    it("returns an empty list, not a 404, when there are no documents", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        const response = await request(app).get("/v1/documents").set(...ana.auth);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, []);
    });

    it("lists only an admin's own documents, like anyone's", { timeout: 20_000 }, async () => {
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const ana = await createTestUser({ email: "ana@example.com" });
        await seedDocument(ana.id, { filename: "anas.txt" });
        await seedDocument(admin.id, { filename: "admins.txt" });

        const response = await request(app).get("/v1/documents").set(...admin.auth);

        assert.deepEqual(response.body.data.map((document: DocumentBody) => document.filename), ["admins.txt"]);
    });

    it("answers 401 without a token", { timeout: 20_000 }, async () => {
        const response = await request(app).get("/v1/documents");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });
});

describe("GET /v1/documents/:id", () => {
    it("returns one of the caller's documents, the same as the upload answered", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await uploaded(ana.auth);

        const response = await get(ana.auth, document.id);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Document retrieved successfully");
        assert.deepEqual(response.body.data, document);
    });

    it("answers another user's document, an unknown id and a malformed id with the same 404, for an admin too", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const document = await seedDocument(ana.id);

        for (const reader of [bob, admin]) {
            for (const id of [document.id, randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-00000000000", document.id.toUpperCase().replaceAll("-", "")]) {
                const response = await get(reader.auth, id);

                assert.equal(response.status, 404, `${id} for ${reader.id === admin.id ? "an admin" : "another user"}`);
                assert.deepEqual(response.body, { message: "Document not found" }, id);
            }
        }

        assert.equal((await get(ana.auth, document.id)).status, 200, "the owner reads it");
    });

    it("answers 400, not 500, for an id with broken percent-encoding, and logs no error", { timeout: 20_000 }, async (t) => {
        const logged = t.mock.method(console, "error", () => {});
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id);

        for (const [method, path] of [
            ["get", "/v1/documents/%E0%A4%A"],
            ["delete", "/v1/documents/%ZZ"],
            ["post", "/v1/documents/%E0%A4%A/indexes"],
            ["get", `/v1/documents/${document.id}/indexes/%ZZ`],
            ["delete", "/v1/documents/%E0%A4%A/indexes/x"]
        ] as const) {
            const response = await request(app)[method](path).set(...ana.auth);

            assert.equal(response.status, 400, `${method} ${path}`);
        }

        assert.equal(logged.mock.callCount(), 0);
    });
});

describe("DELETE /v1/documents/:id", () => {
    it("deletes the caller's document with its indexes and chunks, and answers 200 without data", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await uploaded(ana.auth);
        await request(app).post(`/v1/documents/${document.id}/indexes`).set(...ana.auth).send({ chunkSize: 500 });
        assert.equal(await countRows("document_indexes"), 2, "the document has two indexes");

        const response = await remove(ana.auth, document.id);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Document deleted successfully");
        assert.equal("data" in response.body, false);
        assert.equal(await countRows("documents"), 0);
        assert.equal(await countRows("document_indexes"), 0);
        assert.equal(await countRows("chunks"), 0);
        assert.equal((await get(ana.auth, document.id)).status, 404);
    });

    it("keeps the day's builds counted: deleting the document does not give them back", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await uploaded(ana.auth);

        await remove(ana.auth, document.id);

        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1);
    });

    it("leaves the caller's other documents alone", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const first = await uploaded(ana.auth, { filename: "first.txt", text: sampleOf("first") });
        const second = await uploaded(ana.auth, { filename: "second.txt", text: sampleOf("second") });

        await remove(ana.auth, first.id);

        assert.equal(await countRows("documents"), 1);
        assert.equal(await countRows("document_indexes", "document_id = $1", [second.id]), 1);
        assert.ok((await countRows("chunks")) > 0, "the chunks of the other document are still there");
    });

    it("answers 404 for another user's document, an unknown id and a malformed id, and deletes nothing", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const document = await uploaded(ana.auth);

        for (const reader of [bob, admin]) {
            for (const id of [document.id, randomUUID(), "not-a-uuid"]) {
                const response = await remove(reader.auth, id);

                assert.equal(response.status, 404, id);
                assert.deepEqual(response.body, { message: "Document not found" }, id);
            }
        }

        assert.equal(await countRows("documents"), 1);
        assert.equal(await countRows("document_indexes"), 1);
        assert.ok((await countRows("chunks")) > 0);
    });

    it("answers 404 the second time", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await uploaded(ana.auth);

        assert.equal((await remove(ana.auth, document.id)).status, 200);
        assert.equal((await remove(ana.auth, document.id)).status, 404);
    });
});
