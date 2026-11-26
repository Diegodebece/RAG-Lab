import { readIntegerSetting } from "./env.config.js";

// The only algorithm tokens are signed and verified with.
export const TOKEN_ALGORITHM = "HS256";

// How long a token stays valid: from one second to one day. A value out of range stops the app at startup.
// A project with a limits config may keep this value there instead (RAG Lab does: config/limits.config.ts).
export const TOKEN_LIFETIME_SECONDS = readIntegerSetting("TOKEN_LIFETIME_SECONDS", 3600, 1, 86400);

// Read on every call instead of once at import, so tests can change it at run time.
// Returns undefined when it is missing, so callers can answer with a 500.
export const getSecretKey = (): string | undefined => process.env.SECRET_KEY || undefined;
