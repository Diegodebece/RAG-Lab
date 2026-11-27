import type { RETRIEVAL_SETTING_KEYS } from "../config/configuration.config.js";
import type { ConfigurationSettings } from "./configuration.type.js";

// the kinds of run and their statuses; layer 6 adds the answer kind with its own migration
export type RunKind = "retrieval";
export type RunStatus = "matched" | "no_match";

// the six settings a search runs with: the five answer settings do not apply to it
export type RetrievalSettings = Pick<ConfigurationSettings, (typeof RETRIEVAL_SETTING_KEYS)[number]>;

// what a search stores and hashes: the kind, the configuration version and the six settings, and nothing else
export interface RetrievalSnapshot {
    kind: "retrieval";
    version: number;
    settings: Readonly<RetrievalSettings>;
}

// a chunk of the document placed in the result: a match, or the neighbor of one (ported from RAG Web, where the model cites it as [F1])
export interface Fragment {
    id: string;
    chunkIndex: number;
    text: string;
    retrieval: "match" | "neighbor";
    score?: number;
}

// milliseconds, written with two decimals
export interface RunTimings {
    // waiting for the model's turn (and for the daily count)
    waitMs: number;
    embeddingMs: number;
    retrievalMs: number;
    totalMs: number;
}

// the response of a search: the run as stored, plus the fragments (their text is never stored)
export interface RetrievalRun {
    id: string;
    kind: RunKind;
    status: RunStatus;
    documentId: string;
    indexId: string;
    profileId: string | null;
    configuration: Readonly<RetrievalSnapshot>;
    configurationHash: string;
    fragments: Fragment[];
    tokens: { embedding: number };
    timings: RunTimings;
    createdAt: string;
}
