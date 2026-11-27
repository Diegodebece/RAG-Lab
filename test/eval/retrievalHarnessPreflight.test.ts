import "../routes/relaxedLimits.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelList, startFakeOllama } from "../doubles/fakeOllama.js";
import { CASES, INSTALLED_MODELS, keywordEmbeddings, startRecordingServer, writeDataFolder } from "./harnessFixtures.js";
import type { RecordingServer } from "./harnessFixtures.js";

// The preflight of a sweep (added to the plan's list): before it uploads a document or builds an index, the harness reads the server's
// limits (GET /v1/configuration), works out how many questions and builds the sweep needs, and refuses when they cannot fit, naming
// each variable to raise. A sweep that stopped halfway on a daily limit would have spent the limit for nothing. The limits here are too
// small on purpose: 5 questions a day and 1 index build a day, for a sweep that needs 12 searches and more than one build.
// The same contract as retrievalHarness.test.ts: runRetrievalSweep(options) resolves with { exitCode, folder, message, unmatched }.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_QUESTIONS_PER_DAY = "5";
process.env.MAX_INDEX_BUILDS_PER_DAY = "1";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("../routes/testUsers.js");
const { countRows } = await import("../documentsFixtures.js");
const { runRetrievalSweep } = await import("../../src/eval/retrievalHarness.js");

const EMAIL = "harness@example.com";
const PASSWORD = "invented-harness-password-Qx92";

let work = "";
let server: RecordingServer;

before(async () => {
    await resetTestDatabase();
    server = await startRecordingServer(app);
    work = await mkdtemp(path.join(tmpdir(), "rag-lab-preflight-"));
    fake.respond("/api/embed", keywordEmbeddings);
    fake.respond("/api/tags", modelList(INSTALLED_MODELS));
    await createTestUser({ email: EMAIL, passwordHash: await makePasswordHash(PASSWORD) });
});

after(async () => {
    await server.close();
    await fake.close();
    await rm(work, { recursive: true, force: true });
    await ownerPool.query("TRUNCATE users CASCADE");
    await closeTestPools();
});

describe("the preflight of a sweep", () => {
    it("refuses a sweep that does not fit the daily limits, naming each variable to raise, and uploads, builds and searches nothing", { timeout: 60_000 }, async () => {
        const dataDirectory = await mkdtemp(path.join(work, "data-"));
        await writeDataFolder(dataDirectory, "invented", CASES);
        const lines: string[] = [];

        const outcome = await runRetrievalSweep({
            apiUrl: server.url,
            email: EMAIL,
            password: PASSWORD,
            dataDirectory,
            setName: "invented",
            sizes: [300, 500],
            buildTimeoutMs: 30_000,
            pollIntervalMs: 40,
            now: () => new Date(Date.UTC(2026, 10, 27, 10, 0, 0)),
            output: (line: string) => { lines.push(line); }
        });

        assert.equal(outcome.exitCode, 1);
        assert.equal(outcome.folder, null);
        assert.ok(outcome.message?.includes("MAX_QUESTIONS_PER_DAY"), String(outcome.message));
        assert.ok(outcome.message?.includes("MAX_INDEX_BUILDS_PER_DAY"), String(outcome.message));
        assert.ok(!outcome.message?.includes("MAX_DOCUMENT_CHARACTERS"), "a limit that fits is not named");
        assert.ok(!String(outcome.message).includes(PASSWORD));
        assert.equal(server.requests.filter((request) => request.method === "POST" && request.url === "/v1/documents").length, 0, "no upload");
        assert.equal(server.requests.filter((request) => request.url.endsWith("/search")).length, 0, "no search");
        assert.equal(await countRows("documents"), 0);
        assert.equal(await countRows("runs"), 0);
    });
});
