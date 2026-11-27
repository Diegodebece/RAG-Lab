import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// What the tests of layer 3 (configuration as data) expect, written out here and not read from the app: a test that
// took its expected values from the app's own constants would agree with a wrong constant.

// The eleven settings of configuration version 1 with RAG Web's values, in the order of the settings table.
export const DEFAULT_SETTINGS: Record<string, string | number> = {
    chunkSize: 1000,
    embeddingModel: "qwen3-embedding:0.6b",
    retrievalMode: "vector",
    topK: 3,
    minScore: 0.3,
    neighborWindow: 1,
    smallModel: "qwen3.5:4b",
    temperature: 0,
    maxTokens: 1024,
    answerLanguage: "en",
    answerMode: "baseline"
};

export const SETTING_KEYS: string[] = Object.keys(DEFAULT_SETTINGS);

// An unknown setting key is echoed back in a detail only up to 64 characters; a longer one is cut there and ends in
// this sign (U+2026). Built from its number, so this file holds no character that is hard to see.
export const ELLIPSIS = String.fromCodePoint(0x2026);

// the detail for an unknown key of 15,000 characters (the longest a 16 kB body can carry in one key) made of one letter
export const LONG_KEY = "k".repeat(15_000);
export const LONG_KEY_DETAIL = `Unknown setting: ${"k".repeat(64)}${ELLIPSIS}`;

// A list of details compared with the expected ones. A failure shows each text cut to 120 characters: the keys of
// these tests are 15,000 characters long, and a plain deepEqual would print them whole.
export const assertDetails = (actual: unknown, expected: string[], label = "details"): void => {
    const clipped = JSON.stringify(actual, (_key, value: unknown) =>
        typeof value === "string" && value.length > 120 ? `${value.slice(0, 120)}... (${value.length} characters)` : value);

    assert.ok(
        Array.isArray(actual) && actual.length === expected.length && actual.every((detail, index) => detail === expected[index]),
        `${label}: expected ${expected.length} detail(s) equal to the expected ones, got ${clipped}`
    );
};

// The text of a body with an own "__proto__" key next to a value past its cap and an unknown key, which JSON.parse keeps
// as own keys and an object literal would not.
export const PROTO_WITH_OTHER_ERRORS = "{\"__proto__\": {}, \"topK\": 99, \"foo\": 1}";

export interface ExpectedDefinition {
    key: string;
    label: string;
    kind: "index" | "question";
    type: "integer" | "number" | "string";
    allowed?: (string | number)[];
    min?: number;
    max?: number;
    decimals?: number;
}

// what GET /v1/configuration lists for each setting, in this order
export const SETTING_DEFINITIONS: ExpectedDefinition[] = [
    { key: "chunkSize", label: "Chunk size", kind: "index", type: "integer", allowed: [300, 500, 750, 1000, 2000, 5000] },
    { key: "embeddingModel", label: "Embedding model", kind: "index", type: "string", allowed: ["qwen3-embedding:0.6b"] },
    { key: "retrievalMode", label: "Retrieval mode", kind: "question", type: "string", allowed: ["vector"] },
    { key: "topK", label: "Top K", kind: "question", type: "integer", min: 1, max: 30 },
    { key: "minScore", label: "Minimum score", kind: "question", type: "number", min: 0, max: 1, decimals: 2 },
    { key: "neighborWindow", label: "Neighbor window", kind: "question", type: "integer", allowed: [1, 2] },
    { key: "smallModel", label: "Small model", kind: "question", type: "string", allowed: ["qwen3.5:4b"] },
    { key: "temperature", label: "Temperature", kind: "question", type: "number", min: 0, max: 1, decimals: 2 },
    { key: "maxTokens", label: "Max tokens", kind: "question", type: "integer", min: 1, max: 1024 },
    { key: "answerLanguage", label: "Answer language", kind: "question", type: "string", allowed: ["en", "es"] },
    { key: "answerMode", label: "Answer mode", kind: "question", type: "string", allowed: ["baseline", "structured"] }
];

export const LABELS: Record<string, string> = Object.fromEntries(SETTING_DEFINITIONS.map((definition) => [definition.key, definition.label]));

const sortedDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(sortedDeep);
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortedDeep(record[key])]));
    }

    return value;
};

// The canonical text of a snapshot, made here on its own: keys sorted at every level, no spaces.
export const canonicalText = (value: unknown): string => JSON.stringify(sortedDeep(value));

export const sha256Hex = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// The snapshot of the default profile as the resolver builds it.
export const DEFAULT_SNAPSHOT = { version: 1, settings: DEFAULT_SETTINGS };

// The canonical text of DEFAULT_SNAPSHOT, written out.
export const DEFAULT_SNAPSHOT_TEXT = "{\"settings\":{\"answerLanguage\":\"en\",\"answerMode\":\"baseline\",\"chunkSize\":1000,\"embeddingModel\":\"qwen3-embedding:0.6b\",\"maxTokens\":1024,\"minScore\":0.3,\"neighborWindow\":1,\"retrievalMode\":\"vector\",\"smallModel\":\"qwen3.5:4b\",\"temperature\":0,\"topK\":3},\"version\":1}";

// SHA-256 of DEFAULT_SNAPSHOT_TEXT, a literal: it changes only when the configuration's version-1 values change.
export const DEFAULT_SNAPSHOT_HASH = "58589ffe3a2fe4d6a19eaf6b1313a4512007c99b50d28cc4a904a5293d6466f3";
