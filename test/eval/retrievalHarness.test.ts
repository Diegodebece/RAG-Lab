import "../routes/relaxedLimits.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelList, startFakeOllama } from "../doubles/fakeOllama.js";
import { CASES, DOCUMENT_NAME, DOCUMENT_TEXT, INSTALLED_MODELS, keywordEmbeddings, keywordVector, sentence, startRecordingServer, writeDataFolder } from "./harnessFixtures.js";
import type { InventedCase, RecordingServer } from "./harnessFixtures.js";

// The retrieval harness (layer 5): it runs the evaluation questions of a set through the API as an account of its own, builds one
// index for each chunk size, searches each question twice (a wide run and a reference run), and writes numbers to a folder in the data
// directory. Here it runs against the real app, in this process, on a free port, with the model server double giving each text a
// vector by its keywords, the indexing worker running and a data folder in os.tmpdir(). The harness itself is run through
// runRetrievalSweep(options), whose every input is an explicit option.
//
// The contract this file gives the implementation (src/eval/retrievalHarness.ts):
//   runRetrievalSweep({ apiUrl, email, password, dataDirectory, setName, sizes, questionIds?, repeat?, check?, repositoryRoot?, sleep?,
//                       buildTimeoutMs?, pollIntervalMs?, now?, output? }): Promise<{ exitCode, folder, message, unmatched }>
//     exitCode: 0 done, 1 refused before spending anything or aborted, 2 done with failed questions
//     folder:   the sweep folder it wrote to (null for a check and for a refusal); message: why it refused (null when it did not)
//     unmatched: the ids of the answerable cases whose evidence was not found in their document
//     output(line): where the printed lines go (the default is console.log); no line has a password, a token, a question, a passage or
//       a piece of a document
//     it never throws for a refusal: the outcome says it. check: true loads the set and matches the evidence offline, with no request
//       to the API
//   the files of the sweep folder: manifest.json, runs.jsonl (one JSON object a line) and summary.json. A line of runs.jsonl has, among
//     other fields, questionId, answerable, chunkSize, runId, kind ("wide" or "reference"), matches ([{ chunkIndex, score }], best first),
//     rank (of the first match on the evidence, from 1, or null), warmup (true for the first search of the sweep and no other)
//     summary.json has sizes[<chunkSize>] with chunkCount, unmatched (ids), and hitAtK and fullAtK, each an object with the keys "1", "3",
//     "5", "10", "20" and "30" whose values are fractions of the answerable questions whose evidence was found (0 to 1)
//     No line of any file has a question, a passage or any text of a document.
// Never reads RAG_LAB_DATA_DIR or any other private folder: the data folder is made here, with invented texts.

process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
process.env.MAX_QUESTIONS_PER_DAY = "1000";
process.env.MAX_INDEX_BUILDS_PER_DAY = "100";
process.env.MAX_INDEX_BUILDS_PER_DAY_TOTAL = "1000";

const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { createTestUser, makePasswordHash } = await import("../routes/testUsers.js");
const { countRows, readRuns, sha256Of } = await import("../documentsFixtures.js");
const { chunkText } = await import("../../src/v1/utils/chunkText.util.js");
const queue = await import("../../src/v1/services/indexingQueue.service.js");
const { runRetrievalSweep } = await import("../../src/eval/retrievalHarness.js");

const EMAIL = "harness@example.com";
const PASSWORD = "invented-harness-password-Qx92";
const SET = "invented";
const SIZES = [300, 500];

let work = "";
let server: RecordingServer;
let passwordHash = "";

before(async () => {
    await resetTestDatabase();
    passwordHash = await makePasswordHash(PASSWORD);
    server = await startRecordingServer(app);
    work = await mkdtemp(path.join(tmpdir(), "rag-lab-harness-"));
    queue.startIndexingWorkerService();
});

after(async () => {
    await queue.stopIndexingWorkerService();
    await server.close();
    await fake.close();
    await rm(work, { recursive: true, force: true });
    await closeTestPools();
});

const resetWorld = async (): Promise<void> => {
    await ownerPool.query("TRUNCATE users CASCADE");
    await createTestUser({ email: EMAIL, passwordHash });
    server.requests.splice(0);
    server.tokens.clear();
    server.tamperWithUploads = false;
    fake.requests.splice(0);
    fake.respond("/api/embed", keywordEmbeddings);
    fake.respond("/api/tags", modelList(INSTALLED_MODELS));
};

const newDataFolder = async (cases: InventedCase[] = CASES, documents?: Record<string, string>): Promise<string> => {
    const folder = await mkdtemp(path.join(work, "data-"));
    await writeDataFolder(folder, SET, cases, documents);
    return folder;
};

const START = Date.UTC(2026, 10, 27, 10, 0, 0);

const sweepOptions = (dataDirectory: string, lines: string[], changes: Record<string, unknown> = {}) => ({
    apiUrl: server.url,
    email: EMAIL,
    password: PASSWORD,
    dataDirectory,
    setName: SET,
    sizes: SIZES,
    buildTimeoutMs: 60_000,
    pollIntervalMs: 40,
    now: () => new Date(START),
    output: (line: string) => { lines.push(line); },
    ...changes
});

interface RunLine {
    questionId: string;
    answerable: boolean;
    chunkSize: number;
    runId: string;
    kind: "wide" | "reference";
    matches: { chunkIndex: number; score: number }[];
    rank: number | null;
    warmup: boolean;
}

const readLines = async (folder: string): Promise<RunLine[]> =>
    (await readFile(path.join(folder, "runs.jsonl"), "utf8")).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as RunLine);

const readJson = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

// ---- what the sweep should find, worked out here on its own: the server's chunker, the text of the passages, and the database's own order ----

interface Expectation {
    chunkCount: number;
    // the chunks each passage of the case touches
    passageChunks: number[][];
    // the chunks of the index in the order of their similarity to the question (the database's own: cosine distance, ties by position)
    order: number[];
    rank: number | null;
}

const expectationFor = async (item: InventedCase, size: number): Promise<Expectation> => {
    const chunks = chunkText(DOCUMENT_TEXT, size);
    const starts: number[] = [];
    let position = 0;

    for (const chunk of chunks) {
        starts.push(position);
        position += chunk.length + 1;
    }

    const collapsed = chunks.join(" ");
    const passageChunks = item.passages.map((quote) => {
        const start = collapsed.indexOf(quote);
        assert.notEqual(start, -1, "the invented passage is in the invented document");
        return chunks.flatMap((chunk, index) => (starts[index] < start + quote.length && start < starts[index] + chunk.length ? [index] : []));
    });

    const { rows } = await ownerPool.query<{ chunk_index: number }>(
        `SELECT c.chunk_index FROM chunks c JOIN document_indexes di ON di.id = c.index_id
         WHERE di.chunk_size = $1 AND di.embedding_model = 'qwen3-embedding:0.6b'
         ORDER BY c.embedding <=> $2::vector, c.chunk_index`,
        [size, JSON.stringify([...keywordVector(item.question), ...new Array<number>(1024 - 5).fill(0)])]
    );
    const order = rows.map((row) => row.chunk_index);
    const evidence = new Set(passageChunks.flat());
    const first = order.findIndex((index) => evidence.has(index));

    return { chunkCount: chunks.length, passageChunks, order, rank: first === -1 ? null : first + 1 };
};

const KS = [1, 3, 5, 10, 20, 30];

describe("--check", () => {
    beforeEach(resetWorld);

    it("lists the answerable cases whose evidence is not in their document, without any request to the API", { timeout: 30_000 }, async () => {
        const broken: InventedCase = { ...CASES[0], id: "q-broken", passages: [sentence("alpha", 3).toUpperCase()] };
        const lines: string[] = [];
        const dataDirectory = await newDataFolder([CASES[0], CASES[1], broken, CASES[2]]);

        const outcome = await runRetrievalSweep(sweepOptions(dataDirectory, lines, { check: true }));

        assert.deepEqual(outcome.unmatched, ["q-broken"], "a different case does not match: the evidence of q-broken is not found");
        assert.equal(outcome.folder, null, "a check writes no sweep");
        assert.deepEqual(server.requests, [], "no request reached the API, not even a login");
        assert.deepEqual(fake.requests, [], "nor the model server");
        assert.ok(lines.some((line) => line.includes("q-broken")), "the printed lines name the case");
        assert.equal(await countRows("documents"), 0);
    });

    it("lists nothing when every passage is found, in every size it checks, the second passage of a case included", { timeout: 30_000 }, async () => {
        const lines: string[] = [];

        const outcome = await runRetrievalSweep(sweepOptions(await newDataFolder(), lines, { check: true }));

        assert.deepEqual(outcome.unmatched, []);
        assert.equal(outcome.exitCode, 0);
        assert.deepEqual(server.requests, []);
    });

    it("names a case whose second passage is not found, and not the cases whose passages are all found", { timeout: 30_000 }, async () => {
        const lines: string[] = [];
        const half: InventedCase = { ...CASES[1], id: "q-half", passages: [sentence("bravo", 1), "A sentence that is not in the invented document."] };

        const outcome = await runRetrievalSweep(sweepOptions(await newDataFolder([CASES[0], half]), lines, { check: true }));

        assert.deepEqual(outcome.unmatched, ["q-half"]);
    });
});

describe("what the harness refuses before it spends anything", () => {
    beforeEach(resetWorld);

    it("refuses a data folder inside the repository, before any request, and writes nothing in it", { timeout: 30_000 }, async () => {
        const inside = await mkdtemp(path.join(import.meta.dirname, "..", ".harness-data-"));

        try {
            await writeDataFolder(inside, SET, CASES);
            const lines: string[] = [];

            const outcome = await runRetrievalSweep(sweepOptions(inside, lines));

            assert.equal(outcome.exitCode, 1);
            assert.equal(outcome.folder, null);
            assert.equal(typeof outcome.message, "string");
            assert.deepEqual(server.requests, [], "no request, not even a login");
            assert.ok(!(await readdir(inside)).includes("results"), "nothing was written in the repository");
        } finally {
            await rm(inside, { recursive: true, force: true });
        }
    });

    it("refuses a data folder that does not exist, and a set name that would leave the data folder, before any request", { timeout: 30_000 }, async () => {
        const lines: string[] = [];

        const missing = await runRetrievalSweep(sweepOptions(path.join(work, "no-such-folder"), lines));
        const escaping = await runRetrievalSweep(sweepOptions(await newDataFolder(), lines, { setName: "../invented" }));

        assert.equal(missing.exitCode, 1);
        assert.equal(escaping.exitCode, 1);
        assert.deepEqual(server.requests, []);
    });

    it("stops, naming the cases, when a document of the set has no file, before any request", { timeout: 30_000 }, async () => {
        const ghost: InventedCase = { ...CASES[0], id: "q-ghost", indexPath: "data/eval-1000/ghost.json" };
        const lines: string[] = [];

        const outcome = await runRetrievalSweep(sweepOptions(await newDataFolder([CASES[0], ghost, CASES[2]]), lines));

        assert.equal(outcome.exitCode, 1);
        assert.ok(outcome.message?.includes("q-ghost"), String(outcome.message));
        assert.ok(!outcome.message?.includes("q-alpha"), "the cases whose document is there are not named");
        assert.deepEqual(server.requests, [], "no request, not even a login");
    });

    it("refuses a chunk size that is not one of the allowed sizes, naming it, and uploads nothing", { timeout: 30_000 }, async () => {
        const lines: string[] = [];

        const outcome = await runRetrievalSweep(sweepOptions(await newDataFolder(), lines, { sizes: [300, 400] }));

        assert.equal(outcome.exitCode, 1);
        assert.ok(outcome.message?.includes("400"), String(outcome.message));
        assert.equal(server.requests.filter((request) => request.method === "POST" && request.url === "/v1/documents").length, 0);
        assert.equal(await countRows("documents"), 0);
    });

    it("stops when the content hash the server gives for the uploaded document is not the one it worked out, and searches nothing", { timeout: 60_000 }, async () => {
        const lines: string[] = [];
        server.tamperWithUploads = true;

        const outcome = await runRetrievalSweep(sweepOptions(await newDataFolder(), lines));

        assert.equal(outcome.exitCode, 1);
        assert.match(String(outcome.message), /content ?hash/i);
        assert.equal(server.requests.filter((request) => request.url.endsWith("/search")).length, 0, "the offsets of the evidence would have been wrong, so nothing was searched");
        assert.equal(await countRows("runs"), 0);
    });
});

describe("a sweep at chunk sizes 300 and 500", () => {
    let dataDirectory = "";
    let outcome: Awaited<ReturnType<typeof runRetrievalSweep>>;
    const lines: string[] = [];
    let runLines: RunLine[] = [];
    let summary: Record<string, unknown> = {};
    let manifestText = "";

    before(async () => {
        await resetWorld();
        dataDirectory = await newDataFolder();
        outcome = await runRetrievalSweep(sweepOptions(dataDirectory, lines));
        assert.ok(outcome.folder, `the sweep did not write a folder: ${JSON.stringify(outcome)}`);
        runLines = await readLines(outcome.folder);
        summary = await readJson(path.join(outcome.folder, "summary.json"));
        manifestText = await readFile(path.join(outcome.folder, "manifest.json"), "utf8");
    });

    it("ends with exit code 0, in a folder results/retrieval/<UTC time>-<set> of the data folder, with the three files", { timeout: 120_000 }, async () => {
        assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
        assert.equal(outcome.message, null);
        assert.equal(path.resolve(String(outcome.folder)), path.join(dataDirectory, "results", "retrieval", "20261127T100000Z-invented"));
        assert.deepEqual((await readdir(String(outcome.folder))).sort(), ["manifest.json", "runs.jsonl", "summary.json"]);
        assert.deepEqual(outcome.unmatched, []);
    });

    it("uploads the document once, and builds the two indexes, one after the other, before the first search", { timeout: 120_000 }, async () => {
        assert.equal(server.requests.filter((request) => request.method === "POST" && request.url === "/v1/documents").length, 1, "one upload");

        const { rows: indexes } = await ownerPool.query<{ chunk_size: number; status: string; started_at: Date; finished_at: Date }>(
            "SELECT chunk_size, status, started_at, finished_at FROM document_indexes ORDER BY started_at"
        );

        for (const size of SIZES) {
            assert.equal(indexes.find((index) => index.chunk_size === size)?.status, "ready", `the index of size ${size} is ready`);
        }

        for (let position = 1; position < indexes.length; position++) {
            assert.ok(indexes[position - 1].finished_at.getTime() <= indexes[position].started_at.getTime(), "one build ends before the next starts");
        }

        const firstSearch = server.requests.findIndex((request) => request.url.endsWith("/search"));
        let lastIndexRequest = -1;

        for (const [position, request] of server.requests.entries()) {
            if (request.url.includes("/indexes")) {
                lastIndexRequest = position;
            }
        }

        assert.ok(firstSearch > lastIndexRequest, "every build finished before the first search, so no batch got in the way of a timing");
        assert.equal(await countRows("documents"), 1);
    });

    it("runs a wide and a reference search for each question at each size, one line each in runs.jsonl, and flags only the first search as a warm-up", { timeout: 120_000 }, async () => {
        assert.equal(runLines.length, CASES.length * SIZES.length * 2);

        for (const item of CASES) {
            for (const size of SIZES) {
                const kinds = runLines.filter((line) => line.questionId === item.id && line.chunkSize === size).map((line) => line.kind).sort();

                assert.deepEqual(kinds, ["reference", "wide"], `${item.id} at ${size}`);
            }
        }

        assert.equal(runLines.filter((line) => line.warmup).length, 1, "the first search of the sweep, and no other");
        assert.equal(runLines.filter((line) => line.answerable).length, 2 * SIZES.length * 2);
    });

    it("stores the runs in the API: every runId of runs.jsonl is a row of runs, and every row of runs is on a line", { timeout: 120_000 }, async () => {
        const rows = await readRuns();

        assert.deepEqual(runLines.map((line) => line.runId).sort(), rows.map((row) => row.id).sort());
        assert.equal(rows.filter((row) => row.kind === "retrieval").length, rows.length);
    });

    it("searches wide (topK 30 and minScore 0) and with the default profile for the reference, as two configurations", { timeout: 120_000 }, async () => {
        const rows = await readRuns();
        const byId = new Map(rows.map((row) => [row.id, row]));

        for (const line of runLines) {
            const settings = (byId.get(line.runId)?.configuration.settings ?? {}) as Record<string, unknown>;

            assert.equal(settings.chunkSize, line.chunkSize, "the size of the line is the size the run used");

            if (line.kind === "wide") {
                assert.equal(settings.topK, 30);
                assert.equal(settings.minScore, 0);
            } else {
                assert.equal(settings.topK, 3, "the default profile");
                assert.equal(settings.minScore, 0.3);
            }
        }

        assert.equal(new Set(rows.map((row) => row.configurationHash)).size, SIZES.length * 2, "a configuration for each kind and size");
    });

    it("gives in a wide run the matches in the order of the database's own ranking, and the rank of the first match on the evidence", { timeout: 120_000 }, async () => {
        for (const item of CASES.filter((candidate) => candidate.answerable)) {
            for (const size of SIZES) {
                const expected = await expectationFor(item, size);
                const wide = runLines.find((line) => line.questionId === item.id && line.chunkSize === size && line.kind === "wide");

                assert.ok(wide, `${item.id} at ${size}`);
                assert.deepEqual(wide.matches.map((match) => match.chunkIndex), expected.order, `${item.id} at ${size}: the order of the matches`);
                assert.equal(wide.rank, expected.rank, `${item.id} at ${size}: the rank`);
            }
        }
    });

    it("computes hit@k and full@k in summary.json as the fractions the test works out for itself, for each size", { timeout: 120_000 }, async () => {
        const sizes = summary.sizes as Record<string, { chunkCount: number; unmatched: string[]; hitAtK: Record<string, number>; fullAtK: Record<string, number> }>;

        for (const size of SIZES) {
            const answerable = CASES.filter((candidate) => candidate.answerable);
            const expectations = await Promise.all(answerable.map((item) => expectationFor(item, size)));
            const entry = sizes[String(size)];

            assert.ok(entry, `a summary for size ${size}`);
            assert.equal(entry.chunkCount, expectations[0].chunkCount);
            assert.deepEqual(entry.unmatched, []);

            for (const k of KS) {
                const hits = expectations.filter((expected) => expected.rank !== null && expected.rank <= k).length;
                const fulls = expectations.filter((expected) => expected.passageChunks.every((chunks) => chunks.every((index) => expected.order.slice(0, k).includes(index)))).length;

                assert.equal(entry.hitAtK[String(k)], hits / answerable.length, `hit@${k} at ${size}`);
                assert.equal(entry.fullAtK[String(k)], fulls / answerable.length, `full@${k} at ${size}`);
            }
        }
    });

    it("finds no difference between the reference runs and what is derived from the wide runs, and prints no warning of one", { timeout: 120_000 }, async () => {
        assert.ok(!lines.some((line) => /mismatch|differs? from/i.test(line)), lines.join("\n"));
    });

    it("writes no question, passage or text of the document, and no password or token, in any file or in any printed line", { timeout: 120_000 }, async () => {
        const everything = [
            ...(await Promise.all(["manifest.json", "runs.jsonl", "summary.json"].map((name) => readFile(path.join(String(outcome.folder), name), "utf8")))),
            ...lines
        ].join("\n");
        const secrets = [
            PASSWORD,
            ...server.tokens,
            ...CASES.map((item) => item.question),
            ...CASES.flatMap((item) => item.passages),
            sentence("alpha", 0),
            sentence("delta", 8),
            DOCUMENT_TEXT.slice(0, 60),
            "copper lantern",
            "Who painted the moon"
        ];

        assert.ok(server.tokens.size >= 1, "the test saw the harness's token");

        for (const secret of secrets) {
            assert.ok(!everything.includes(secret), `a file or a line holds "${secret.slice(0, 40)}"`);
        }
    });

    it("records in manifest.json what the sweep ran on: the set's hash, the document, the indexes and the models' digests, with no credentials", { timeout: 120_000 }, async () => {
        const setBytes = await readFile(path.join(dataDirectory, "eval", "sets", `${SET}.json`));
        const { rows: documents } = await ownerPool.query<{ id: string; content_hash: string }>("SELECT id, content_hash FROM documents");
        const { rows: indexes } = await ownerPool.query<{ id: string }>("SELECT id FROM document_indexes WHERE chunk_size = ANY($1::int[])", [SIZES]);

        assert.doesNotThrow(() => JSON.parse(manifestText), "it is JSON");
        assert.ok(manifestText.includes(createHash("sha256").update(setBytes).digest("hex")), "the SHA-256 of the set file");
        assert.ok(manifestText.includes(documents[0].content_hash), "the content hash of the document");
        assert.equal(documents[0].content_hash, sha256Of(DOCUMENT_TEXT));
        assert.ok(manifestText.includes(documents[0].id), "the id of the document");

        for (const index of indexes) {
            assert.ok(manifestText.includes(index.id), `the index ${index.id}`);
        }

        for (const model of INSTALLED_MODELS) {
            assert.ok(manifestText.includes(model.digest), `the digest of ${model.name}`);
        }

        assert.ok(manifestText.includes(server.url), "the API address");
        assert.ok(!manifestText.includes(PASSWORD), "no credentials");
    });

    it("reuses the document of the first sweep in a second one: no upload, no 409, and a folder of its own", { timeout: 120_000 }, async () => {
        const before = server.requests.length;
        const secondLines: string[] = [];

        const second = await runRetrievalSweep(sweepOptions(dataDirectory, secondLines, { now: () => new Date(START + 60_000) }));

        assert.equal(second.exitCode, 0, JSON.stringify(second));
        assert.notEqual(second.folder, outcome.folder);
        assert.equal(server.requests.slice(before).filter((request) => request.method === "POST" && request.url === "/v1/documents").length, 0, "the document is there already, found by its content hash");
        assert.equal(await countRows("documents"), 1);
        assert.equal((await readLines(String(second.folder))).length, CASES.length * SIZES.length * 2);
        assert.ok(!secondLines.some((line) => line.includes(PASSWORD)));
    });

    it("never overwrites a sweep: a second sweep that would write the same folder is refused, and the first one is untouched", { timeout: 120_000 }, async () => {
        const before = await readFile(path.join(String(outcome.folder), "runs.jsonl"), "utf8");

        const again = await runRetrievalSweep(sweepOptions(dataDirectory, [], { now: () => new Date(START) }));

        assert.equal(again.exitCode, 1);
        assert.equal(await readFile(path.join(String(outcome.folder), "runs.jsonl"), "utf8"), before);
    });
});

describe("a sweep of some of the questions", () => {
    beforeEach(resetWorld);

    it("runs only the questions asked for by id, and repeats each run as many times as asked", { timeout: 120_000 }, async () => {
        const lines: string[] = [];
        const dataDirectory = await newDataFolder();

        const outcome = await runRetrievalSweep(sweepOptions(dataDirectory, lines, { sizes: [500], questionIds: ["q-alpha"], repeat: 2 }));

        assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
        const runLines = await readLines(String(outcome.folder));
        assert.deepEqual([...new Set(runLines.map((line) => line.questionId))], ["q-alpha"]);
        assert.equal(runLines.length, 1 * 1 * 2 * 2, "one question, one size, a wide and a reference run, twice");
        assert.equal(await countRows("runs"), 4);
    });
});
