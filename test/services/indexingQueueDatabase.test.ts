import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { embeddings, modelList, startFakeOllama, waitForRequests } from "../doubles/fakeOllama.js";

// What the indexing worker does when the database, and not the model server, is what fails or is busy. The model server is
// the double of test/doubles/fakeOllama.ts; the database trouble is made with a trigger on the chunks table that the test
// creates (as the database owner) and always drops. The trigger runs inside the API's own statements, so the code under test
// meets a real lock wait and a real error, with nothing replaced.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.AUTHENTICATED_REQUESTS_PER_MINUTE = "100000";
process.env.REQUESTS_PER_ADDRESS_PER_MINUTE = "100000";

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("../routes/testUsers.js");
const { DEFAULT_EMBEDDING_MODEL, chunkTexts, countRows, readIndex, seedDocument, seedIndex, waitFor } = await import("../documentsFixtures.js");
const queue = await import("../../src/v1/services/indexingQueue.service.js");
const { subscribeToEvents } = await import("../../src/v1/services/events.service.js");

before(resetTestDatabase);

let events: Record<string, unknown>[] = [];
let unsubscribe: () => void = () => {};

// the key of the advisory lock the test holds to stop a statement of the worker at a known point
const HOLD_KEY = 7_340_101;

const dropTriggers = async (): Promise<void> => {
    await ownerPool.query("DROP TRIGGER IF EXISTS test_hold_chunk_writes ON chunks");
    await ownerPool.query("DROP TRIGGER IF EXISTS test_refuse_chunk_writes ON chunks");
    await ownerPool.query("DROP FUNCTION IF EXISTS test_hold_chunk_writes()");
    await ownerPool.query("DROP FUNCTION IF EXISTS test_refuse_chunk_writes()");
};

beforeEach(async () => {
    await dropTriggers();
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", embeddings());
    fake.respond("/api/tags", modelList([DEFAULT_EMBEDDING_MODEL]));
    events = [];
    unsubscribe = subscribeToEvents((event) => events.push(event as unknown as Record<string, unknown>));
});

afterEach(async () => {
    unsubscribe();
    await queue.stopIndexingWorkerService();
    await dropTriggers();
});

after(async () => {
    await fake.close();
    await closeTestPools();
});

const tagRequests = () => fake.requests.filter((request) => request.path === "/api/tags");

// fails the test instead of waiting for ever for something that does not happen
const within = async <T>(milliseconds: number, what: string, promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} did not happen within ${milliseconds} ms`)), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
};

describe("storing a batch while the index is deleted", () => {
    // The worker stores a batch in one transaction (the vectors on the chunks, then the counts on the index) and the delete
    // of an index removes the index row, and its chunks with it. Two transactions that take the same rows in opposite orders
    // wait for each other: PostgreSQL ends one of them with a deadlock error after a second. The test holds the store right
    // after its write to the chunks (a statement trigger waits for an advisory lock that the test owns), sends the delete
    // while it is held, waits until the delete is waiting for a lock, and lets the store go on. Whatever order the store
    // takes the rows in, the two are then in contact at the worst moment: with the same order for both, the second waits
    // for the first and both finish; with opposite orders, each holds what the other needs.
    //
    // The limit of the test: it makes the dangerous interleaving happen on purpose, once. It proves that this interleaving
    // ends well, not that no other can end badly; and the deadlock it detects takes PostgreSQL's deadlock_timeout (a second)
    // to be declared, which is why a failure is slow.
    it("lets the delete succeed with a 200 and ends the build quietly, with no deadlock and no 500, when the delete comes while a batch is being stored", { timeout: 60_000 }, async (t) => {
        const logged = t.mock.method(console, "error", () => {});
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id, { text: "A short invented document." });
        const index = await seedIndex(document.id, { chunks: chunkTexts("deadlock", 25) });

        const holder = await ownerPool.connect();

        try {
            await holder.query("SELECT pg_advisory_lock($1)", [HOLD_KEY]);
            await ownerPool.query(`
                CREATE FUNCTION test_hold_chunk_writes() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    PERFORM pg_advisory_lock(${HOLD_KEY});
                    PERFORM pg_advisory_unlock(${HOLD_KEY});
                    RETURN NULL;
                END $$`);
            await ownerPool.query("CREATE TRIGGER test_hold_chunk_writes AFTER UPDATE ON chunks FOR EACH STATEMENT EXECUTE FUNCTION test_hold_chunk_writes()");

            const draining = queue.processQueuedIndexesService().then(() => "ended" as const, (error: unknown) => error);

            await waitForRequests(fake, "/api/embed", 1);
            await waitFor(
                "the store to be held after its write to the chunks",
                async () => (await ownerPool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount === 1 ? true : undefined,
                10_000
            );

            const deleting = (async () => request(app).delete(`/v1/documents/${document.id}/indexes/${index.id}`).set(...ana.auth))();

            await waitFor(
                "the delete to wait for a lock",
                async () => (await ownerPool.query(
                    "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'DELETE FROM document_indexes%'"
                )).rowCount === 1 ? true : undefined,
                10_000
            );

            await holder.query("SELECT pg_advisory_unlock($1)", [HOLD_KEY]);

            const deleted = await within(30_000, "the answer to the delete", deleting);
            assert.equal(deleted.status, 200, `the delete failed: ${JSON.stringify(deleted.body)}`);

            const outcome = await within(30_000, "the end of the build", draining);
            assert.equal(outcome, "ended", `the build ended with an error: ${String(outcome)}`);

            assert.equal(await readIndex(index.id), undefined, "the index is gone");
            assert.equal(await countRows("chunks", "index_id = $1", [index.id]), 0, "and its chunks");
            assert.equal(tagRequests().length, 0, "the build did not take a database failure for the model server failing");
            assert.equal(logged.mock.callCount(), 0, "nothing was logged as an error: no deadlock, no failed build");
            assert.ok(!events.some((event) => event.type === "failed"));
        } finally {
            await holder.query("SELECT pg_advisory_unlock_all()").catch(() => {});
            holder.release();
        }
    });
});

// A database that fails while a batch is stored is not the model server's fault: asking Ollama whether it is up, counting an
// attempt against it or queueing the index again as if Ollama were away would blame the wrong party, and the "away" answer
// would repeat every poll for ever. The index is left as it was claimed ("indexing"), where the check for stuck builds puts
// it back in the queue after a minute, or it goes back in the queue at once: both are fine. What it must not do is fail,
// count an attempt, or ask Ollama.
describe("a database error while a batch is stored", () => {
    it("is not taken for Ollama failing: no probe of /api/tags, no attempt counted, and the index is not failed", { timeout: 40_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const ana = await createTestUser({ email: "ana@example.com" });
        const document = await seedDocument(ana.id, { text: "A short invented document." });
        const index = await seedIndex(document.id, { chunks: chunkTexts("refused", 15) });

        await ownerPool.query(`
            CREATE FUNCTION test_refuse_chunk_writes() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'the chunk write was refused';
            END $$`);
        await ownerPool.query("CREATE TRIGGER test_refuse_chunk_writes BEFORE UPDATE ON chunks FOR EACH ROW EXECUTE FUNCTION test_refuse_chunk_writes()");

        // an error of the run is how the queue reports a database failure: it is logged in the background, and does not end the test
        await within(20_000, "the run", queue.processQueuedIndexesService().then(() => undefined, () => undefined));

        const row = await readIndex(index.id);
        assert.equal(tagRequests().length, 0, "Ollama was not asked if it is up");
        assert.equal(row?.attempts, 0, "no attempt was counted against Ollama");
        assert.notEqual(row?.status, "failed", "a database failure is not the index's failure");
        assert.equal(row?.embeddedCount, 0, "nothing was stored");
        assert.ok(!events.some((event) => event.type === "failed"));
    });
});
