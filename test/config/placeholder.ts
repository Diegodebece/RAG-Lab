// The SECRET_KEY placeholder that .env.example carries. It is longer than the 32 characters a secret needs, so
// the length rule cannot reject it: only the check for this exact value can. A placeholder that is too short
// would be rejected by the length rule, and the check for the placeholder itself could be missing.
export const SECRET_KEY_PLACEHOLDER = "change-me-to-a-long-random-value-0000";
