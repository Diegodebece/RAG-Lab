import "./relaxedLimits.js";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { dropConnection, embeddings, embeddingsFor, fakeTokenCount, startFakeOllama } from "../doubles/fakeOllama.js";

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
        assert.equal(row.questionHash, sha256Of(asked), "the SHA-256 of the trimmed question as UTF-8");
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
