import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CONFIGURATION_VERSION, SETTING_CAPS } from "../v1/config/configuration.config.js";
import { listInstalledModelDigestsService } from "../v1/services/ollama.service.js";
import { chunkText } from "../v1/utils/chunkText.util.js";
import { hashSnapshotText, toCanonicalJson } from "../v1/utils/configurationSnapshot.util.js";
import { describeError } from "../v1/utils/describeError.util.js";
import { getNeighborIndexes } from "../v1/utils/fragments.util.js";
import { sanitizeText } from "../v1/utils/sanitizeText.util.js";
import { createApiClient } from "./apiClient.js";
import type { ApiClient } from "./apiClient.js";
import { assertDataDirectory, createSweepFolder, documentFilePath, setFilePath } from "./dataPaths.js";
import { chunksOverlapping, computeChunkSpans, findEvidenceOccurrences } from "./evidence.js";
import type { Span } from "./evidence.js";
import { loadEvaluationSet } from "./evaluationSet.js";
import type { EvaluationCase } from "./evaluationSet.js";
import { applyMinScore, findRank } from "./metrics.js";
import type { Match } from "./metrics.js";
import { CONTEXT_WINDOWS, RECALL_KS, appendRunLine, createRunsFile, formatSummary, summarizeSize, writeJsonFile } from "./results.js";
import type { RunLine, SearchTimings, Summary } from "./results.js";

// The retrieval harness: it runs the questions of an evaluation set through the API as an account of its own, builds one index for each
// chunk size, searches each question twice (a wide run, which has the top 30 matches whatever their score, and a reference run, which is
// the default configuration), and writes numbers to a folder in the data directory. Under exact search every other configuration of the
// grid (a smaller k, a minimum score, the other window) is derived from the wide run, and the reference run proves the derivation.
// Every input is an explicit option, so the tests call it directly; src/eval/retrieval.ts is the only file that reads the environment.
//
// The results hold ids and numbers, and the names of the documents (the file names of the owner's own documents). They go only to the
// private data folder and to the operator's terminal: never to the repository, a commit or a pull request. A question, a passage of the
// evidence or a piece of a document is never written to a file or printed, and neither is the password or the token.

export interface RetrievalSweepOptions {
    // where the API listens, and the harness account
    apiUrl: string;
    email: string;
    password: string;
    // the private data folder: <data>/eval/sets/<set>.json, <data>/eval/documents/<name>.txt, results in <data>/results/retrieval
    dataDirectory: string;
    setName: string;
    // the chunk sizes to sweep, each one of the allowed sizes
    sizes: number[];
    // only these cases of the set (default: all)
    questionIds?: string[];
    // how many times each search is made (default 1); more adds samples to the latency
    repeat?: number;
    // load the set and match the evidence offline, with no request to the API or the model server
    check?: boolean;
    // the repository, which the data folder must be outside of (default: the one this file is in)
    repositoryRoot?: string;
    // waits this many milliseconds (default: setTimeout)
    sleep?: (milliseconds: number) => Promise<void>;
    // how long to wait for one index to be built (default one hour), and how often to ask (default 2.5 seconds)
    buildTimeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => Date;
    // where the printed lines go (default console.log)
    output?: (line: string) => void;
}

export interface RetrievalSweepOutcome {
    // 0 done, 1 refused before spending anything or stopped, 2 done with questions that failed
    exitCode: 0 | 1 | 2;
    // the folder the sweep wrote to: null for a check and for a refusal before anything was spent
    folder: string | null;
    // why it refused or stopped; null when it did not
    message: string | null;
    // the answerable cases whose evidence is not in their document
    unmatched: string[];
}

// a refusal or a stop, with a message that is safe to show
class SweepStop extends Error {}

const EMBEDDING_MODEL: string = SETTING_CAPS.embeddingModel.allowed[0];
const ALLOWED_SIZES: readonly number[] = SETTING_CAPS.chunkSize.allowed;
const WIDE_TOP_K: number = SETTING_CAPS.topK.max;
const WIDE_MIN_SCORE: number = SETTING_CAPS.minScore.min;

const DEFAULT_BUILD_TIMEOUT_MS = 3_600_000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const MODEL_LIST_TIMEOUT_MS = 10_000;

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultOutput = (line: string): void => {
    console.log(`${line}`);
};

const stop = (message: string): never => {
    throw new SweepStop(message);
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

// ---- reading what the API answers: nothing is trusted to have a shape ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);

const numberAt = (value: unknown, ...keys: string[]): number | null => {
    const found = field(value, ...keys);

    return typeof found === "number" && Number.isFinite(found) ? found : null;
};

const textAt = (value: unknown, ...keys: string[]): string | null => {
    const found = field(value, ...keys);

    return typeof found === "string" ? found : null;
};

const messageOf = (body: unknown): string => textAt(body, "message") ?? "";

const describeAnswer = (status: number, body: unknown): string => {
    const message = messageOf(body);

    return `HTTP ${status}${message === "" ? "" : `: ${message}`}`;
};

// ---- the local preparation: the set, the documents and where the evidence sits, with no request ----

interface PreparedDocument {
    name: string;
    // the text the server will store: cleaned until cleaning it again changes nothing
    text: string;
    contentHash: string;
    // the chunks of each size, as spans of the collapsed text
    spans: Map<number, Span[]>;
}

interface PreparedCase {
    item: EvaluationCase;
    // for each passage, its occurrences in the document, as spans of the collapsed text
    occurrences: Span[][];
    // every passage has at least one occurrence (true for a question with no passages)
    found: boolean;
}

interface Prepared {
    // the real path of the data folder, as assertDataDirectory returned it: the sweep folder is made below this one
    dataDirectory: string;
    setSha256: string;
    cases: PreparedCase[];
    documents: Map<string, PreparedDocument>;
    unmatched: string[];
    sizes: number[];
    repeat: number;
}

// The text the server will store for a file: sanitizeText is applied until it changes nothing more, so the server's own pass leaves the
// text as it is and its hash is the one worked out here.
const cleanText = (raw: string): string => {
    let text = sanitizeText(raw);

    for (let pass = 0; pass < 5; pass += 1) {
        const next = sanitizeText(text);

        if (next === text) {
            break;
        }

        text = next;
    }

    return text;
};

const readOptionalFile = async (file: string): Promise<string | null> => {
    try {
        return await readFile(file, "utf8");
    } catch {
        return null;
    }
};

const prepare = async (options: RetrievalSweepOptions): Promise<Prepared> => {
    const repositoryRoot = options.repositoryRoot ?? path.resolve(import.meta.dirname, "..", "..");

    let dataDirectory: string;

    try {
        dataDirectory = await assertDataDirectory(options.dataDirectory, repositoryRoot);
    } catch (error) {
        return stop(`The data folder cannot be used: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const sizes = [...new Set(options.sizes)];
    const refusedSizes = sizes.filter((size) => !ALLOWED_SIZES.includes(size));

    if (sizes.length === 0 || refusedSizes.length > 0) {
        return stop(`Chunk sizes must be some of ${ALLOWED_SIZES.join(", ")}${refusedSizes.length > 0 ? `; refused: ${refusedSizes.join(", ")}` : ""}`);
    }

    const repeat = options.repeat ?? 1;

    if (!Number.isInteger(repeat) || repeat < 1) {
        return stop("The repeat count must be a whole number of at least 1");
    }

    let setFile: string;

    try {
        setFile = setFilePath(dataDirectory, options.setName);
    } catch (error) {
        return stop(error instanceof Error ? error.message : "The set name is not valid");
    }

    let loaded: Awaited<ReturnType<typeof loadEvaluationSet>>;

    try {
        loaded = await loadEvaluationSet(setFile);
    } catch (error) {
        return stop(`The evaluation set cannot be loaded: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    let cases = loaded.cases;

    if (options.questionIds !== undefined) {
        const wanted = new Set(options.questionIds);
        const known = new Set(cases.map((item) => item.id));
        const unknown = options.questionIds.filter((id) => !known.has(id));

        if (unknown.length > 0) {
            return stop(`The set has no case with the id ${unknown.join(", ")}`);
        }

        cases = cases.filter((item) => wanted.has(item.id));
    }

    if (cases.length === 0) {
        return stop("The set has no cases to run");
    }

    // the documents of the cases: each one must have its file, and the cases that miss it are named, before any request
    const texts = new Map<string, string | null>();

    for (const name of new Set(cases.map((item) => item.document))) {
        texts.set(name, await readOptionalFile(documentFilePath(dataDirectory, name)));
    }

    const missing = cases.filter((item) => texts.get(item.document) === null).map((item) => item.id);

    if (missing.length > 0) {
        return stop(`These cases have a document with no file in the data folder: ${missing.join(", ")}`);
    }

    const documents = new Map<string, PreparedDocument>();

    for (const [name, raw] of texts) {
        const text = cleanText(raw ?? "");

        if (text === "") {
            return stop(`The document ${name} has no readable text`);
        }

        documents.set(name, {
            name,
            text,
            contentHash: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
            spans: new Map(sizes.map((size) => [size, computeChunkSpans(text, size)]))
        });
    }

    const prepared = cases.map((item): PreparedCase => {
        const document = documents.get(item.document);
        const occurrences = item.evidence.map((quote) => findEvidenceOccurrences(document?.text ?? "", quote));

        return { item, occurrences, found: occurrences.every((spans) => spans.length > 0) };
    });

    return {
        dataDirectory,
        setSha256: loaded.sha256,
        cases: prepared,
        documents,
        unmatched: prepared.filter((entry) => entry.item.answerable && !entry.found).map((entry) => entry.item.id),
        sizes,
        repeat
    };
};

// for each passage of the case, the chunks each of its occurrences touches at one size
const evidenceChunksAt = (entry: PreparedCase, spans: Span[]): number[][][] =>
    entry.occurrences.map((passage) => passage.map((occurrence) => chunksOverlapping(spans, occurrence)));

const printCheck = (prepared: Prepared, output: (line: string) => void): void => {
    const answerable = prepared.cases.filter((entry) => entry.item.answerable).length;

    output(`Check: ${prepared.cases.length} cases (${answerable} answerable), ${prepared.documents.size} documents, sizes ${prepared.sizes.join(", ")}`);

    for (const document of prepared.documents.values()) {
        output(`Document ${document.name}: ${document.text.length} characters; chunks ${prepared.sizes.map((size) => `${size}: ${document.spans.get(size)?.length ?? 0}`).join(", ")}`);
    }

    if (prepared.unmatched.length === 0) {
        output("The evidence of every answerable case is in its document");
    } else {
        output(`The evidence is not in the document for ${prepared.unmatched.length} answerable cases (left out of recall): ${prepared.unmatched.join(", ")}`);
    }
};

// ---- the sweep ----

interface Caps {
    questions: { perMinute: number; maxPerDay: number; maxCharacters: number };
    documents: { maxPerUser: number; maxCharacters: number };
    indexes: { maxActivePerUser: number; maxBuildsPerDay: number; maxBuildsPerDayTotal: number };
}

interface ModelDigest {
    name: string;
    digest: string | null;
}

interface ExistingDocument {
    id: string;
    contentHash: string;
    indexes: { id: string; chunkSize: number; embeddingModel: string; status: string }[];
}

interface DocumentRecord {
    name: string;
    id: string;
    contentHash: string;
    characters: number;
    reused: boolean;
}

interface IndexRecord {
    document: string;
    chunkSize: number;
    id: string;
    status: "ready" | "failed";
    error: string | null;
    chunkCount: number;
    embeddingTokens: number;
    buildSeconds: number | null;
}

// the configuration of the first wide and reference run of a size, as the server reported it
interface SizeConfigurations {
    wide: { kind: string; version: number; settings: Record<string, unknown>; hash: string } | null;
    reference: { hash: string; topK: number; minScore: number; neighborWindow: number } | null;
}

interface SweepState {
    startedAt: Date;
    folder: string | null;
    lines: RunLine[];
    warnings: string[];
    caps: Caps | null;
    digestsAtStart: ModelDigest[] | null;
    documents: DocumentRecord[];
    indexes: IndexRecord[];
    configurations: Map<number, SizeConfigurations>;
}

interface Context {
    options: RetrievalSweepOptions;
    prepared: Prepared;
    client: ApiClient;
    state: SweepState;
    output: (line: string) => void;
    sleep: (milliseconds: number) => Promise<void>;
}

const readCaps = (body: unknown): Caps => {
    const caps: Caps = {
        questions: { perMinute: numberAt(body, "data", "questions", "perMinute") ?? -1, maxPerDay: numberAt(body, "data", "questions", "maxPerDay") ?? -1, maxCharacters: numberAt(body, "data", "questions", "maxCharacters") ?? -1 },
        documents: { maxPerUser: numberAt(body, "data", "documents", "maxPerUser") ?? -1, maxCharacters: numberAt(body, "data", "documents", "maxCharacters") ?? -1 },
        indexes: {
            maxActivePerUser: numberAt(body, "data", "indexes", "maxActivePerUser") ?? -1,
            maxBuildsPerDay: numberAt(body, "data", "indexes", "maxBuildsPerDay") ?? -1,
            maxBuildsPerDayTotal: numberAt(body, "data", "indexes", "maxBuildsPerDayTotal") ?? -1
        }
    };

    if ([...Object.values(caps.questions), ...Object.values(caps.documents), ...Object.values(caps.indexes)].some((value) => value < 0)) {
        return stop("The API did not report its limits in the shape this harness reads (GET /v1/configuration): is it the same version?");
    }

    return caps;
};

const readExistingDocuments = (body: unknown): ExistingDocument[] => {
    const list = field(body, "data");

    if (!Array.isArray(list)) {
        return stop("The API did not list the documents in the shape this harness reads (GET /v1/documents)");
    }

    return list.flatMap((entry: unknown): ExistingDocument[] => {
        const id = textAt(entry, "id");
        const contentHash = textAt(entry, "contentHash");
        const indexes = field(entry, "indexes");

        if (id === null || contentHash === null || !Array.isArray(indexes)) {
            return [];
        }

        return [{
            id,
            contentHash,
            indexes: indexes.flatMap((index: unknown) => {
                const indexId = textAt(index, "id");
                const chunkSize = numberAt(index, "chunkSize");
                const embeddingModel = textAt(index, "embeddingModel");
                const status = textAt(index, "status");

                return indexId === null || chunkSize === null || embeddingModel === null || status === null ? [] : [{ id: indexId, chunkSize, embeddingModel, status }];
            })
        }];
    });
};

// The model server's models and their digests, through the same wrapper the API uses (nothing here calls Ollama on its own).
const readDigests = async (): Promise<ModelDigest[]> => {
    try {
        return await listInstalledModelDigestsService({ timeoutMs: MODEL_LIST_TIMEOUT_MS });
    } catch (error) {
        return stop(`The model server did not list its models: ${describeError(error)}`);
    }
};

// What the sweep needs, against what the API allows, before anything is uploaded, built or asked: a sweep that stopped halfway on a
// daily limit would have spent the limit for nothing. Every variable to raise is named.
const checkBudget = (prepared: Prepared, caps: Caps, existing: ExistingDocument[]): void => {
    const problems: string[] = [];

    const searches = prepared.cases.length * prepared.sizes.length * 2 * prepared.repeat;

    if (searches > caps.questions.maxPerDay) {
        problems.push(`MAX_QUESTIONS_PER_DAY is ${caps.questions.maxPerDay} and the sweep needs ${searches} searches`);
    }

    let builds = 0;
    let newDocuments = 0;

    for (const document of prepared.documents.values()) {
        const found = existing.find((candidate) => candidate.contentHash === document.contentHash);

        if (found === undefined) {
            newDocuments += 1;
        }

        for (const size of prepared.sizes) {
            const present = found?.indexes.some((index) => index.chunkSize === size && index.embeddingModel === EMBEDDING_MODEL && index.status !== "failed") ?? false;

            builds += present ? 0 : 1;
        }

        if (document.text.length > caps.documents.maxCharacters) {
            problems.push(`MAX_DOCUMENT_CHARACTERS is ${caps.documents.maxCharacters} and the document ${document.name} has ${document.text.length}`);
        }
    }

    if (builds > caps.indexes.maxBuildsPerDay) {
        problems.push(`MAX_INDEX_BUILDS_PER_DAY is ${caps.indexes.maxBuildsPerDay} and the sweep needs ${builds} index builds`);
    }

    if (builds > caps.indexes.maxBuildsPerDayTotal) {
        problems.push(`MAX_INDEX_BUILDS_PER_DAY_TOTAL is ${caps.indexes.maxBuildsPerDayTotal} and the sweep needs ${builds} index builds`);
    }

    if (existing.length + newDocuments > caps.documents.maxPerUser) {
        problems.push(`MAX_DOCUMENTS_PER_USER is ${caps.documents.maxPerUser} and the account would have ${existing.length + newDocuments} documents`);
    }

    const tooLong = prepared.cases.filter((entry) => entry.item.question.trim().length > caps.questions.maxCharacters).map((entry) => entry.item.id);

    if (tooLong.length > 0) {
        problems.push(`these questions have more than ${caps.questions.maxCharacters} characters, which the API does not accept: ${tooLong.join(", ")}`);
    }

    if (problems.length > 0) {
        stop(`The sweep does not fit the limits of the API. Raise these in the .env of the API and start it again (the counts do not subtract what the account already used today): ${problems.join("; ")}`);
    }
};

// the documents, uploaded or found by their content hash; the hash the server gives must be the one worked out here, or the offsets of
// the evidence would be wrong
const ensureDocuments = async (context: Context, existing: ExistingDocument[]): Promise<Map<string, string>> => {
    const { client, prepared, state } = context;
    const ids = new Map<string, string>();

    for (const document of prepared.documents.values()) {
        const found = existing.find((candidate) => candidate.contentHash === document.contentHash);

        if (found !== undefined) {
            ids.set(document.name, found.id);
            state.documents.push({ name: document.name, id: found.id, contentHash: document.contentHash, characters: document.text.length, reused: true });
            continue;
        }

        // the first index of an upload is made at the size the body says: the first size of the sweep, so no other index is built
        const response = await client.send({ method: "POST", path: "/v1/documents", body: { filename: `${document.name}.txt`, text: document.text, chunkSize: prepared.sizes[0] } });
        const id = textAt(response.body, "data", "id");

        if (response.status !== 202 || id === null) {
            return stop(`The upload of the document ${document.name} was refused (${describeAnswer(response.status, response.body)})`);
        }

        if (textAt(response.body, "data", "contentHash") !== document.contentHash) {
            return stop(`The server stored the document ${document.name} under a content hash other than the one the harness worked out, so the offsets of the evidence would be wrong`);
        }

        ids.set(document.name, id);
        state.documents.push({ name: document.name, id, contentHash: document.contentHash, characters: document.text.length, reused: false });
    }

    return ids;
};

// Makes sure the document has a ready index of the size (asking for it, which builds nothing that exists), and waits for it. One at
// a time: the API lets an account have one build in progress. A build in progress or a full queue is waited out; the daily limits
// stop the sweep (the client rejects). An index that fails is recorded and its size skipped.
const ensureIndex = async (context: Context, document: PreparedDocument, documentId: string, size: number): Promise<IndexRecord> => {
    const { client, options, sleep } = context;
    const poll = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = performance.now() + (options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);
    let index: unknown;

    for (;;) {
        const response = await client.send({ method: "POST", path: `/v1/documents/${documentId}/indexes`, body: { chunkSize: size } });

        if (response.status === 200 || response.status === 202) {
            index = field(response.body, "data");
            break;
        }

        if (response.status !== 409 && response.status !== 503) {
            return stop(`The index of ${document.name} at size ${size} was refused (${describeAnswer(response.status, response.body)})`);
        }

        if (performance.now() > deadline) {
            return stop(`The index of ${document.name} at size ${size} could not be started within the build timeout (${describeAnswer(response.status, response.body)})`);
        }

        await sleep(poll);
    }

    const indexId = textAt(index, "id");

    if (indexId === null) {
        return stop("The API did not answer an index in the shape this harness reads");
    }

    for (;;) {
        const status = textAt(index, "status");

        if (status === "ready" || status === "failed") {
            break;
        }

        if (performance.now() > deadline) {
            return stop(`The index of ${document.name} at size ${size} was not ready within the build timeout`);
        }

        await sleep(poll);

        const response = await client.send({ method: "GET", path: `/v1/documents/${documentId}/indexes/${indexId}` });

        if (response.status !== 200) {
            return stop(`The index of ${document.name} at size ${size} could not be read (${describeAnswer(response.status, response.body)})`);
        }

        index = field(response.body, "data");
    }

    const chunkCount = numberAt(index, "chunkCount") ?? -1;
    const expected = chunkText(document.text, size).length;

    if (textAt(index, "status") === "ready" && chunkCount !== expected) {
        return stop(`The index of ${document.name} at size ${size} has ${chunkCount} chunks and the harness cut the document into ${expected}, so the offsets of the evidence would be wrong`);
    }

    const started = textAt(index, "startedAt");
    const finished = textAt(index, "finishedAt");

    return {
        document: document.name,
        chunkSize: size,
        id: indexId,
        status: textAt(index, "status") === "ready" ? "ready" : "failed",
        error: textAt(index, "error"),
        chunkCount,
        embeddingTokens: numberAt(index, "embeddingTokens") ?? 0,
        buildSeconds: started !== null && finished !== null ? round2((Date.parse(finished) - Date.parse(started)) / 1000) : null
    };
};

interface ParsedSearch {
    runId: string;
    status: "matched" | "no_match";
    configurationHash: string;
    configuration: unknown;
    // every fragment, matches and neighbors, in the order the API gave them
    fragments: { chunkIndex: number; retrieval: string; score: number | null }[];
    tokens: number;
    timings: SearchTimings;
}

// the numbers of a 200 answer of a search, and none of its text; null when it is not in the shape the harness reads
const parseSearch = (body: unknown): ParsedSearch | null => {
    const runId = textAt(body, "data", "id");
    const status = textAt(body, "data", "status");
    const configurationHash = textAt(body, "data", "configurationHash");
    const fragments = field(body, "data", "fragments");
    const tokens = numberAt(body, "data", "tokens", "embedding");
    const waitMs = numberAt(body, "data", "timings", "waitMs");
    const embeddingMs = numberAt(body, "data", "timings", "embeddingMs");
    const retrievalMs = numberAt(body, "data", "timings", "retrievalMs");
    const totalMs = numberAt(body, "data", "timings", "totalMs");

    if (runId === null || (status !== "matched" && status !== "no_match") || configurationHash === null || !Array.isArray(fragments) || tokens === null
        || waitMs === null || embeddingMs === null || retrievalMs === null || totalMs === null) {
        return null;
    }

    const parsed: ParsedSearch["fragments"] = [];

    for (const fragment of fragments as unknown[]) {
        const chunkIndex = numberAt(fragment, "chunkIndex");
        const retrieval = textAt(fragment, "retrieval");

        if (chunkIndex === null || retrieval === null) {
            return null;
        }

        parsed.push({ chunkIndex, retrieval, score: numberAt(fragment, "score") });
    }

    return { runId, status, configurationHash, configuration: field(body, "data", "configuration"), fragments: parsed, tokens, timings: { waitMs, embeddingMs, retrievalMs, totalMs } };
};

const matchesOf = (parsed: ParsedSearch): Match[] =>
    parsed.fragments.flatMap((fragment) => (fragment.retrieval === "match" && fragment.score !== null ? [{ chunkIndex: fragment.chunkIndex, score: fragment.score }] : []));

// What the reference run should have returned, worked out from the wide run: its matches at least minScore, the best topK of them, and
// their neighbors within the window that exist, in the order the API puts them.
const deriveReference = (wide: Match[], settings: { topK: number; minScore: number; neighborWindow: number }, chunkCount: number): string => {
    const matches = applyMinScore(wide, settings.minScore).slice(0, settings.topK);
    const neighbors = getNeighborIndexes(matches, settings.neighborWindow).filter((chunkIndex) => chunkIndex < chunkCount);

    return JSON.stringify([...matches.map((match) => [match.chunkIndex, "match"]), ...neighbors.map((chunkIndex) => [chunkIndex, "neighbor"])]);
};

// One search of a question, wide or reference, and its line in runs.jsonl. A search the API answers with an error is a failed line, not
// a stop; the errors that end the sweep (a daily limit, a login that is refused) are thrown by the client.
const search = async (
    context: Context,
    entry: PreparedCase,
    document: DocumentRecord,
    size: number,
    repeat: number,
    kind: "wide" | "reference",
    warmup: boolean
): Promise<{ line: RunLine; parsed: ParsedSearch | null }> => {
    const overrides = kind === "wide" ? { chunkSize: size, topK: WIDE_TOP_K, minScore: WIDE_MIN_SCORE } : { chunkSize: size };
    const started = performance.now();
    const response = await context.client.send({ method: "POST", path: `/v1/documents/${document.id}/search`, body: { question: entry.item.question, overrides } });
    const roundTripMs = round2(performance.now() - started);
    const parsed = response.status === 200 ? parseSearch(response.body) : null;
    const spans = context.prepared.documents.get(entry.item.document)?.spans.get(size) ?? [];
    const evidenceChunks = evidenceChunksAt(entry, spans);

    const base = {
        questionId: entry.item.id,
        answerable: entry.item.answerable,
        chunkSize: size,
        repeat,
        kind,
        evidenceFound: entry.item.answerable ? entry.found : null,
        evidenceChunks,
        roundTripMs,
        warmup,
        attempts: response.attempts
    };

    if (parsed === null) {
        const error = response.status === 200 ? "The answer was not in the shape the harness reads" : messageOf(response.body);

        return {
            parsed: null,
            line: { ...base, runId: null, configurationHash: null, status: "failed", httpStatus: response.status, error, matches: [], rank: null, tokens: null, timings: null }
        };
    }

    const matches = matchesOf(parsed);
    const passages = evidenceChunks.map((occurrences) => ({ occurrences }));

    return {
        parsed,
        line: {
            ...base,
            runId: parsed.runId,
            configurationHash: parsed.configurationHash,
            status: parsed.status,
            httpStatus: response.status,
            error: null,
            matches,
            rank: entry.item.answerable && entry.found ? findRank(matches, passages) : null,
            tokens: parsed.tokens,
            timings: parsed.timings
        }
    };
};

// the settings the server reported for a run, as numbers the derivation reads
const referenceSettingsOf = (configuration: unknown): { topK: number; minScore: number; neighborWindow: number } | null => {
    const topK = numberAt(configuration, "settings", "topK");
    const minScore = numberAt(configuration, "settings", "minScore");
    const neighborWindow = numberAt(configuration, "settings", "neighborWindow");

    return topK === null || minScore === null || neighborWindow === null ? null : { topK, minScore, neighborWindow };
};

const rememberConfigurations = (state: SweepState, size: number, kind: "wide" | "reference", parsed: ParsedSearch): void => {
    const current = state.configurations.get(size) ?? { wide: null, reference: null };

    if (kind === "wide" && current.wide === null) {
        const settings = field(parsed.configuration, "settings");
        const version = numberAt(parsed.configuration, "version");
        const configurationKind = textAt(parsed.configuration, "kind");

        if (isRecord(settings) && version !== null && configurationKind !== null) {
            current.wide = { kind: configurationKind, version, settings, hash: parsed.configurationHash };
        }
    }

    const referenceSettings = referenceSettingsOf(parsed.configuration);

    if (kind === "reference" && current.reference === null && referenceSettings !== null) {
        current.reference = { hash: parsed.configurationHash, ...referenceSettings };
    }

    state.configurations.set(size, current);
};

const sweepSearches = async (context: Context, ids: Map<string, string>, readyIndexes: Map<string, IndexRecord>): Promise<void> => {
    const { prepared, state, output } = context;
    let first = true;
    let done = 0;

    for (const size of prepared.sizes) {
        for (const entry of prepared.cases) {
            const document = state.documents.find((candidate) => candidate.name === entry.item.document);
            const index = readyIndexes.get(`${entry.item.document}|${size}`);

            if (document === undefined || index === undefined || index.status !== "ready" || !ids.has(entry.item.document)) {
                continue;
            }

            for (let repeat = 1; repeat <= prepared.repeat; repeat += 1) {
                const wide = await search(context, entry, document, size, repeat, "wide", first);
                first = false;
                const reference = await search(context, entry, document, size, repeat, "reference", false);

                for (const result of [wide, reference]) {
                    state.lines.push(result.line);
                    await appendRunLine(String(state.folder), result.line);

                    if (result.parsed !== null) {
                        rememberConfigurations(state, size, result.line.kind, result.parsed);
                    }
                }

                // under exact search the reference run is what the wide run gives, cut to the default configuration
                const referenceSettings = reference.parsed === null ? null : referenceSettingsOf(reference.parsed.configuration);

                if (wide.parsed !== null && reference.parsed !== null && referenceSettings !== null) {
                    const expected = deriveReference(wide.line.matches, referenceSettings, index.chunkCount);
                    const actual = JSON.stringify(reference.parsed.fragments.map((fragment) => [fragment.chunkIndex, fragment.retrieval]));

                    if (expected !== actual) {
                        const warning = `The reference run of case ${entry.item.id} at size ${size} is not what the wide run gives when it is cut to the default configuration`;
                        state.warnings.push(warning);
                        output(`Warning: ${warning}`);
                    }
                }

                done += 2;
            }
        }

        output(`Size ${size}: ${done} searches made so far`);
    }
};

// ---- what is written at the end ----

const compareDigests = (start: ModelDigest[], end: ModelDigest[]): string[] =>
    start.flatMap((before) => {
        const after = end.find((candidate) => candidate.name === before.name);

        return after !== undefined && after.digest !== before.digest ? [`The digest of the model ${before.name} changed during the sweep, so its runs may not be comparable`] : [];
    });

const finish = async (context: Context, abortMessage: string | null): Promise<void> => {
    const { prepared, state, options, output } = context;
    const folder = String(state.folder);
    const warnings = [...state.warnings];
    let digestsAtEnd: ModelDigest[] | null = null;

    try {
        digestsAtEnd = await listInstalledModelDigestsService({ timeoutMs: MODEL_LIST_TIMEOUT_MS });
    } catch {
        warnings.push("The model server did not list its models at the end of the sweep, so a change of digest could not be checked");
    }

    if (state.digestsAtStart !== null && digestsAtEnd !== null) {
        warnings.push(...compareDigests(state.digestsAtStart, digestsAtEnd));
    }

    if (prepared.unmatched.length > 0) {
        warnings.push(`The evidence is not in the document for ${prepared.unmatched.join(", ")}: left out of recall`);
    }

    const failedLines = state.lines.filter((line) => line.status === "failed");

    if (failedLines.length > 0) {
        warnings.push(`Searches that failed: ${[...new Set(failedLines.map((line) => `${line.questionId} (size ${line.chunkSize}, HTTP ${line.httpStatus})`))].join(", ")}`);
    }

    for (const index of state.indexes.filter((candidate) => candidate.status === "failed")) {
        warnings.push(`The index of ${index.document} at size ${index.chunkSize} failed${index.error === null ? "" : ` (${index.error})`}: that size was skipped for it`);
    }

    const tokensByQuestion = new Map<string, Set<number>>();

    for (const line of state.lines) {
        if (line.tokens !== null) {
            tokensByQuestion.set(line.questionId, (tokensByQuestion.get(line.questionId) ?? new Set<number>()).add(line.tokens));
        }
    }

    for (const [questionId, counts] of tokensByQuestion) {
        if (counts.size > 1) {
            warnings.push(`The embedding token count of case ${questionId} was not the same in every search, though its text is`);
        }
    }

    const sweepId = path.basename(folder);
    const sizes: Record<string, ReturnType<typeof summarizeSize>> = {};

    for (const size of prepared.sizes) {
        const chunkCount = state.indexes.filter((index) => index.chunkSize === size && index.status === "ready").reduce((sum, index) => sum + index.chunkCount, 0);
        const failedHere = prepared.cases
            .filter((entry) => state.indexes.some((index) => index.chunkSize === size && index.document === entry.item.document && index.status === "failed"))
            .map((entry) => entry.item.id);

        sizes[String(size)] = summarizeSize(state.lines.filter((line) => line.chunkSize === size), chunkCount, failedHere);
    }

    const summary: Summary = { sweepId, sizes, warnings, aborted: abortMessage };

    // the configurations of the sweep as hashes: the wide and reference runs as the server reported them, and every point of the grid
    // that the wide run lets one derive (k, minimum score and window), hashed the way the API hashes a configuration
    const configurationHashes: Record<string, unknown> = {};

    for (const [size, configurations] of state.configurations) {
        const wide = configurations.wide;
        const derived: { topK: number; minScore: number; neighborWindow: number; hash: string }[] = [];

        if (wide !== null) {
            const minScores = [...new Set([WIDE_MIN_SCORE, configurations.reference?.minScore ?? WIDE_MIN_SCORE])];

            for (const topK of RECALL_KS) {
                for (const minScore of minScores) {
                    for (const neighborWindow of CONTEXT_WINDOWS) {
                        const text = toCanonicalJson({ kind: wide.kind, version: wide.version, settings: { ...wide.settings, topK, minScore, neighborWindow } });

                        derived.push({ topK, minScore, neighborWindow, hash: hashSnapshotText(text) });
                    }
                }
            }

            const own = hashSnapshotText(toCanonicalJson({ kind: wide.kind, version: wide.version, settings: wide.settings }));

            if (own !== wide.hash) {
                warnings.push(`The hash of the wide configuration at size ${size} worked out here is not the one the API reported`);
            }
        }

        configurationHashes[String(size)] = { wide: wide?.hash ?? null, reference: configurations.reference?.hash ?? null, derived };
    }

    const packageVersion = await readFile(path.join(options.repositoryRoot ?? path.resolve(import.meta.dirname, "..", ".."), "package.json"), "utf8")
        .then((text) => textAt(JSON.parse(text), "version"))
        .catch(() => null);

    await writeJsonFile(folder, "manifest.json", {
        sweepId,
        startedAt: state.startedAt.toISOString(),
        finishedAt: (options.now ?? (() => new Date()))().toISOString(),
        node: process.version,
        packageVersion,
        apiUrl: new URL(options.apiUrl).origin,
        set: { name: options.setName, sha256: prepared.setSha256, cases: prepared.cases.length },
        sizes: prepared.sizes,
        repeat: prepared.repeat,
        documents: state.documents,
        indexes: state.indexes,
        caps: state.caps,
        modelDigests: { start: state.digestsAtStart, end: digestsAtEnd },
        configurationHashes,
        aborted: abortMessage
    });
    await writeJsonFile(folder, "summary.json", summary);

    // the printed lines are numbers, ids and document names, for the operator's terminal
    for (const line of formatSummary(summary)) {
        output(line);
    }
};

const runSweep = async (context: Context): Promise<RetrievalSweepOutcome> => {
    const { options, prepared, client, state, output } = context;

    // the API and the model server, before anything is spent
    const health = await client.send({ method: "GET", path: "/v1/health" });

    if (health.status !== 200 || textAt(health.body, "data", "database") !== "up") {
        return stop("The API did not report its database as up");
    }

    const digestsAtStart = await readDigests();

    if (!digestsAtStart.some((model) => model.name === EMBEDDING_MODEL)) {
        return stop(`The model server does not have ${EMBEDDING_MODEL}: check \`ollama list\`; pulling the model is a download the owner approves`);
    }

    state.digestsAtStart = digestsAtStart;

    const configuration = await client.send({ method: "GET", path: "/v1/configuration" });

    if (configuration.status !== 200) {
        return stop(`The API did not give its limits (${describeAnswer(configuration.status, configuration.body)})`);
    }

    state.caps = readCaps(configuration.body);

    const documentList = await client.send({ method: "GET", path: "/v1/documents" });

    if (documentList.status !== 200) {
        return stop(`The API did not list the documents (${describeAnswer(documentList.status, documentList.body)})`);
    }

    const existing = readExistingDocuments(documentList.body);

    checkBudget(prepared, state.caps, existing);

    // a sweep never overwrites another
    try {
        state.folder = await createSweepFolder(prepared.dataDirectory, options.setName, state.startedAt);
        await createRunsFile(state.folder);
    } catch (error) {
        state.folder = null;
        return stop(`The folder of the sweep could not be made (a sweep never overwrites another): ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const minutes = Math.ceil((prepared.cases.length * prepared.sizes.length * 2 * prepared.repeat) / state.caps.questions.perMinute);

    output(`Preflight passed: ${prepared.cases.length} cases, ${prepared.documents.size} documents, sizes ${prepared.sizes.join(", ")}; at ${state.caps.questions.perMinute} questions a minute the searches take at least ${minutes} minutes`);

    const ids = await ensureDocuments(context, existing);

    // every build finishes before the first search, so a batch of an index never gets in the way of a timing
    const readyIndexes = new Map<string, IndexRecord>();

    for (const size of prepared.sizes) {
        for (const document of prepared.documents.values()) {
            const id = ids.get(document.name);

            if (id === undefined) {
                continue;
            }

            const record = await ensureIndex(context, document, id, size);

            state.indexes.push(record);
            readyIndexes.set(`${document.name}|${size}`, record);
            output(`Index of size ${size}: ${record.status}, ${record.chunkCount} chunks`);
        }
    }

    await sweepSearches(context, ids, readyIndexes);
    await finish(context, null);

    const failed = state.lines.some((line) => line.status === "failed") || state.indexes.some((index) => index.status === "failed");

    return { exitCode: failed ? 2 : 0, folder: state.folder, message: null, unmatched: prepared.unmatched };
};

// Runs the sweep: the local checks first (no request), then the preflight against the API, then the documents, the indexes and the
// searches, and the files. It never throws for a refusal or a stop: the outcome says it, with a message that holds no private text.
export const runRetrievalSweep = async (options: RetrievalSweepOptions): Promise<RetrievalSweepOutcome> => {
    const output = options.output ?? defaultOutput;
    const now = options.now ?? (() => new Date());
    let context: Context | null = null;
    let unmatched: string[] = [];

    try {
        const prepared = await prepare(options);
        unmatched = prepared.unmatched;

        if (options.check === true) {
            printCheck(prepared, output);
            return { exitCode: 0, folder: null, message: null, unmatched };
        }

        let client: ApiClient;

        try {
            const sleep = options.sleep ?? defaultSleep;

            client = createApiClient({ baseUrl: options.apiUrl, email: options.email, password: options.password, sleep });
        } catch (error) {
            return stop(error instanceof Error ? error.message : "The API address cannot be used");
        }

        context = {
            options,
            prepared,
            client,
            output,
            sleep: options.sleep ?? defaultSleep,
            state: { startedAt: now(), folder: null, lines: [], warnings: [], caps: null, digestsAtStart: null, documents: [], indexes: [], configurations: new Map() }
        };

        return await runSweep(context);
    } catch (error) {
        const message = error instanceof Error ? error.message : "The sweep stopped for a reason that is not known";

        // a sweep that had made its folder keeps what it measured, with the reason it stopped
        if (context !== null && context.state.folder !== null) {
            try {
                await finish(context, message);
            } catch {
                // the reason it stopped is the one to report
            }
        }

        return { exitCode: 1, folder: context?.state.folder ?? null, message, unmatched };
    }
};
