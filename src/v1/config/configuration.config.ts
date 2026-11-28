// The definition of configuration version 1: the settings a user may change, and the caps on their values. The values
// the settings have by default are data (the default_profile table, see migrations/004_default_profile.sql); what is
// here is the server's own limit on them, and nothing a user or a profile can change. A value outside its cap is
// refused, never shortened to fit. A cap changes with a new version of the configuration and a migration, not here
// alone.

// stored with every profile and every snapshot; the server refuses to start when stored data is at another version
export const CONFIGURATION_VERSION = 1;

// the settings of version 1, in the order the API lists them
export const SETTING_KEYS = [
    "chunkSize",
    "embeddingModel",
    "retrievalMode",
    "topK",
    "minScore",
    "neighborWindow",
    "smallModel",
    "temperature",
    "maxTokens",
    "answerLanguage",
    "answerMode"
] as const;

// The settings a search (retrieval only, no answer) runs with and stores: the other five do not apply to it, so a search never
// accepts, stores or hashes them.
export const RETRIEVAL_SETTING_KEYS = ["chunkSize", "embeddingModel", "retrievalMode", "topK", "minScore", "neighborWindow"] as const;

// What each setting may hold. `kind` says whether changing it needs the documents indexed again (index) or only a
// new question (question). A setting with `allowed` takes exactly one of those values, compared as written; the models
// are limited to the ones the health check requires (REQUIRED_MODELS in ollama.config.ts), so a setting can never name
// a model the server does not have. A setting with `min` and `max` takes a number in that range, with at most
// `decimals` decimal places when the cap has them and a whole number when its type is integer.
export const SETTING_CAPS = {
    chunkSize: { label: "Chunk size", kind: "index", type: "integer", allowed: [300, 500, 750, 1000, 2000, 5000] },
    embeddingModel: { label: "Embedding model", kind: "index", type: "string", allowed: ["qwen3-embedding:0.6b"] },
    retrievalMode: { label: "Retrieval mode", kind: "question", type: "string", allowed: ["vector"] },
    topK: { label: "Top K", kind: "question", type: "integer", min: 1, max: 30 },
    minScore: { label: "Minimum score", kind: "question", type: "number", min: 0, max: 1, decimals: 2 },
    neighborWindow: { label: "Neighbor window", kind: "question", type: "integer", allowed: [1, 2] },
    smallModel: { label: "Small model", kind: "question", type: "string", allowed: ["qwen3.5:4b"] },
    temperature: { label: "Temperature", kind: "question", type: "number", min: 0, max: 1, decimals: 2 },
    maxTokens: { label: "Max tokens", kind: "question", type: "integer", min: 1, max: 1024 },
    answerLanguage: { label: "Answer language", kind: "question", type: "string", allowed: ["en", "es"] },
    answerMode: { label: "Answer mode", kind: "question", type: "string", allowed: ["baseline", "structured"] }
} as const;

// the longest name of a profile, in characters (the profiles table checks the same number)
export const PROFILE_NAME_MAX_LENGTH = 100;

// The largest body the configuration and profile routes read. A profile has eleven small values, so 16 kB is far
// more than it needs; a bigger body is refused before it is parsed.
export const CONFIGURATION_BODY_LIMIT = "16kb";
