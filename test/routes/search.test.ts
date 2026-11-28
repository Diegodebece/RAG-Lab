import "./relaxedLimits.js";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { dropConnection, embeddings, embeddingsFor, fakeTokenCount, startFakeOllama, waitForRequests } from "../doubles/fakeOllama.js";

// POST /v1/documents/:id/search (layer 5): the first route that calls a model while the request waits. It resolves the caller's
// configuration, finds the READY index of the document for the chunk size and model, embeds the question with the fake Ollama,
// searches that index and stores one run. Overrides of the five answer settings are refused: a search never accepts and ignores a
// setting. The model server is the double of test/doubles/fakeOllama.ts, which also records every request.
process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser } = await import("./testUsers.js");
const { DEFAULT_EMBEDDING_MODEL, countRows, readRuns, seedDocument, seedIndex, sha256Of } = await import("../documentsFixtures.js");
const { DEFAULT_SETTINGS, canonicalText, sha256Hex } = await import("../configurationFixtures.js");
const { pool } = await import("../../src/v1/config/db.config.js");

// Round 2 (the audit's findings), the contracts these tests pick where the plan left them open:
//   - the stored question_hash is an HMAC-SHA-256 of the trimmed question as UTF-8, keyed by createHmac("sha256", SECRET_KEY)
//     .update("rag-lab:question-hash:v1").digest() (F11 / O4), not the plain SHA-256 any reader of the table could compute
//   - a usage row (question_usage) is written for every embedding that came back, whether or not the run is stored (F6)
//   - the INSERT INTO runs goes through the app's pool.query, so a test can make it fail once with SQLSTATE 23503 (F4, T2)
//   - a search whose index or document is gone when the matches come back empty answers what it would have answered before the
//     embedding: 404 "Document not found", 409 "This document has no ready index for chunk size N", and stores no run (F4)
//   - a prompt_eval_count of 2 ** 31 is a malformed model answer, refused before anything is stored: the generic 500 like every other
//     malformed answer (the plan said 502, but a malformed answer is a plain Error that errorMiddleware answers with a 500) (O5)

before(resetTestDatabase);

beforeEach(async () => {
    await ownerPool.query("TRUNCATE users CASCADE");
    fake.requests.splice(0);
    fake.respond("/api/embed", embeddingsFor(VECTORS));
});

// some tests damage the default profile
afterEach(() => ownerPool.query("UPDATE default_profile SET version = 1, settings = $1::jsonb", [JSON.stringify(DEFAULT_SETTINGS)]));

after(async () => {
    await fake.close();
    await closeTestPools();
});

type Auth = [string, string];

const QUESTION = "What colour is the sky?";

// The question is the vector (1, 0). The chunks of the default index, with their scores against it: 0, 0.6, 0.8, 1, 0, 0. At the
// default settings (topK 3, minScore 0.3, window 1) the matches are chunks 3, 2 and 1, and their neighbors are 4 and 0.
const VECTORS: Record<string, number[]> = { [QUESTION]: [1, 0] };
const CHUNKS = ["alpha chunk", "bravo chunk", "charlie chunk", "delta chunk", "echo chunk", "foxtrot chunk"];
const CHUNK_VECTORS = [[0, 1], [3, 4], [4, 3], [1, 0], [0, 1], [0, 0, 1]];

const search = (auth: Auth, documentId: string, body: unknown) => request(app).post(`/v1/documents/${documentId}/search`).set(...auth).send(body as object);

const embedRequests = () => fake.requests.filter((entry) => entry.path === "/api/embed");

// fails instead of waiting for ever
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

// what the table keeps of a question: an HMAC, keyed from the server's secret, so the hash of a guessed question cannot be computed
// by anyone who only holds the table
const questionHashOf = (question: string): string => {
    const key = createHmac("sha256", process.env.SECRET_KEY ?? "").update("rag-lab:question-hash:v1").digest();

    return createHmac("sha256", key).update(question, "utf8").digest("hex");
};

// a user with a document that has a ready index of the default size and model, with the chunks above
const seedSearchable = async (email: string, options: { chunkSize?: number; chunks?: string[]; vectors?: number[][]; filename?: string } = {}) => {
    const user = await createTestUser({ email });
    const document = await seedDocument(user.id, { filename: options.filename ?? "notes.txt" });
    const index = await seedIndex(document.id, { status: "ready", chunkSize: options.chunkSize ?? 1000, chunks: options.chunks ?? CHUNKS, vectors: options.vectors ?? CHUNK_VECTORS });

    return { user, document, index };
};

const seedProfile = async (userId: string, settings: object, name = "Mine"): Promise<string> =>
    (await ownerPool.query<{ id: string }>("INSERT INTO profiles (user_id, name, version, settings) VALUES ($1, $2, 1, $3::jsonb) RETURNING id", [userId, name, JSON.stringify(settings)])).rows[0].id;

const DATA_KEYS = ["configuration", "configurationHash", "createdAt", "documentId", "fragments", "id", "indexId", "kind", "profileId", "status", "timings", "tokens"];

// everything a refusal must leave as it was: no run, no usage, no index, no request to the model server
const everyRow = async (): Promise<number[]> => [
    await countRows("runs"), await countRows("index_build_usage"), await countRows("document_indexes"), await countRows("chunks"), await countRows("documents")
];

const assertRefused = async (response: request.Response, status: number, body: object, rowsBefore: number[], label = "the refusal"): Promise<void> => {
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(response.body, body, label);
    assert.equal(await countRows("runs"), 0, `${label}: no run was stored`);
    assert.deepEqual(await everyRow(), rowsBefore, `${label}: no row of any table was added or removed`);
    assert.deepEqual(embedRequests(), [], `${label}: nothing was sent to the model server`);
};

interface FragmentBody {
    id: string;
    chunkIndex: number;
    text: string;
    retrieval: string;
    score?: number;
}

describe("POST /v1/documents/:id/search: a search that finds something", () => {
    it("answers 200 with the run: the exact keys, status matched, and the fragments in order, with their texts and exact scores", { timeout: 20_000 }, async () => {
        const { user, document, index } = await seedSearchable("ana@example.com");

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.success, true);
        assert.equal(response.body.message, "Search completed successfully");

        const run = response.body.data;
        assert.deepEqual(Object.keys(run).sort(), DATA_KEYS);
        assert.match(run.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(run.kind, "retrieval");
        assert.equal(run.status, "matched");
        assert.equal(run.documentId, document.id);
        assert.equal(run.indexId, index.id);
        assert.equal(run.profileId, null);
        assert.equal(new Date(run.createdAt).toISOString(), run.createdAt, "the date is written as ISO 8601");

        assert.deepEqual(run.fragments, [
            { id: "F1", chunkIndex: 3, text: "delta chunk", retrieval: "match", score: 1 },
            { id: "F2", chunkIndex: 2, text: "charlie chunk", retrieval: "match", score: 0.8 },
            { id: "F3", chunkIndex: 1, text: "bravo chunk", retrieval: "match", score: 0.6 },
            { id: "F4", chunkIndex: 4, text: "echo chunk", retrieval: "neighbor" },
            { id: "F5", chunkIndex: 0, text: "alpha chunk", retrieval: "neighbor" }
        ]);
    });

    it("reports the configuration it ran with, the six retrieval settings of the default profile, and the SHA-256 of its canonical text", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        const { body } = await search(user.auth, document.id, { question: QUESTION });

        assert.deepEqual(body.data.configuration, {
            kind: "retrieval",
            version: 1,
            settings: { chunkSize: 1000, embeddingModel: DEFAULT_EMBEDDING_MODEL, retrievalMode: "vector", topK: 3, minScore: 0.3, neighborWindow: 1 }
        });
        assert.match(body.data.configurationHash, /^[0-9a-f]{64}$/);
        assert.equal(body.data.configurationHash, sha256Hex(canonicalText(body.data.configuration)), "computed here, from the configuration in the answer");
    });

    it("reports the tokens the question took and the timings, as numbers that are never negative, in milliseconds with two decimals", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        const { body } = await search(user.auth, document.id, { question: QUESTION });

        assert.deepEqual(body.data.tokens, { embedding: fakeTokenCount(QUESTION) });
        assert.deepEqual(Object.keys(body.data.timings).sort(), ["embeddingMs", "retrievalMs", "totalMs", "waitMs"]);

        for (const [name, value] of Object.entries(body.data.timings) as [string, number][]) {
            assert.ok(Number.isFinite(value) && value >= 0, `${name} is ${value}`);
            assert.equal(Number(value.toFixed(2)), value, `${name} has at most two decimals`);
        }

        assert.ok(body.data.timings.totalMs >= body.data.timings.embeddingMs, "the whole is at least the embedding");
    });

    it("stores exactly one run, equal to the response, with the hash and the length of the trimmed question, no text, and no usage or index row", { timeout: 20_000 }, async () => {
        const { user, document, index } = await seedSearchable("ana@example.com");
        const asked = "Qué hora es?";
        fake.respond("/api/embed", embeddingsFor({ ...VECTORS, [asked]: [1, 0] }));
        const rowsBefore = [await countRows("index_build_usage"), await countRows("document_indexes"), await countRows("chunks")];

        const response = await search(user.auth, document.id, { question: `   ${asked}\n ` });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        const runs = await readRuns();
        assert.equal(runs.length, 1);

        const [row] = runs;
        const body = response.body.data;
        assert.equal(row.id, body.id);
        assert.equal(row.userId, user.id);
        assert.equal(row.kind, "retrieval");
        assert.equal(row.status, body.status);
        assert.equal(row.documentId, document.id);
        assert.equal(row.indexId, index.id);
        assert.equal(row.profileId, null);
        assert.deepEqual(row.configuration, body.configuration);
        assert.equal(row.configurationHash, body.configurationHash);
        assert.equal(row.questionHash, questionHashOf(asked), "the HMAC of the trimmed question as UTF-8");
        assert.equal(row.questionCharacters, asked.length);
        assert.equal(row.embeddingTokens, body.tokens.embedding);
        assert.deepEqual([row.waitMs, row.embeddingMs, row.retrievalMs, row.totalMs], [body.timings.waitMs, body.timings.embeddingMs, body.timings.retrievalMs, body.timings.totalMs]);
        assert.equal(row.createdAt.toISOString(), body.createdAt);
        assert.deepEqual(
            row.fragments,
            (body.fragments as FragmentBody[]).map((fragment) => (fragment.score === undefined ? { chunkIndex: fragment.chunkIndex, retrieval: fragment.retrieval } : { chunkIndex: fragment.chunkIndex, retrieval: fragment.retrieval, score: fragment.score })),
            "the positions, the kind and the score of each fragment, in the order of the response"
        );
        assert.deepEqual([await countRows("index_build_usage"), await countRows("document_indexes"), await countRows("chunks")], rowsBefore, "a search builds nothing and counts no build");
    });

    it("keeps neither the question nor any chunk text anywhere in the run it stores", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        await search(user.auth, document.id, { question: QUESTION });

        const { rows } = await ownerPool.query<{ everything: string }>("SELECT runs::text AS everything FROM runs");
        assert.equal(rows.length, 1);

        for (const secret of [QUESTION, "colour", "sky", ...CHUNKS]) {
            assert.ok(!rows[0].everything.includes(secret), `the stored row holds "${secret}"`);
        }

        const [run] = await readRuns();
        assert.ok(run.fragments.every((fragment) => !("text" in fragment)), "the fragments hold positions and scores, never text");
    });

    it("sends exactly one request to Ollama, an embedding of the trimmed question, with the model of the index and truncate false", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        await search(user.auth, document.id, { question: `  ${QUESTION}  ` });

        assert.deepEqual(fake.requests.map((entry) => entry.path), ["/api/embed"], "nothing else, such as a model list or a second embedding");
        assert.deepEqual(embedRequests()[0].body, { model: "qwen3-embedding:0.6b", input: [QUESTION], truncate: false });
    });

    it("embeds the raw question as it was asked, with no instruction or prefix added (RAG Web's evaluated behavior)", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const question = "Which planet has rings? And why?";

        await search(user.auth, document.id, { question });

        assert.deepEqual((embedRequests()[0].body as { input: string[] }).input, [question]);
    });

    it("uses the chunk size of the override to pick the index of that size, and answers with its chunks and its id", { timeout: 20_000 }, async () => {
        const { user, document, index } = await seedSearchable("ana@example.com");
        const smaller = await seedIndex(document.id, { status: "ready", chunkSize: 500, chunks: ["small one", "small two", "small three"], vectors: [[0, 1], [4, 3], [0, 1]] });

        const defaultSize = await search(user.auth, document.id, { question: QUESTION });
        const picked = await search(user.auth, document.id, { question: QUESTION, overrides: { chunkSize: 500 } });

        assert.equal(defaultSize.body.data.indexId, index.id);
        assert.equal(picked.status, 200, JSON.stringify(picked.body));
        assert.equal(picked.body.data.indexId, smaller.id);
        assert.equal(picked.body.data.configuration.settings.chunkSize, 500);
        assert.deepEqual((picked.body.data.fragments as FragmentBody[]).map((fragment) => fragment.text), ["small two", "small one", "small three"]);
    });

    it("uses the settings of the profile, lets the overrides win over it, and answers with the profile's id", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const profileId = await seedProfile(user.id, { topK: 1, minScore: 0.7, neighborWindow: 2, temperature: 0.5, answerLanguage: "es" });

        const fromProfile = await search(user.auth, document.id, { question: QUESTION, profileId });
        const overridden = await search(user.auth, document.id, { question: QUESTION, profileId, overrides: { topK: 2 } });

        assert.equal(fromProfile.status, 200, JSON.stringify(fromProfile.body));
        assert.equal(fromProfile.body.data.profileId, profileId);
        assert.deepEqual(fromProfile.body.data.configuration.settings, { chunkSize: 1000, embeddingModel: DEFAULT_EMBEDDING_MODEL, retrievalMode: "vector", topK: 1, minScore: 0.7, neighborWindow: 2 });
        assert.deepEqual((fromProfile.body.data.fragments as FragmentBody[]).map((fragment) => fragment.chunkIndex), [3, 1, 2, 4, 5], "one match and its four neighbors");
        assert.equal(overridden.body.data.configuration.settings.topK, 2, "the override wins");
        assert.equal(overridden.body.data.configuration.settings.minScore, 0.7, "the rest is the profile's");
        assert.deepEqual((overridden.body.data.fragments as FragmentBody[]).filter((fragment) => fragment.retrieval === "match").map((fragment) => fragment.chunkIndex), [3, 2]);
        assert.equal((await readRuns("profile_id = $1", [profileId])).length, 2, "the runs name the profile");
    });

    it("leaves the answer settings of a profile out of the run, and runs that differ only in them have one hash", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const cool = await seedProfile(user.id, { temperature: 0.2 }, "Cool");
        const warm = await seedProfile(user.id, { temperature: 0.8, answerLanguage: "es", maxTokens: 50 }, "Warm");
        const wide = await seedProfile(user.id, { topK: 5 }, "Wide");

        const bodies = [
            (await search(user.auth, document.id, { question: QUESTION })).body.data,
            (await search(user.auth, document.id, { question: QUESTION, profileId: cool })).body.data,
            (await search(user.auth, document.id, { question: QUESTION, profileId: warm })).body.data,
            (await search(user.auth, document.id, { question: QUESTION, profileId: wide })).body.data
        ];

        assert.equal(bodies[0].configurationHash, bodies[1].configurationHash, "temperature 0 and 0.2");
        assert.equal(bodies[0].configurationHash, bodies[2].configurationHash, "temperature, language and max tokens do not change the search");
        assert.notEqual(bodies[0].configurationHash, bodies[3].configurationHash, "topK does");
        assert.notEqual(bodies[1].profileId, bodies[2].profileId, "the profiles are different ones");

        for (const body of bodies) {
            assert.deepEqual(Object.keys(body.configuration.settings).sort(), ["chunkSize", "embeddingModel", "minScore", "neighborWindow", "retrievalMode", "topK"]);
        }

        assert.equal(new Set((await readRuns()).map((run) => run.configurationHash)).size, 2, "two hashes among the four stored runs");
    });

    it("returns the neighbors two chunks away at window 2, in the order m-2, m-1, m+1, m+2", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        const response = await search(user.auth, document.id, { question: QUESTION, overrides: { topK: 1, neighborWindow: 2 } });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual((response.body.data.fragments as FragmentBody[]).map((fragment) => [fragment.id, fragment.chunkIndex, fragment.retrieval]), [
            ["F1", 3, "match"], ["F2", 1, "neighbor"], ["F3", 2, "neighbor"], ["F4", 4, "neighbor"], ["F5", 5, "neighbor"]
        ]);
    });

    it("keeps a chunk whose score is exactly minScore: (3, 4) against (1, 0) scores 0.6, which a minimum of 0.6 lets in", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        const response = await search(user.auth, document.id, { question: QUESTION, overrides: { topK: 10, minScore: 0.6, neighborWindow: 1 } });

        assert.deepEqual(
            (response.body.data.fragments as FragmentBody[]).filter((fragment) => fragment.retrieval === "match").map((fragment) => [fragment.chunkIndex, fragment.score]),
            [[3, 1], [2, 0.8], [1, 0.6]]
        );
    });

    it("accepts a question of exactly 1000 characters, also written with spaces around it, and runs it", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const longest = "q".repeat(1000);

        const plain = await search(user.auth, document.id, { question: longest });
        const padded = await search(user.auth, document.id, { question: `  ${longest}  ` });

        assert.equal(plain.status, 200, JSON.stringify(plain.body));
        assert.equal(padded.status, 200, "the limit is counted after trimming");
        assert.deepEqual(embedRequests().map((entry) => (entry.body as { input: string[] }).input), [[longest], [longest]]);
        assert.deepEqual((await readRuns()).map((run) => run.questionCharacters), [1000, 1000]);
    });
});

describe("POST /v1/documents/:id/search: a search that finds nothing", () => {
    it("answers 200 with status no_match and no fragments, and stores the run with its tokens", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com", { vectors: [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1]] });

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.status, "no_match");
        assert.deepEqual(response.body.data.fragments, []);
        assert.deepEqual(response.body.data.tokens, { embedding: fakeTokenCount(QUESTION) });

        const runs = await readRuns();
        assert.equal(runs.length, 1, "a search that matched nothing is a run too");
        assert.equal(runs[0].status, "no_match");
        assert.deepEqual(runs[0].fragments, []);
        assert.equal(runs[0].embeddingTokens, fakeTokenCount(QUESTION));
    });
});

describe("POST /v1/documents/:id/search: the question hash (F11 / O4) and the usage row (F6)", () => {
    it("stores an HMAC of the trimmed question, keyed from SECRET_KEY, and not its plain SHA-256: the stored hash differs from sha256(question)", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        const response = await search(user.auth, document.id, { question: `  ${QUESTION}\n` });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        const [run] = await readRuns();

        assert.notEqual(run.questionHash, sha256Of(QUESTION), "anyone with the table could compute the plain SHA-256 of a guessed question");
        assert.equal(run.questionHash, questionHashOf(QUESTION));
        assert.match(run.questionHash, /^[0-9a-f]{64}$/);
    });

    it("gives the same question the same hash in two runs and another question another hash: the hash still pairs questions", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        await search(user.auth, document.id, { question: QUESTION });
        await search(user.auth, document.id, { question: ` ${QUESTION} ` });
        await search(user.auth, document.id, { question: "Another question?" });

        const hashes = (await readRuns()).map((run) => run.questionHash);

        assert.equal(hashes.length, 3);
        assert.equal(hashes[0], hashes[1]);
        assert.notEqual(hashes[0], hashes[2]);
    });

    it("writes one question_usage row for the question when the embedding is back, for a search that matched and for one that matched nothing", { timeout: 20_000 }, async () => {
        const matching = await seedSearchable("ana@example.com");
        const nothing = await seedSearchable("bob@example.com", { vectors: [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1]] });

        assert.equal((await search(matching.user.auth, matching.document.id, { question: QUESTION })).body.data.status, "matched");
        assert.equal((await search(nothing.user.auth, nothing.document.id, { question: QUESTION })).body.data.status, "no_match");

        assert.equal(await countRows("question_usage", "user_id = $1", [matching.user.id]), 1);
        assert.equal(await countRows("question_usage", "user_id = $1", [nothing.user.id]), 1);
    });

    it("writes no question_usage row when the model server is not available: the question did not use the model", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        fake.respond("/api/embed", dropConnection);

        assert.equal((await search(user.auth, document.id, { question: QUESTION })).status, 503);

        assert.equal(await countRows("question_usage"), 0);
    });
});

// Findings F4 and T2: a search that races a deletion. The index (or the document) is found before the question is admitted, and then
// the embedding takes the time it takes: if the owner deletes it meanwhile, the search finds no chunks, and "nothing found" would be
// stored and answered as a run that matched nothing, against an index that is not there. When no chunk comes back the index is
// looked at again, and a document or an index that is gone (or not ready any more) is answered as it would have been before the
// embedding: 404 or 409, and no run is stored. The embedding was done, so the question is counted.
describe("POST /v1/documents/:id/search: a search that races a deletion (F4, T2)", () => {
    // holds the embedding at the double until the test lets it go; the release is called in `finally`, whatever happens
    const holdingTheEmbedding = async (during: (release: () => void) => Promise<void>): Promise<void> => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        fake.respond("/api/embed", embeddingsFor(VECTORS, { beforeAnswer: async () => { await gate; } }));

        try {
            await during(release);
        } finally {
            release();
        }
    };

    it("answers 409 'no ready index' and stores no run when the index is deleted while the question is being embedded", { timeout: 30_000 }, async () => {
        const { user, document, index } = await seedSearchable("ana@example.com");

        await holdingTheEmbedding(async (release) => {
            const pending = Promise.resolve(search(user.auth, document.id, { question: QUESTION }));
            await waitForRequests(fake, "/api/embed", 1);
            await ownerPool.query("DELETE FROM document_indexes WHERE id = $1", [index.id]);
            release();

            const response = await within(15_000, "the answer", pending);

            assert.equal(response.status, 409, JSON.stringify(response.body));
            assert.deepEqual(response.body, { message: "This document has no ready index for chunk size 1000" });
        });

        assert.equal(await countRows("runs"), 0, "no run against an index that is gone");
        assert.equal(await countRows("question_usage"), 1, "the model did the work, so the question is counted");
    });

    it("answers 404 'Document not found' and stores no run when the document is deleted while the question is being embedded", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");

        await holdingTheEmbedding(async (release) => {
            const pending = Promise.resolve(search(user.auth, document.id, { question: QUESTION }));
            await waitForRequests(fake, "/api/embed", 1);
            await ownerPool.query("DELETE FROM documents WHERE id = $1", [document.id]);
            release();

            const response = await within(15_000, "the answer", pending);

            assert.equal(response.status, 404, JSON.stringify(response.body));
            assert.deepEqual(response.body, { message: "Document not found" });
        });

        assert.equal(await countRows("runs"), 0);
        assert.equal(await countRows("question_usage"), 1);
    });

    it("answers 409 when the index is not ready any more (its build failed) by the time the matches come back, and stores no run", { timeout: 30_000 }, async () => {
        const { user, document, index } = await seedSearchable("ana@example.com");

        await holdingTheEmbedding(async (release) => {
            const pending = Promise.resolve(search(user.auth, document.id, { question: QUESTION }));
            await waitForRequests(fake, "/api/embed", 1);
            await ownerPool.query("UPDATE document_indexes SET status = 'failed' WHERE id = $1", [index.id]);
            release();

            const response = await within(15_000, "the answer", pending);

            assert.equal(response.status, 409, JSON.stringify(response.body));
            assert.deepEqual(response.body, { message: "This document has no ready index for chunk size 1000" });
        });

        assert.equal(await countRows("runs"), 0);
    });

    it("still answers 200 no_match, and stores the run, when the index is there and nothing in it is close enough: only a missing index is refused", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com", { vectors: [[0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1]] });

        await holdingTheEmbedding(async (release) => {
            const pending = Promise.resolve(search(user.auth, document.id, { question: QUESTION }));
            await waitForRequests(fake, "/api/embed", 1);
            release();

            const response = await within(15_000, "the answer", pending);

            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.data.status, "no_match");
        });

        assert.equal(await countRows("runs"), 1);
    });
});

// Finding F4 (the retry in insertRun): the run is inserted through subqueries that give NULL for a row deleted since it was read, and an
// insert that still fails on a foreign key (the row went between the subquery and the check) is tried once more, and then the error is
// the caller's. The failure is provoked by wrapping the app's pool.query: the first INSERT INTO runs is refused with SQLSTATE 23503.
describe("POST /v1/documents/:id/search: the insert of the run and a foreign key that fails", () => {
    interface InsertWatch {
        attempts: () => number;
    }

    // makes the first `failures` inserts of a run fail with a foreign key violation, then lets the real ones through
    const failInsertsOfRuns = (t: TestContext, failures: number): InsertWatch => {
        const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
        let attempts = 0;

        t.mock.method(pool, "query", (async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("INSERT INTO runs")) {
                attempts += 1;

                if (attempts <= failures) {
                    throw Object.assign(new Error("insert or update on table \"runs\" violates foreign key constraint \"runs_index_id_fkey\""), { code: "23503" });
                }
            }

            return query(...args);
        }) as never);

        return { attempts: () => attempts };
    };

    it("tries the insert once more after a foreign key violation, and answers 200 with the run stored once", { timeout: 20_000 }, async (t) => {
        const { user, document } = await seedSearchable("ana@example.com");
        const watch = failInsertsOfRuns(t, 1);

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(watch.attempts(), 2, "the insert that failed and the one that worked");
        const runs = await readRuns();
        assert.equal(runs.length, 1);
        assert.equal(runs[0].id, response.body.data.id);
    });

    it("gives up after the second failure: the error is the caller's (the generic 500), no run is stored and the insert was tried exactly twice", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { user, document } = await seedSearchable("ana@example.com");
        const watch = failInsertsOfRuns(t, 2);

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 500, JSON.stringify(response.body));
        assert.deepEqual(response.body, { message: "Internal server error" });
        assert.equal(watch.attempts(), 2, "once more, and no more than once");
        assert.equal(await countRows("runs"), 0);
        assert.equal(await countRows("question_usage"), 1, "the embedding was done, so the question is counted though the run was lost");
    });

    it("does not try again an insert that fails for another reason: a check violation is tried once", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { user, document } = await seedSearchable("ana@example.com");
        const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
        let attempts = 0;
        t.mock.method(pool, "query", (async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("INSERT INTO runs")) {
                attempts += 1;
                throw Object.assign(new Error("new row for relation \"runs\" violates check constraint"), { code: "23514" });
            }

            return query(...args);
        }) as never);

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 500);
        assert.equal(attempts, 1);
    });
});

// Findings F3 and T5: a chunk whose score is NaN. PostgreSQL sorts NaN above every number, so "NaN >= minScore" is true and the chunk
// was returned as a match with a score of null in the JSON. The matches are guarded in the SQL. Here the stored vector (0, 1e-30)
// has a norm that underflows float4: its cosine with the question (1, 0) is 0 / 0, which is NaN (found by running it against the
// test database's pgvector; the same happens when a norm overflows).
describe("POST /v1/documents/:id/search: a chunk whose score is not a number (F3, T5)", () => {
    it("never returns it as a match, and no fragment of the answer or of the stored run has a score that is null or not finite", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com", {
            chunks: ["alpha chunk", "bravo chunk", "charlie chunk", "delta chunk", "echo chunk"],
            vectors: [[3, 4], [0, 1], [0, 1], [0, 1], [0, 1e-30]]
        });

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(response.body.data.fragments, [
            { id: "F1", chunkIndex: 0, text: "alpha chunk", retrieval: "match", score: 0.6 },
            { id: "F2", chunkIndex: 1, text: "bravo chunk", retrieval: "neighbor" }
        ]);
        assert.ok(!JSON.stringify(response.body).includes("\"score\":null"), "no score is null");

        const [run] = await readRuns();
        assert.deepEqual(run.fragments, [{ chunkIndex: 0, retrieval: "match", score: 0.6 }, { chunkIndex: 1, retrieval: "neighbor" }]);
    });

    it("answers no_match, and not a match with no score, when the only chunk that 'scores' is the NaN one", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com", {
            chunks: ["alpha chunk", "bravo chunk", "charlie chunk"],
            vectors: [[0, 1], [0, 1], [0, 1e-30]]
        });

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.status, "no_match");
        assert.deepEqual(response.body.data.fragments, []);
    });
});

// Finding O5 (the cheap part): prompt_eval_count is stored in an integer column, so a count above 2147483647 would be refused by the
// database after the work was done. It is checked where the answer is read: out of range is a malformed model answer (the service's
// own test is in test/services/ollamaEmbed.test.ts). Here nothing may be stored. This test already passed before the fix, by the
// database's own refusal, so it covers the behavior and the service test is the one that shows the fix.
describe("POST /v1/documents/:id/search: an embedding whose token count does not fit an integer (O5)", () => {
    it("answers the generic 500 and stores no run, and the fake saw one embedding", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { user, document } = await seedSearchable("ana@example.com");
        fake.respond("/api/embed", embeddingsFor(VECTORS, { promptTokens: 2 ** 31 }));

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 500, JSON.stringify(response.body));
        assert.deepEqual(response.body, { message: "Internal server error" });
        assert.equal(await countRows("runs"), 0);
        assert.equal(embedRequests().length, 1);
    });

    it("accepts the largest count an integer column holds, 2147483647, and stores it", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        fake.respond("/api/embed", embeddingsFor(VECTORS, { promptTokens: 2_147_483_647 }));

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.tokens.embedding, 2_147_483_647);
        assert.equal((await readRuns())[0].embeddingTokens, 2_147_483_647);
    });
});

describe("POST /v1/documents/:id/search: what it refuses", () => {
    const ANSWER_SETTINGS: [key: string, label: string, value: string | number][] = [
        ["smallModel", "Small model", "qwen3.5:4b"],
        ["temperature", "Temperature", 0.5],
        ["maxTokens", "Max tokens", 100],
        ["answerLanguage", "Answer language", "es"],
        ["answerMode", "Answer mode", "structured"]
    ];

    it("answers 400 '<Label> does not apply to a search' for each of the five answer settings in the overrides, even with a valid value", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        for (const [key, label, value] of ANSWER_SETTINGS) {
            await assertRefused(
                await search(user.auth, document.id, { question: QUESTION, overrides: { [key]: value } }),
                400,
                { message: "Validation error", details: [`${label} does not apply to a search`] },
                rowsBefore
            );
        }
    });

    it("gives the same refusal for an answer setting with a value outside its cap, and lists all five when all five are given", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        await assertRefused(
            await search(user.auth, document.id, { question: QUESTION, overrides: { temperature: 5 } }),
            400,
            { message: "Validation error", details: ["Temperature does not apply to a search"] },
            rowsBefore
        );

        const all = await search(user.auth, document.id, { question: QUESTION, overrides: Object.fromEntries(ANSWER_SETTINGS.map(([key, , value]) => [key, value])) });

        assert.equal(all.status, 400);
        assert.deepEqual([...all.body.details].sort(), ANSWER_SETTINGS.map(([, label]) => `${label} does not apply to a search`).sort());
    });

    it("answers 400 for a snapshot, a hash, a configuration or a configuration hash in the body: the client never supplies what a run ran with", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();
        const supplied: Record<string, unknown> = {
            snapshot: { version: 1, settings: DEFAULT_SETTINGS },
            hash: sha256Of("anything"),
            configuration: { kind: "retrieval", version: 1, settings: {} },
            configurationHash: sha256Of("anything")
        };

        for (const [field, value] of Object.entries(supplied)) {
            await assertRefused(
                await search(user.auth, document.id, { question: QUESTION, [field]: value }),
                400,
                { message: "Validation error", details: [`"${field}" is not allowed`] },
                rowsBefore
            );
        }
    });

    it("answers 400 for an unknown field and for an unknown override", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        await assertRefused(await search(user.auth, document.id, { question: QUESTION, userId: randomUUID() }), 400, { message: "Validation error", details: ["\"userId\" is not allowed"] }, rowsBefore);
        await assertRefused(await search(user.auth, document.id, { question: QUESTION, overrides: { foo: 1 } }), 400, { message: "Validation error", details: ["Unknown setting: foo"] }, rowsBefore);
    });

    it("answers 400 with the message of each problem with the question: missing, not text, empty, only spaces, and over 1000 characters", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();
        const cases: [string, unknown, string][] = [
            ["missing", {}, "Question is required"],
            ["a number", { question: 5 }, "Question must be a string"],
            ["a list", { question: ["a", "b"] }, "Question must be a string"],
            ["empty", { question: "" }, "Question cannot be empty"],
            ["only spaces and a line break", { question: "  \n\t " }, "Question cannot be empty"],
            ["1001 characters", { question: "q".repeat(1001) }, "Question cannot have more than 1000 characters"],
            ["1001 characters after trimming", { question: ` ${"q".repeat(1001)} ` }, "Question cannot have more than 1000 characters"]
        ];

        for (const [label, body, detail] of cases) {
            await assertRefused(await search(user.auth, document.id, body), 400, { message: "Validation error", details: [detail] }, rowsBefore, label);
        }
    });

    it("answers 400 for a setting outside its cap, with the message of the setting: topK 31, minScore 0.305, retrievalMode hybrid, a chunk size, a window", { timeout: 30_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();
        const cases: [object, string][] = [
            [{ topK: 31 }, "Top K must be at most 30"],
            [{ topK: 0 }, "Top K must be at least 1"],
            [{ minScore: 0.305 }, "Minimum score must have at most 2 decimal places"],
            [{ retrievalMode: "hybrid" }, "Retrieval mode must be one of vector"],
            [{ chunkSize: 400 }, "Chunk size must be one of 300, 500, 750, 1000, 2000, 5000"],
            [{ neighborWindow: 3 }, "Neighbor window must be one of 1, 2"],
            [{ embeddingModel: "other:1" }, "Embedding model must be one of qwen3-embedding:0.6b"]
        ];

        for (const [overrides, detail] of cases) {
            await assertRefused(await search(user.auth, document.id, { question: QUESTION, overrides }), 400, { message: "Validation error", details: [detail] }, rowsBefore);
        }
    });

    it("answers 400 'Profile id must be a valid UUID' for a profile id that is not one", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        for (const profileId of ["not-a-uuid", 5, "", `{${randomUUID()}}`]) {
            await assertRefused(await search(user.auth, document.id, { question: QUESTION, profileId }), 400, { message: "Validation error", details: ["Profile id must be a valid UUID"] }, rowsBefore);
        }
    });

    it("answers 404 'Profile not found' for another user's profile and for a profile nobody has", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const bob = await createTestUser({ email: "bob@example.com" });
        const bobs = await seedProfile(bob.id, { topK: 5 });
        const rowsBefore = await everyRow();

        for (const profileId of [bobs, randomUUID()]) {
            await assertRefused(await search(user.auth, document.id, { question: QUESTION, profileId }), 404, { message: "Profile not found" }, rowsBefore);
        }
    });

    it("answers 400 'The configuration is not valid' for a stored profile outside the caps, also in an answer setting that a search does not use", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const outOfCap = await seedProfile(user.id, { topK: 31 }, "Too wide");
        const answerOutOfCap = await seedProfile(user.id, { temperature: 5 }, "Too hot");
        const rowsBefore = await everyRow();

        await assertRefused(
            await search(user.auth, document.id, { question: QUESTION, profileId: outOfCap }),
            400,
            { message: "The configuration is not valid", details: ["Top K must be at most 30"] },
            rowsBefore
        );
        await assertRefused(
            await search(user.auth, document.id, { question: QUESTION, profileId: answerOutOfCap }),
            400,
            { message: "The configuration is not valid", details: ["Temperature must be at most 1"] },
            rowsBefore
        );
    });

    it("checks the body before the profile and the profile before the document", { timeout: 20_000 }, async () => {
        const { user } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();
        const unknownDocument = randomUUID();

        await assertRefused(await search(user.auth, unknownDocument, { question: "" }), 400, { message: "Validation error", details: ["Question cannot be empty"] }, rowsBefore);
        await assertRefused(await search(user.auth, unknownDocument, { question: QUESTION, profileId: randomUUID() }), 404, { message: "Profile not found" }, rowsBefore);
        await assertRefused(await search(user.auth, unknownDocument, { question: QUESTION }), 404, { message: "Document not found" }, rowsBefore);
    });

    it("answers 404 'Document not found' for another user's document, an admin's request for it, an unknown id and a malformed id", { timeout: 30_000 }, async () => {
        const { document } = await seedSearchable("ana@example.com");
        const bob = await createTestUser({ email: "bob@example.com" });
        const admin = await createTestUser({ email: "admin@example.com", role: "admin" });
        const rowsBefore = await everyRow();

        for (const caller of [bob, admin]) {
            for (const id of [document.id, randomUUID(), "not-a-uuid"]) {
                await assertRefused(await search(caller.auth, id, { question: QUESTION }), 404, { message: "Document not found" }, rowsBefore);
            }
        }
    });

    it("answers 409 'This document has no ready index for chunk size N' when the document has no index of the size asked for, and creates nothing", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        await assertRefused(
            await search(user.auth, document.id, { question: QUESTION, overrides: { chunkSize: 500 } }),
            409,
            { message: "This document has no ready index for chunk size 500" },
            rowsBefore
        );
    });

    it("answers 409 for an index that is queued, being built or failed, and creates no index and counts no build", { timeout: 30_000 }, async () => {
        const callers: { auth: Auth; documentId: string; status: string }[] = [];

        for (const status of ["queued", "indexing", "failed"] as const) {
            const user = await createTestUser({ email: `${status}@example.com` });
            const document = await seedDocument(user.id, { filename: `${status}.txt` });
            await seedIndex(document.id, { status, chunkSize: 1000, chunks: CHUNKS, vectors: CHUNK_VECTORS, error: status === "failed" ? "Indexing failed" : null });
            callers.push({ auth: user.auth, documentId: document.id, status });
        }

        const rowsBefore = await everyRow();

        for (const caller of callers) {
            await assertRefused(
                await search(caller.auth, caller.documentId, { question: QUESTION }),
                409,
                { message: "This document has no ready index for chunk size 1000" },
                rowsBefore,
                caller.status
            );
        }
    });

    it("answers 413 for a body over 16 kB before it reads it, and stores nothing", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        const rowsBefore = await everyRow();

        await assertRefused(await search(user.auth, document.id, { question: "a".repeat(17_000) }), 413, { message: "request entity too large" }, rowsBefore);
    });

    it("answers 401 without a token", { timeout: 20_000 }, async () => {
        const response = await request(app).post(`/v1/documents/${randomUUID()}/search`).send({ question: QUESTION });

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });
});

describe("POST /v1/documents/:id/search: when the model server fails", () => {
    it("answers 503 'The model server is not available' when Ollama cannot be reached, and stores no run", { timeout: 20_000 }, async () => {
        const { user, document } = await seedSearchable("ana@example.com");
        fake.respond("/api/embed", dropConnection);

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.deepEqual(response.body, { message: "The model server is not available" });
        assert.equal(await countRows("runs"), 0, "a search that failed is not a run");
    });

    it("answers the generic 500, and stores no run, when Ollama's answer is not an embedding of the right shape", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { user, document } = await seedSearchable("ana@example.com");
        fake.respond("/api/embed", embeddings({ dimensions: 3 }));

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" });
        assert.equal(await countRows("runs"), 0);
    });

    it("answers the generic 500 when the default profile was moved to another configuration version while the server runs, without asking Ollama", { timeout: 20_000 }, async (t) => {
        t.mock.method(console, "error", () => {});
        const { user, document } = await seedSearchable("ana@example.com");
        await ownerPool.query("UPDATE default_profile SET version = 2");

        const response = await search(user.auth, document.id, { question: QUESTION });

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" }, "nothing about the stored data is shown");
        assert.equal(await countRows("runs"), 0);
        assert.deepEqual(embedRequests(), []);
    });
});
