// The only algorithm tokens are signed and verified with.
export const TOKEN_ALGORITHM = "HS256";

// Who made the token and who it is for. A token from another service (RAG Web signs with the same algorithm, with no
// issuer and no audience) is refused even if two deployments shared a SECRET_KEY by mistake.
export const TOKEN_ISSUER = "rag-lab";
export const TOKEN_AUDIENCE = "rag-lab-api";

// The longest email there can be (RFC 5321); also what the database accepts (migrations/003_users.sql).
export const MAX_EMAIL_LENGTH = 254;

// Passwords: length matters more than character rules. The maximum keeps a request from making scrypt hash a huge
// string, and login applies it too.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 64;

// Read on every call instead of once at import: server.ts refuses to start without a proper value, and tests
// change it at run time. Returns undefined when it is missing, so callers can answer with a 500.
export const getSecretKey = (): string | undefined => process.env.SECRET_KEY || undefined;
