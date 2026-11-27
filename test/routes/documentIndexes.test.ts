import "./relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

// Small caps, set before the app is imported (the limits are read once, when their module loads, and each test file is
// its own process). They are chosen so that each cap can be reached with a few seeded rows while the others stay clear:
// 3 documents and 2 builds in progress per user, 4 builds a day per user, 8 a day for everybody, 6 queued in all.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_DOCUMENTS_PER_USER = "3";
process.env.MAX_DOCUMENT_CHARACTERS = "20000";
process.env.MAX_ACTIVE_INDEX_BUILDS_PER_USER = "2";
process.env.MAX_QUEUED_INDEX_BUILDS = "6";
process.env.MAX_INDEX_BUILDS_PER_DAY = "4";
process.env.MAX_INDEX_BUILDS_PER_DAY_TOTAL = "8";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { chunkText } = await import("../../src/v1/utils/chunkText.util.js");
const { DEFAULT_EMBEDDING_MODEL, SEEDED_VECTOR_VALUE, countRows, readChunks, readIndex, seedDocument, seedIndex, seedUsage, sameVector } = await import("../documentsFixtures.js");

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

after(closeTestPools);

type Auth = [string, string];

const INDEX_KEYS = [
    "attempts", "chunkCount", "chunkSize", "createdAt", "documentId", "embeddedCount", "embeddingModel", "embeddingTokens",
    "error", "finishedAt", "id", "queuePosition", "queuedAt", "startedAt", "status"
];

const IN_PROGRESS = { message: "You have reached the maximum number of index builds in progress; try again when one finishes" };
const USER_DAILY = { message: "You have reached the daily limit of index builds, please try again later" };
const GLOBAL_DAILY = { message: "The daily indexing capacity is used up, please try again tomorrow" };
const QUEUE_FULL = { message: "The indexing queue is full, please try again in a few minutes" };
const NO_DOCUMENTS_LEFT = { message: "You have reached the maximum number of documents" };

// about 13,000 characters, which takes several chunks at every allowed size
const longText = (label: string): string => Array.from({ length: 300 }, (_, index) => `${label} sentence ${index} about the document.`).join(" ");

// a document of the user's with a long text, and nothing else
const seedLongDocument = (userId: string, label = "long") => seedDocument(userId, { filename: `${label}.txt`, text: longText(label) });

const build = (auth: Auth, documentId: string, body?: object) => {
    const call = request(app).post(`/v1/documents/${documentId}/indexes`).set(...auth);
    return body === undefined ? call : call.send(body);
};

const getIndex = (auth: Auth, documentId: string, indexId: string) => request(app).get(`/v1/documents/${documentId}/indexes/${indexId}`).set(...auth);

const removeIndex = (auth: Auth, documentId: string, indexId: string) => request(app).delete(`/v1/documents/${documentId}/indexes/${indexId}`).set(...auth);

const uploadDocument = (auth: Auth, label: string) => request(app).post("/v1/documents").set(...auth).send({ filename: `${label}.txt`, text: longText(label) });

// every row the cap tests must find unchanged after a refusal
const counts = async (): Promise<Record<string, number>> => ({
    documents: await countRows("documents"),
    indexes: await countRows("document_indexes"),
    chunks: await countRows("chunks"),
    usage: await countRows("index_build_usage")
});

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
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

describe("POST /v1/documents/:id/indexes: a new index", () => {
    it("answers 202 with a queued index of the size asked for and stores its chunks, and the document then lists both indexes", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "ready", chunkSize: 1000 });

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 202);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Index queued for building");

        const index = response.body.data as IndexBody;
        assert.deepEqual(Object.keys(index).sort(), INDEX_KEYS);
        assert.equal(index.documentId, document.id);
        assert.equal(index.chunkSize, 500);
        assert.equal(index.embeddingModel, DEFAULT_EMBEDDING_MODEL);
        assert.equal(index.status, "queued");
        assert.equal(index.embeddedCount, 0);
        assert.equal(index.embeddingTokens, 0);
        assert.equal(index.attempts, 0);
        assert.equal(index.error, null);
        assert.equal(index.queuePosition, 1);

        const expected = chunkText(document.text, 500);
        assert.equal(index.chunkCount, expected.length);
        const chunks = await readChunks(index.id);
        assert.deepEqual(chunks.map((chunk) => chunk.chunkIndex), expected.map((_, position) => position));
        assert.deepEqual(chunks.map((chunk) => chunk.text), expected);
        assert.ok(chunks.every((chunk) => chunk.vector === null));

        const listed = await request(app).get(`/v1/documents/${document.id}`).set(...ana.auth);
        assert.deepEqual(listed.body.data.indexes.map((item: IndexBody) => item.chunkSize), [500, 1000]);
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1, "one build counted");
    });

    it("takes the size and the model of the default profile when the body gives none, for {} and for no body at all", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const first = await seedLongDocument(ana.id, "first");
        const second = await seedLongDocument(ana.id, "second");
        await seedIndex(first.id, { status: "ready", chunkSize: 500 });
        await seedIndex(second.id, { status: "ready", chunkSize: 500 });

        const withBody = await build(ana.auth, first.id, {});
        const withoutBody = await build(ana.auth, second.id);

        for (const response of [withBody, withoutBody]) {
            assert.equal(response.status, 202, JSON.stringify(response.body));
            assert.equal(response.body.data.chunkSize, 1000);
            assert.equal(response.body.data.embeddingModel, DEFAULT_EMBEDDING_MODEL);
        }
    });

    it("follows the default profile row when it changes", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{chunkSize}', '2000')");

        try {
            const response = await build(ana.auth, document.id, {});

            assert.equal(response.status, 202);
            assert.equal(response.body.data.chunkSize, 2000);
        } finally {
            await ownerPool.query("UPDATE default_profile SET settings = jsonb_set(settings, '{chunkSize}', '1000')");
        }
    });

    it("answers 200 'Index already exists' with the existing index for {} when the default one is there, and counts no build", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "ready", chunkSize: 1000 });
        const before = await counts();

        const response = await build(ana.auth, document.id, {});

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Index already exists");
        assert.equal(response.body.data.id, index.id);
        assert.equal(response.body.data.status, "ready");
        assert.deepEqual(await counts(), before, "no row was added and no build counted");
    });

    it("answers 200 with the same index, and adds no rows and counts no build, for the same size while it is queued, indexing or ready", { timeout: 40_000 }, async () => {
        for (const status of ["queued", "indexing", "ready"] as const) {
            const user = await createTestUser({ email: `${status}@example.com` });
            const document = await seedLongDocument(user.id, status);
            const index = await seedIndex(document.id, { status, chunkSize: 500 });
            const before = await counts();

            const response = await build(user.auth, document.id, { chunkSize: 500 });

            assert.equal(response.status, 200, status);
            assert.equal(response.body.message, "Index already exists", status);
            assert.equal(response.body.data.id, index.id, status);
            assert.equal(response.body.data.status, status, status);
            assert.deepEqual(await counts(), before, `${status}: nothing was added`);
        }
    });

    it("answers 200 for the existing index even when the user is at every cap, because nothing is built", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "queued", chunkSize: 500 });
        await seedIndex((await seedLongDocument(ana.id, "other")).id, { status: "indexing", chunkSize: 500 });
        await seedUsage(ana.id, 4);

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.id, index.id);
    });

    it("queues a failed index again with a 202: attempts back to 0, no error, a later queue time, the stored vectors kept, and one build counted", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const longAgo = new Date("2026-01-01T10:00:00Z");
        const index = await seedIndex(document.id, {
            status: "failed", chunkSize: 500, chunks: 4, embeddedCount: 2, embeddingTokens: 9, attempts: 3, error: "Indexing failed", queuedAt: longAgo, finishedAt: longAgo
        });
        const requestedAt = Date.now() - 1000;

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 202);
        assert.equal(response.body.message, "Index queued for building");
        assert.equal(response.body.data.id, index.id, "the same index, not a new one");
        assert.equal(response.body.data.status, "queued");
        assert.equal(response.body.data.attempts, 0);
        assert.equal(response.body.data.error, null);
        assert.equal(response.body.data.embeddedCount, 2, "the vectors it has are kept");
        assert.equal(response.body.data.queuePosition, 1);
        assert.ok(new Date(response.body.data.queuedAt).getTime() >= requestedAt, "it goes to the back of the line");

        const row = await readIndex(index.id);
        assert.equal(row?.status, "queued");
        assert.equal(row?.attempts, 0);
        assert.equal(row?.error, null);
        assert.equal(row?.finishedAt, null);
        assert.ok(row && row.queuedAt.getTime() > longAgo.getTime());

        const chunks = await readChunks(index.id);
        assert.equal(chunks.length, 4);
        assert.deepEqual(chunks.map((chunk) => chunk.vector !== null), [true, true, false, false], "the two vectors are still there");
        assert.ok(sameVector(chunks[0].vector, new Array<number>(1024).fill(SEEDED_VECTOR_VALUE)));

        assert.equal(await countRows("document_indexes"), 1, "no second index");
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1, "one build counted");
    });

    it("answers 400 and stores nothing and counts no build for a size or model that is not allowed, a text, a question-time setting or an unknown field", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "ready" });
        const before = await counts();

        const bodies: Record<string, object> = {
            "a size that is not allowed": { chunkSize: 400 },
            "a size written as text": { chunkSize: "500" },
            "a size with decimals": { chunkSize: 500.5 },
            "a model that is not allowed": { embeddingModel: "other" },
            "a text": { text: "new text" },
            "a question-time setting": { topK: 5 },
            "an unknown field": { foo: 1 },
            "a status": { status: "ready" },
            "an owner": { userId: randomUUID() }
        };

        for (const [label, body] of Object.entries(bodies)) {
            const response = await build(ana.auth, document.id, body);

            assert.equal(response.status, 400, label);
            assert.equal(response.body.message, "Validation error", label);
            assert.ok(Array.isArray(response.body.details) && response.body.details.length >= 1, label);
        }

        assert.deepEqual(await counts(), before);
    });

    it("answers 404 'Document not found' for another user's document, an unknown id and a malformed id, for an admin too, and creates nothing", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "ready" });
        const before = await counts();

        for (const caller of [bob, admin]) {
            for (const id of [document.id, randomUUID(), "not-a-uuid"]) {
                const response = await build(caller.auth, id, { chunkSize: 500 });

                assert.equal(response.status, 404, id);
                assert.deepEqual(response.body, { message: "Document not found" }, id);
            }
        }

        assert.deepEqual(await counts(), before);
    });

    it("answers 413 for a body over 16 kB, and reads one just under it", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);

        const over = await build(ana.auth, document.id, { chunkSize: 500, note: "a".repeat(17_000) });
        assert.equal(over.status, 413);
        assert.deepEqual(over.body, { message: "request entity too large" });

        const under = await build(ana.auth, document.id, { chunkSize: 500, note: "a".repeat(15_000) });
        assert.equal(under.status, 400, "the body was read, and the field is unknown");
        assert.deepEqual(under.body.details, ["\"note\" is not allowed"]);
    });

    it("answers 401 without a token", { timeout: 20_000 }, async () => {
        const response = await request(app).post(`/v1/documents/${randomUUID()}/indexes`).send({});

        assert.equal(response.status, 401);
    });
});

describe("POST /v1/documents/:id/indexes: the limits", () => {
    it("answers 409 when the user already has the most builds in progress (2): queued and indexing both count, on any of their documents", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const first = await seedLongDocument(ana.id, "first");
        const second = await seedLongDocument(ana.id, "second");
        await seedIndex(first.id, { status: "queued", chunkSize: 1000 });
        await seedIndex(second.id, { status: "indexing", chunkSize: 1000 });
        const before = await counts();

        const response = await build(ana.auth, first.id, { chunkSize: 500 });

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, IN_PROGRESS);
        assert.deepEqual(await counts(), before, "nothing stored, nothing counted");
    });

    it("lets a third build in once one of the two finishes, and does not count ready, failed or another user's builds", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "ready", chunkSize: 300 });
        await seedIndex(document.id, { status: "failed", chunkSize: 750 });
        await seedIndex(document.id, { status: "queued", chunkSize: 1000 });
        const bobs = await seedLongDocument(bob.id);
        await seedIndex(bobs.id, { status: "queued", chunkSize: 1000 });
        await seedIndex(bobs.id, { status: "indexing", chunkSize: 500 });

        const accepted = await build(ana.auth, document.id, { chunkSize: 500 });
        assert.equal(accepted.status, 202, "one in progress, a ready one and a failed one: room for one more");

        const refused = await build(ana.auth, document.id, { chunkSize: 2000 });
        assert.equal(refused.status, 409, "now two are in progress");

        await ownerPool.query("UPDATE document_indexes SET status = 'ready', embedded_count = chunk_count WHERE id = $1", [accepted.body.data.id]);
        assert.equal((await build(ana.auth, document.id, { chunkSize: 2000 })).status, 202, "one finished: room again");
    });

    it("answers 429 when the user has used their builds of the day (4), counts the last day only, and leaves other users alone", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const document = await seedLongDocument(ana.id);
        const bobs = await seedLongDocument(bob.id);
        await seedUsage(ana.id, 3);

        assert.equal((await build(ana.auth, document.id, { chunkSize: 500 })).status, 202, "the fourth build of the day is allowed");

        const before = await counts();
        const response = await build(ana.auth, document.id, { chunkSize: 750 });

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, USER_DAILY);
        assert.deepEqual(await counts(), before, "the refused request counted nothing");

        assert.equal((await build(bob.auth, bobs.id, { chunkSize: 500 })).status, 202, "the limit is per user");
    });

    it("does not count builds accepted more than 24 hours ago, and counts those from 23 hours ago", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedUsage(ana.id, 4, 25);

        assert.equal((await build(ana.auth, document.id, { chunkSize: 500 })).status, 202, "four builds 25 hours old are not counted");

        await ownerPool.query("TRUNCATE index_build_usage");
        await seedUsage(ana.id, 4, 23);

        const response = await build(ana.auth, document.id, { chunkSize: 750 });
        assert.equal(response.status, 429, "four builds 23 hours old are counted");
        assert.deepEqual(response.body, USER_DAILY);
    });

    it("answers 429 'The daily indexing capacity is used up' to a user who has builds left of their own, when the builds of all users in the last day reach the global cap (8 here)", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const cara = await createTestUser({ email: "cara@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedUsage(bob.id, 4);
        await seedUsage(cara.id, 3);

        assert.equal((await build(ana.auth, document.id, { chunkSize: 500 })).status, 202, "7 builds so far: the 8th is allowed");

        const before = await counts();
        const response = await build(ana.auth, document.id, { chunkSize: 750 });

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, GLOBAL_DAILY);
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1, "she has used one of her own four");
        assert.deepEqual(await counts(), before, "the refused request counted nothing");
    });

    it("does not count toward the global cap the builds of other users that are more than 24 hours old", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const cara = await createTestUser({ email: "cara@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedUsage(bob.id, 4, 25);
        await seedUsage(cara.id, 4, 30);

        assert.equal((await build(ana.auth, document.id, { chunkSize: 500 })).status, 202);
    });

    it("gives the user's own 429 when the request is over both the user's cap and the global one", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedUsage(ana.id, 4);
        await seedUsage(bob.id, 4);

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, USER_DAILY, "the user's message comes first");
    });

    // other users' queued builds, `howMany` of them, each on a document of its own (the users' own caps are not the subject here)
    const fillTheQueue = async (howMany: number): Promise<void> => {
        const owners = [await createTestUser({ email: "bob@example.com" }), await createTestUser({ email: "cara@example.com" })];

        for (let index = 0; index < howMany; index++) {
            await seedIndex((await seedLongDocument(owners[index % 2].id, `queued ${index}`)).id, { status: "queued" });
        }
    };

    it("answers 503 when the queue holds the most builds (6) of other users, and stores nothing and counts no build", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await fillTheQueue(6);
        const before = await counts();

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 503);
        assert.deepEqual(response.body, QUEUE_FULL);
        assert.deepEqual(await counts(), before, "nothing stored, nothing counted");
    });

    it("accepts the build that makes the queue full: with five builds queued there is room for the sixth, and then the seventh is refused", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const dan = await createTestUser({ email: "dan@example.com" });
        const anas = await seedLongDocument(ana.id);
        const dans = await seedLongDocument(dan.id);
        await fillTheQueue(5);

        assert.equal((await build(ana.auth, anas.id, { chunkSize: 500 })).status, 202);

        const response = await build(dan.auth, dans.id, { chunkSize: 500 });
        assert.equal(response.status, 503);
        assert.deepEqual(response.body, QUEUE_FULL);
    });

    it("gives the user's daily 429, and not the 503 of a full queue, and the global one before the queue too", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const cara = await createTestUser({ email: "cara@example.com" });
        const document = await seedLongDocument(ana.id);

        for (const user of [bob, cara]) {
            for (let index = 0; index < 3; index++) {
                await seedIndex((await seedLongDocument(user.id, `full ${user.id.slice(0, 4)} ${index}`)).id, { status: "queued" });
            }
        }

        assert.equal((await build(ana.auth, document.id, { chunkSize: 500 })).status, 503, "the queue is full and nothing else is in the way");

        await seedUsage(ana.id, 4);
        const forTheUser = await build(ana.auth, document.id, { chunkSize: 500 });
        assert.equal(forTheUser.status, 429);
        assert.deepEqual(forTheUser.body, USER_DAILY);

        await ownerPool.query("TRUNCATE index_build_usage");
        await seedUsage(bob.id, 4);
        await seedUsage(cara.id, 4);
        const forEverybody = await build(ana.auth, document.id, { chunkSize: 500 });
        assert.equal(forEverybody.status, 429);
        assert.deepEqual(forEverybody.body, GLOBAL_DAILY);
    });

    it("still counts the deleted indexes of the day: four built and deleted, and the fifth is refused", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "ready", chunkSize: 1000 });

        for (const chunkSize of [500, 750, 2000, 5000]) {
            const created = await build(ana.auth, document.id, { chunkSize });
            assert.equal(created.status, 202, `size ${chunkSize}`);
            assert.equal((await removeIndex(ana.auth, document.id, created.body.data.id)).status, 200, `size ${chunkSize} deleted`);
        }

        const response = await build(ana.auth, document.id, { chunkSize: 300 });

        assert.equal(response.status, 429);
        assert.deepEqual(response.body, USER_DAILY);
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 4, "the deleted indexes are still counted");
    });

    it("still counts the builds of documents that were deleted, uploads included", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });

        for (const label of ["one", "two"]) {
            const created = await uploadDocument(ana.auth, label);
            assert.equal(created.status, 202, label);
            assert.equal((await request(app).delete(`/v1/documents/${created.body.data.id}`).set(...ana.auth)).status, 200);
        }

        // the third and the fourth build of the day, each deleted as soon as it is accepted
        const kept = await seedLongDocument(ana.id, "kept");

        for (const chunkSize of [500, 750]) {
            const created = await build(ana.auth, kept.id, { chunkSize });
            assert.equal(created.status, 202, `size ${chunkSize}`);
            assert.equal((await removeIndex(ana.auth, kept.id, created.body.data.id)).status, 200);
        }

        const response = await uploadDocument(ana.auth, "three");
        assert.equal(response.status, 429, "the fifth build is refused: the deleted documents and indexes were counted");
        assert.deepEqual(response.body, USER_DAILY);
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 4);
    });

    it("counts nothing for a request that is refused, whichever way", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex(document.id, { status: "queued", chunkSize: 1000 });
        await seedIndex((await seedLongDocument(ana.id, "second")).id, { status: "queued", chunkSize: 1000 });
        const before = await counts();

        const refusals = [
            await build(ana.auth, document.id, { chunkSize: 400 }),
            await build(ana.auth, randomUUID(), { chunkSize: 500 }),
            await build(bob.auth, document.id, { chunkSize: 500 }),
            await build(ana.auth, document.id, { chunkSize: 500 })
        ];

        assert.deepEqual(refusals.map((response) => response.status), [400, 404, 404, 409]);
        assert.deepEqual(await counts(), before);
    });

    it("answers 409 for a request that is over every cap at once, with the first of them: the documents for an upload, the builds in progress for an index", { timeout: 40_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const documents = [await seedLongDocument(ana.id, "one"), await seedLongDocument(ana.id, "two"), await seedLongDocument(ana.id, "three")];

        // 3 documents (the cap), 2 builds in progress (the cap), 4 builds today (the cap), 8 today in all (the cap), 6 queued in all (the cap)
        await seedIndex(documents[0].id, { status: "queued" });
        await seedIndex(documents[1].id, { status: "queued" });
        for (let index = 0; index < 4; index++) {
            await seedIndex((await seedLongDocument(bob.id, `bob ${index}`)).id, { status: "queued" });
        }
        await seedUsage(ana.id, 4);
        await seedUsage(bob.id, 4);
        const before = await counts();

        const upload = await uploadDocument(ana.auth, "four");
        assert.equal(upload.status, 409);
        assert.deepEqual(upload.body, NO_DOCUMENTS_LEFT);

        const index = await build(ana.auth, documents[2].id, { chunkSize: 500 });
        assert.equal(index.status, 409);
        assert.deepEqual(index.body, IN_PROGRESS);

        assert.deepEqual(await counts(), before);
    });

    it("creates one index and counts one build when two requests for the same size arrive together", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);

        const answers = await Promise.all([build(ana.auth, document.id, { chunkSize: 500 }), build(ana.auth, document.id, { chunkSize: 500 })]);

        assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 202]);
        assert.equal(answers[0].body.data.id, answers[1].body.data.id, "both got the same index");
        assert.equal(await countRows("document_indexes", "document_id = $1", [document.id]), 1);
        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1);
    });

    it("lets only one of two builds of different sizes through when the user has room for one more", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        await seedIndex((await seedLongDocument(ana.id, "busy")).id, { status: "queued" });

        const answers = await Promise.all([build(ana.auth, document.id, { chunkSize: 500 }), build(ana.auth, document.id, { chunkSize: 750 })]);

        assert.deepEqual(answers.map((answer) => answer.status).sort(), [202, 409]);
        assert.equal(await countRows("document_indexes", "document_id = $1", [document.id]), 1);
    });

    it("lets only one of two users through when the builds of the day have room for one more, whatever the order they arrive in", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const dan = await createTestUser({ email: "dan@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const cara = await createTestUser({ email: "cara@example.com" });
        const anas = await seedLongDocument(ana.id);
        const dans = await seedLongDocument(dan.id);
        await seedUsage(bob.id, 4);
        await seedUsage(cara.id, 3);

        const answers = await Promise.all([build(ana.auth, anas.id, { chunkSize: 500 }), build(dan.auth, dans.id, { chunkSize: 500 })]);

        assert.deepEqual(answers.map((answer) => answer.status).sort(), [202, 429]);
        assert.equal(await countRows("index_build_usage"), 8, "never more than the cap");
    });
});

// The text of a document can be a million characters, and cutting it takes the server's time: a request that is going to be
// refused for a cap must not pay for it. There is no way to spy on the function that cuts the text (an ES module's export
// cannot be replaced), so the test watches the one thing that comes before it: the API's own pool reading the text column of
// the documents table. The seeding goes through another pool (the owner's), so every statement seen here is the API's.
describe("POST /v1/documents/:id/indexes: the caps are checked before the document is read and chunked", () => {
    const sqlOf = (argument: unknown): string => (typeof argument === "string" ? argument : String((argument as { text?: unknown })?.text ?? ""));

    const readsOfDocumentText = (spy: { mock: { calls: { arguments: unknown[] }[] } }): string[] =>
        spy.mock.calls.map((call) => sqlOf(call.arguments[0])).filter((sql) => /\btext\b/i.test(sql) && /\bdocuments\b/i.test(sql));

    // other users' queued builds, each on a document of its own
    const fillTheQueue = async (howMany: number): Promise<void> => {
        const owners = [await createTestUser({ email: "bob@example.com" }), await createTestUser({ email: "cara@example.com" })];

        for (let index = 0; index < howMany; index++) {
            await seedIndex((await seedLongDocument(owners[index % 2].id, `queued ${index}`)).id, { status: "queued" });
        }
    };

    it("reads the text of the document when the request is under every cap (the seam sees what it is meant to see)", { timeout: 20_000 }, async (t) => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const spy = t.mock.method(pool, "query");

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 202);
        assert.ok(readsOfDocumentText(spy).length >= 1, "the text was read to be chunked");
    });

    const refusals: Record<string, { status: number; body: object; setUp: (ana: { id: string }) => Promise<void> }> = {
        "409 when the user has the most builds in progress": {
            status: 409,
            body: IN_PROGRESS,
            setUp: async (ana) => {
                await seedIndex((await seedLongDocument(ana.id, "first")).id, { status: "queued" });
                await seedIndex((await seedLongDocument(ana.id, "second")).id, { status: "indexing" });
            }
        },
        "429 when the user has used their builds of the day": {
            status: 429,
            body: USER_DAILY,
            setUp: async (ana) => seedUsage(ana.id, 4)
        },
        "429 when the builds of all users in the last day reach the global cap": {
            status: 429,
            body: GLOBAL_DAILY,
            setUp: async () => {
                await seedUsage((await createTestUser({ email: "bob@example.com" })).id, 4);
                await seedUsage((await createTestUser({ email: "cara@example.com" })).id, 4);
            }
        },
        "503 when the queue is full": {
            status: 503,
            body: QUEUE_FULL,
            setUp: async () => fillTheQueue(6)
        }
    };

    for (const [label, refusal] of Object.entries(refusals)) {
        it(`answers ${label}, without the text of the document being read, and stores and counts nothing`, { timeout: 30_000 }, async (t) => {
            const ana = await createTestUser({ email: "ana@example.com" });
            const document = await seedLongDocument(ana.id);
            await refusal.setUp(ana);
            const before = await counts();
            const spy = t.mock.method(pool, "query");

            const response = await build(ana.auth, document.id, { chunkSize: 500 });

            assert.equal(response.status, refusal.status);
            assert.deepEqual(response.body, refusal.body);
            assert.deepEqual(readsOfDocumentText(spy), [], "the document was not read, so it was not chunked");
            assert.deepEqual(await counts(), before, "nothing stored, nothing counted");
        });
    }

    it("still answers 200 with the existing index, without reading the text, when the user is at every cap", { timeout: 20_000 }, async (t) => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "queued", chunkSize: 500 });
        await seedIndex((await seedLongDocument(ana.id, "other")).id, { status: "indexing", chunkSize: 500 });
        await seedUsage(ana.id, 4);
        const spy = t.mock.method(pool, "query");

        const response = await build(ana.auth, document.id, { chunkSize: 500 });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.id, index.id);
        assert.deepEqual(readsOfDocumentText(spy), []);
    });
});

describe("GET /v1/documents/:id/indexes/:indexId", () => {
    it("returns the index with the counts it has stored", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "indexing", chunkSize: 500, chunks: 5, embeddedCount: 3, embeddingTokens: 11, attempts: 1 });

        const response = await getIndex(ana.auth, document.id, index.id);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Index retrieved successfully");

        const body = response.body.data as IndexBody;
        assert.deepEqual(Object.keys(body).sort(), INDEX_KEYS);
        assert.equal(body.id, index.id);
        assert.equal(body.documentId, document.id);
        assert.equal(body.chunkSize, 500);
        assert.equal(body.embeddingModel, DEFAULT_EMBEDDING_MODEL);
        assert.equal(body.status, "indexing");
        assert.equal(body.chunkCount, 5);
        assert.equal(body.embeddedCount, 3);
        assert.equal(body.embeddingTokens, 11);
        assert.equal(body.attempts, 1);
        assert.equal(body.error, null);
        assert.equal(body.queuePosition, null, "an index that is being built is not in the line");
        assert.equal(typeof body.startedAt, "string");
        assert.equal(body.finishedAt, null);
    });

    it("gives the queue position over every user's queued indexes, in order of queue time, and null for the ones that are not queued", { timeout: 30_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const anas = await seedLongDocument(ana.id);
        const bobs = await seedLongDocument(bob.id);
        const now = Date.now();
        const at = (secondsAgo: number): Date => new Date(now - secondsAgo * 1000);

        const bobFirst = await seedIndex(bobs.id, { chunkSize: 300, queuedAt: at(50) });
        const anaFirst = await seedIndex(anas.id, { chunkSize: 500, queuedAt: at(40) });
        const bobSecond = await seedIndex(bobs.id, { chunkSize: 500, queuedAt: at(30) });
        const anaSecond = await seedIndex(anas.id, { chunkSize: 750, queuedAt: at(20) });
        const building = await seedIndex(bobs.id, { chunkSize: 750, status: "indexing", queuedAt: at(60) });
        const ready = await seedIndex(anas.id, { chunkSize: 1000, status: "ready", queuedAt: at(70) });
        const failed = await seedIndex(anas.id, { chunkSize: 2000, status: "failed", queuedAt: at(80), error: "Indexing failed" });

        const position = async (index: { id: string; documentId: string }, caller = ana): Promise<number | null> =>
            (await getIndex(caller.auth, index.documentId, index.id)).body.data.queuePosition;

        assert.equal(await position(anaFirst), 2, "bob's index queued before it comes first");
        assert.equal(await position(anaSecond), 4, "bob's second one is ahead of it too");
        assert.equal(await position(bobFirst, bob), 1);
        assert.equal(await position(bobSecond, bob), 3);
        assert.equal(await position(building, bob), null);
        assert.equal(await position(ready), null);
        assert.equal(await position(failed), null);
    });

    it("breaks a tie in the queue time by the id of the index", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const sameTime = new Date(Date.now() - 10_000);
        const indexes = [
            await seedIndex(document.id, { chunkSize: 300, queuedAt: sameTime }),
            await seedIndex(document.id, { chunkSize: 500, queuedAt: sameTime }),
            await seedIndex(document.id, { chunkSize: 750, queuedAt: sameTime })
        ];
        const byId = [...indexes].sort((a, b) => (a.id < b.id ? -1 : 1));

        for (const [place, index] of byId.entries()) {
            assert.equal((await getIndex(ana.auth, document.id, index.id)).body.data.queuePosition, place + 1, `place ${place + 1}`);
        }
    });

    it("shows the error of a failed index, and its finish time", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "failed", attempts: 3, error: "Indexing failed" });

        const response = await getIndex(ana.auth, document.id, index.id);

        assert.equal(response.status, 200);
        assert.equal(response.body.data.status, "failed");
        assert.equal(response.body.data.error, "Indexing failed");
        assert.equal(response.body.data.attempts, 3);
        assert.equal(typeof response.body.data.finishedAt, "string");
    });

    it("answers 404 'Index not found' for an index of another of the caller's documents, an unknown index and a malformed index id", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const first = await seedLongDocument(ana.id, "first");
        const second = await seedLongDocument(ana.id, "second");
        const index = await seedIndex(second.id);

        for (const [documentId, indexId] of [[first.id, index.id], [second.id, randomUUID()], [second.id, "not-a-uuid"]]) {
            const response = await getIndex(ana.auth, documentId, indexId);

            assert.equal(response.status, 404, `${documentId} ${indexId}`);
            assert.deepEqual(response.body, { message: "Index not found" }, indexId);
        }

        assert.equal((await getIndex(ana.auth, second.id, index.id)).status, 200, "under its own document it is found");
    });

    it("answers 404 'Document not found' for another user's document, an unknown document and a malformed document id, for an admin too", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id);

        for (const caller of [bob, admin]) {
            for (const documentId of [document.id, randomUUID(), "not-a-uuid"]) {
                const response = await getIndex(caller.auth, documentId, index.id);

                assert.equal(response.status, 404, documentId);
                assert.deepEqual(response.body, { message: "Document not found" }, documentId);
            }
        }
    });

    it("answers 401 without a token", { timeout: 20_000 }, async () => {
        assert.equal((await request(app).get(`/v1/documents/${randomUUID()}/indexes/${randomUUID()}`)).status, 401);
    });
});

describe("DELETE /v1/documents/:id/indexes/:indexId", () => {
    it("removes the index and its chunks, keeps the document and its other indexes, and answers 200 without data", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const doomed = await seedIndex(document.id, { chunkSize: 500, status: "ready", chunks: 4 });
        const kept = await seedIndex(document.id, { chunkSize: 1000, status: "ready", chunks: 3 });

        const response = await removeIndex(ana.auth, document.id, doomed.id);

        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Index deleted successfully");
        assert.equal("data" in response.body, false);
        assert.equal(await readIndex(doomed.id), undefined);
        assert.equal(await countRows("chunks", "index_id = $1", [doomed.id]), 0);
        assert.equal(await countRows("documents"), 1);
        assert.ok(await readIndex(kept.id), "the other index is still there");
        assert.equal(await countRows("chunks", "index_id = $1", [kept.id]), 3);
        assert.equal((await getIndex(ana.auth, document.id, doomed.id)).status, 404);
    });

    it("does not give the build back: the usage rows stay", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const created = await build(ana.auth, document.id, { chunkSize: 500 });

        await removeIndex(ana.auth, document.id, created.body.data.id);

        assert.equal(await countRows("index_build_usage", "user_id = $1", [ana.id]), 1);
    });

    it("answers 404 for another user's index, an unknown one and a malformed one, and deletes nothing", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const first = await seedLongDocument(ana.id, "first");
        const second = await seedLongDocument(ana.id, "second");
        const index = await seedIndex(first.id, { status: "ready" });
        const before = await counts();

        for (const caller of [bob, admin]) {
            for (const documentId of [first.id, randomUUID(), "not-a-uuid"]) {
                const response = await removeIndex(caller.auth, documentId, index.id);

                assert.equal(response.status, 404, documentId);
                assert.deepEqual(response.body, { message: "Document not found" }, documentId);
            }
        }

        for (const [documentId, indexId] of [[second.id, index.id], [first.id, randomUUID()], [first.id, "not-a-uuid"]]) {
            const response = await removeIndex(ana.auth, documentId, indexId);

            assert.equal(response.status, 404, `${documentId} ${indexId}`);
            assert.deepEqual(response.body, { message: "Index not found" }, indexId);
        }

        assert.deepEqual(await counts(), before, "nothing was deleted");
    });

    it("answers 404 the second time", { timeout: 20_000 }, async () => {
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedLongDocument(ana.id);
        const index = await seedIndex(document.id, { status: "ready" });

        assert.equal((await removeIndex(ana.auth, document.id, index.id)).status, 200);
        assert.equal((await removeIndex(ana.auth, document.id, index.id)).status, 404);
    });
});
