// The only algorithm tokens are signed and verified with.
export const TOKEN_ALGORITHM = "HS256";

// Who made the token and who it is for. A token from another service (even one that signs with the same algorithm
// and, by mistake, the same secret) has no issuer and audience like these, and is refused. Change both names per project.
export const TOKEN_ISSUER = "rag-lab";
export const TOKEN_AUDIENCE = "rag-lab-api";

// The longest email there can be (RFC 5321); also what the users table accepts (its CHECK).
export const MAX_EMAIL_LENGTH = 254;

// Passwords: length matters more than character rules. The maximum keeps a request from making the hash function
// work on a huge string, and login applies it too.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 64;

// Read on every call instead of once at import: server.ts refuses to start without a proper value, and tests
// change it at run time. Returns undefined when it is missing, so callers can answer with a 500.
// The token lifetime (TOKEN_LIFETIME_SECONDS) is in limits.config.ts, with the other numbers a developer tunes.
export const getSecretKey = (): string | undefined => process.env.SECRET_KEY || undefined;
