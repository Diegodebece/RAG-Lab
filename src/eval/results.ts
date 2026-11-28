import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contextAtK, fullAtK, hitAtK, nearestRankPercentile, topScore } from "./metrics.js";
import type { Match, Passage } from "./metrics.js";

// What a sweep writes, in a folder of its own in the data directory: manifest.json (what it ran on), runs.jsonl (one line for each
// search) and summary.json (the numbers), and what it prints. Everything here is ids, numbers and the names of the documents (the
// owner's own file names), and it goes only to the private data folder and to the operator's terminal: never a question, a passage,
// a piece of a document, a password or a token.

export const RECALL_KS = [1, 3, 5, 10, 20, 30];
export const CONTEXT_WINDOWS = [1, 2];

// the k and the window of the default configuration, which the reference run uses
const REFERENCE_WINDOW = 1;

export interface SearchTimings {
    waitMs: number;
    embeddingMs: number;
    retrievalMs: number;
    totalMs: number;
}

// One search, as one line of runs.jsonl. A search that failed has no run id, no matches and no timings.
export interface RunLine {
    questionId: string;
    answerable: boolean;
    chunkSize: number;
    // which of the repeats of the sweep this is, from 1
    repeat: number;
    // the wide run (topK 30, minScore 0) or the reference run (the default configuration)
    kind: "wide" | "reference";
    runId: string | null;
    configurationHash: string | null;
    status: "matched" | "no_match" | "failed";
    // the HTTP status of the answer, and why a search failed (the server's own message, which never quotes the question)
    httpStatus: number;
    error: string | null;
    // the matches (not their neighbors), best first
    matches: Match[];
    // true when every passage of the evidence was found in the document; null for a question that has none
    evidenceFound: boolean | null;
    // for each passage, the chunks each of its occurrences touches
    evidenceChunks: number[][][];
    // the place of the first match on the evidence, from 1; null when none is
    rank: number | null;
    tokens: number | null;
    timings: SearchTimings | null;
    // the whole call of the client, waiting and retries included
    roundTripMs: number;
    // true for the first search of the sweep, which is left out of the latency figures: the model may need loading
    warmup: boolean;
    // the requests the client sent for it
    attempts: number;
}

export interface Percentiles {
    n: number;
    p50: number;
    p95: number;
}

export interface LatencySummary {
    embeddingMs: Percentiles | null;
    retrievalMs: Percentiles | null;
    totalMs: Percentiles | null;
    roundTripMs: Percentiles | null;
}

export interface SizeSummary {
    chunkCount: number;
    questions: number;
    answerable: number;
    evidenceFound: number;
    unmatched: string[];
    // the questions that were not answered (a search that failed, or an index that did not get ready)
    failed: string[];
    // fractions of the answerable questions whose evidence was found, 0 to 1; null when there are none
    hitAtK: Record<string, number | null>;
    fullAtK: Record<string, number | null>;
    // by window, then by k
    contextAtK: Record<string, Record<string, number | null>>;
    rank: { mean: number | null; median: number | null; notInTop30: number };
    // the default configuration: its context recall (the evidence inside its matches and their neighbors) and its searches that found nothing
    reference: { contextRecall: number | null; noMatch: number };
    latency: { wide: LatencySummary; reference: LatencySummary };
    tokens: { mean: number | null; total: number };
    topScore: { answerable: Percentiles | null; unanswerable: Percentiles | null };
}

export interface Summary {
    sweepId: string;
    sizes: Record<string, SizeSummary>;
    warnings: string[];
    aborted: string | null;
}

const fraction = (count: number, total: number): number | null => (total === 0 ? null : count / total);

const percentiles = (values: number[]): Percentiles | null =>
    values.length === 0 ? null : { n: values.length, p50: nearestRankPercentile(values, 50), p95: nearestRankPercentile(values, 95) };

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const toPassages = (line: RunLine): Passage[] => line.evidenceChunks.map((occurrences) => ({ occurrences }));

const unique = (values: string[]): string[] => [...new Set(values)];

// latency of the searches of one kind: the server's own timings and the client's round trip; the warm-up is left out, and so is the
// round trip of a search that needed more than one request (it includes the waiting)
const latencyOf = (lines: RunLine[]): LatencySummary => {
    const measured = lines.filter((line) => line.status !== "failed" && line.timings !== null && !line.warmup);

    return {
        embeddingMs: percentiles(measured.map((line) => line.timings?.embeddingMs ?? 0)),
        retrievalMs: percentiles(measured.map((line) => line.timings?.retrievalMs ?? 0)),
        totalMs: percentiles(measured.map((line) => line.timings?.totalMs ?? 0)),
        roundTripMs: percentiles(measured.filter((line) => line.attempts === 1).map((line) => line.roundTripMs))
    };
};

// The numbers of one chunk size, from its lines. `chunkCount` is the chunks of the indexes of that size, every document together.
export const summarizeSize = (lines: RunLine[], chunkCount: number, failedAtThisSize: string[]): SizeSummary => {
    const wide = lines.filter((line) => line.kind === "wide");
    const reference = lines.filter((line) => line.kind === "reference");
    const answered = wide.filter((line) => line.status !== "failed");

    // the questions that count for recall: answerable, with the evidence found in the document, and answered
    const scored = answered.filter((line) => line.answerable && line.evidenceFound === true);
    const ranks = scored.flatMap((line) => (line.rank === null ? [] : [line.rank]));
    const scoredReference = reference.filter((line) => line.status !== "failed" && line.answerable && line.evidenceFound === true);

    const countWhere = (test: (line: RunLine) => boolean): number => scored.filter(test).length;

    const unmatchedLines = wide.filter((line) => line.answerable && line.evidenceFound === false);

    return {
        chunkCount,
        questions: unique(wide.map((line) => line.questionId)).length,
        answerable: unique(wide.filter((line) => line.answerable).map((line) => line.questionId)).length,
        evidenceFound: unique(scored.map((line) => line.questionId)).length,
        unmatched: unique(unmatchedLines.map((line) => line.questionId)),
        failed: unique([...lines.filter((line) => line.status === "failed").map((line) => line.questionId), ...failedAtThisSize]),
        hitAtK: Object.fromEntries(RECALL_KS.map((k) => [String(k), fraction(countWhere((line) => hitAtK(line.matches, toPassages(line), k)), scored.length)])),
        fullAtK: Object.fromEntries(RECALL_KS.map((k) => [String(k), fraction(countWhere((line) => fullAtK(line.matches, toPassages(line), k)), scored.length)])),
        contextAtK: Object.fromEntries(CONTEXT_WINDOWS.map((window) => [
            String(window),
            Object.fromEntries(RECALL_KS.map((k) => [String(k), fraction(countWhere((line) => contextAtK(line.matches, toPassages(line), k, window)), scored.length)]))
        ])),
        rank: {
            mean: mean(ranks),
            median: ranks.length === 0 ? null : nearestRankPercentile(ranks, 50),
            notInTop30: scored.length - ranks.length
        },
        reference: {
            contextRecall: fraction(
                scoredReference.filter((line) => contextAtK(line.matches, toPassages(line), line.matches.length, REFERENCE_WINDOW)).length,
                scoredReference.length
            ),
            noMatch: reference.filter((line) => line.status === "no_match").length
        },
        latency: { wide: latencyOf(wide), reference: latencyOf(reference) },
        tokens: (() => {
            const counted = lines.flatMap((line) => (line.tokens === null ? [] : [line.tokens]));

            return { mean: mean(counted), total: counted.reduce((sum, value) => sum + value, 0) };
        })(),
        topScore: {
            answerable: percentiles(answered.filter((line) => line.answerable).flatMap((line) => topScore(line.matches) ?? [])),
            unanswerable: percentiles(answered.filter((line) => !line.answerable).flatMap((line) => topScore(line.matches) ?? []))
        }
    };
};

// ---- printing ----

const show = (value: number | null, decimals = 2): string => (value === null ? "n/a" : value.toFixed(decimals));

const showPercentiles = (value: Percentiles | null): string => (value === null ? "n/a" : `${value.p50.toFixed(1)}/${value.p95.toFixed(1)}`);

const showLatency = (latency: LatencySummary): string =>
    `embedding ${showPercentiles(latency.embeddingMs)}, retrieval ${showPercentiles(latency.retrievalMs)}, total ${showPercentiles(latency.totalMs)}, round trip ${showPercentiles(latency.roundTripMs)} ms`;

const showByK = (values: Record<string, number | null>): string => RECALL_KS.map((k) => `${k}: ${show(values[String(k)])}`).join("  ");

// The lines a sweep prints: for each size its chunk count, the questions, the recall, the rank, the default configuration, the latency
// (p50/p95), the tokens and the top-1 scores, and then every warning. Numbers and ids only.
export const formatSummary = (summary: Summary): string[] => {
    const lines: string[] = [`Sweep ${summary.sweepId}`];

    for (const [size, entry] of Object.entries(summary.sizes)) {
        lines.push(
            `Chunk size ${size}: ${entry.chunkCount} chunks; ${entry.questions} questions, ${entry.answerable} answerable, evidence found for ${entry.evidenceFound}, not found for ${entry.unmatched.length}`,
            `  hit@k    ${showByK(entry.hitAtK)}`,
            `  full@k   ${showByK(entry.fullAtK)}`,
            ...CONTEXT_WINDOWS.map((window) => `  context@k, window ${window}   ${showByK(entry.contextAtK[String(window)])}`),
            `  rank of the evidence: mean ${show(entry.rank.mean)}, median ${show(entry.rank.median, 0)}, not in the top 30: ${entry.rank.notInTop30}`,
            `  default configuration: context recall ${show(entry.reference.contextRecall)}, searches that found nothing: ${entry.reference.noMatch}`,
            `  latency of wide runs (p50/p95): ${showLatency(entry.latency.wide)}`,
            `  latency of reference runs (p50/p95): ${showLatency(entry.latency.reference)}`,
            `  embedding tokens: mean ${show(entry.tokens.mean, 1)}, total ${entry.tokens.total}`,
            `  top-1 score (p50/p95): answerable ${showPercentiles(entry.topScore.answerable)}, unanswerable ${showPercentiles(entry.topScore.unanswerable)}`
        );
    }

    if (summary.aborted !== null) {
        lines.push(`Stopped before the end: ${summary.aborted}`);
    }

    lines.push(summary.warnings.length === 0 ? "Warnings: none" : `Warnings (${summary.warnings.length}):`, ...summary.warnings.map((warning) => `  ${warning}`));

    return lines;
};

// ---- the files ----

// one line of runs.jsonl, added as soon as the search is done, so a sweep that stops halfway keeps what it measured
export const appendRunLine = async (folder: string, line: RunLine): Promise<void> => {
    await appendFile(path.join(folder, "runs.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
};

// manifest.json and summary.json: JSON with two spaces of indentation
export const writeJsonFile = async (folder: string, name: "manifest.json" | "summary.json", value: unknown): Promise<void> => {
    await writeFile(path.join(folder, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

// makes runs.jsonl exist even when no search was made
export const createRunsFile = async (folder: string): Promise<void> => {
    await writeFile(path.join(folder, "runs.jsonl"), "", { encoding: "utf8", flag: "wx" });
};
