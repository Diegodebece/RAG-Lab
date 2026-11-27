// The plain hyphenated form of a UUID, of any version and in either case: no braces, no missing hyphens, no other
// separators. Also the rule of the validators, so an id is never one thing to a schema and another to a lookup.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checked before querying by id: PostgreSQL rejects a malformed UUID with an error (code 22P02) that would
// become a 500. Services answer a malformed id with the same 404 as an unknown one.
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);
