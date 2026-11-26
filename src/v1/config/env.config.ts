// A token signed with a short or well-known secret can be forged by guessing the secret offline.
const MIN_SECRET_KEY_LENGTH = 32;

// The value .env.example carries for SECRET_KEY. It is long enough for the length rule, so it has to be refused by
// name (the shorter placeholder it replaced is caught by the length rule).
const PLACEHOLDER_SECRET_KEYS = ["change-me-to-a-long-random-value-0000"];

// True for an absolute http or https URL with a host, such as http://localhost:11434
const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
    } catch {
        return false;
    }
};

// Settings the server cannot run safely without. server.ts refuses to start while any problem is listed,
// instead of failing on the first request or running with a guessable secret.
export const getStartupConfigProblems = (env: NodeJS.ProcessEnv): string[] => {
    const problems: string[] = [];
    const secretKey = env.SECRET_KEY ?? "";

    if (secretKey === "") {
        problems.push("SECRET_KEY is not set");
    } else if (PLACEHOLDER_SECRET_KEYS.includes(secretKey)) {
        problems.push(`SECRET_KEY is still the placeholder from .env.example; set a random value of at least ${MIN_SECRET_KEY_LENGTH} characters`);
    } else if (secretKey.length < MIN_SECRET_KEY_LENGTH) {
        problems.push(`SECRET_KEY must be a random value of at least ${MIN_SECRET_KEY_LENGTH} characters`);
    }

    // empty or missing means the default address (see ollama.config.ts)
    const ollamaBaseUrl = env.OLLAMA_BASE_URL ?? "";

    if (ollamaBaseUrl !== "" && !isHttpUrl(ollamaBaseUrl)) {
        problems.push("OLLAMA_BASE_URL must be an absolute http or https URL, such as http://localhost:11434");
    }

    return problems;
};

// Reads an integer setting from .env. A missing value uses the default; anything that is not a whole number
// from min to max, written with plain decimal digits, stops the app at startup, instead of running with a setting
// that breaks it later (a negative timeout, for example, would make every Ollama request fail). Number() would
// also read "0x10", "1e3" or " 5 " as numbers, so the digits are checked first.
export const readIntegerSetting = (name: string, defaultValue: number, min = 1, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === "") {
        return defaultValue;
    }

    const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;

    if (!Number.isSafeInteger(value) || value < min || value > max) {
        const range = max === Number.MAX_SAFE_INTEGER ? `at least ${min}` : `from ${min} to ${max}`;
        throw new Error(`${name} must be a whole number ${range}`);
    }

    return value;
};

// Reads a comma-separated list from .env, such as "https://a.example, https://b.example".
export const readListSetting = (name: string, defaultValue: string[] = []): string[] => {
    const items = (process.env[name] ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
    return items.length > 0 ? items : defaultValue;
};
