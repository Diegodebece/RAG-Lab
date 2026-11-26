import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

// scrypt cost parameters: N (CPU and memory cost), r (block size), p (parallelism).
// They are stored with every hash, so raising them later keeps old passwords verifiable (hashes made before
// with p = 1 still work). N = 2^14, r = 8, p = 5 is one of OWASP's equivalent settings: each hash needs
// 16 MiB (128 * N * r bytes), and p multiplies the work. OWASP's first option, N = 2^17, needs 128 MiB per
// hash, so four logins at once would take the whole 512 MB the container has.
const COST = { N: 16384, r: 8, p: 5 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// What a stored hash may ask of scrypt. The cost parameters are read from the stored value, which only this file
// writes; a row edited by hand or restored from somewhere else must still never make a login throw (a 500) or
// allocate gigabytes of memory, so anything outside these ranges is simply a password that does not match.
const MIN_N = 2 ** 10;
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 16;
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 128;
const MAX_SALT_BYTES = 64;
// the most memory one scrypt may use (Node's own default limit): 128 * r * (N + p + 2) bytes
const MAX_SCRYPT_MEMORY_BYTES = 32 * 1024 * 1024;

// node:crypto offers scrypt only with a callback; this wraps it in a promise so callers can use await.
const deriveKey = (password: string, salt: Buffer, keyBytes: number, options: ScryptOptions): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        scrypt(password, salt, keyBytes, { ...options, maxmem: MAX_SCRYPT_MEMORY_BYTES }, (error, key) => (error ? reject(error) : resolve(key)));
    });

// The same visible password can arrive in different Unicode forms ("é" as one character, or "e" plus a
// combining accent, depending on the keyboard). NFKC turns them into one form before hashing, as NIST advises.
const normalizePassword = (password: string): string => password.normalize("NFKC");

// Plain decimal digits only: Number() would also read "", " 5 ", "1e3" or "0x10".
const parseWholeNumber = (text: string): number => (/^[0-9]+$/.test(text) ? Number(text) : Number.NaN);

const isUsableCost = (N: number, r: number, p: number): boolean =>
    Number.isSafeInteger(N) && Number.isSafeInteger(r) && Number.isSafeInteger(p)
    && N >= MIN_N && N <= MAX_N && (N & (N - 1)) === 0
    && r >= 1 && r <= MAX_R
    && p >= 1 && p <= MAX_P
    && 128 * r * (N + p + 2) <= MAX_SCRYPT_MEMORY_BYTES;

// Hex text of a whole number of bytes, between the two lengths; Buffer.from(text, "hex") would cut it off silently at the
// first character that is not hex.
const parseHex = (text: string, minBytes: number, maxBytes: number): Buffer | null =>
    /^(?:[0-9a-f]{2})+$/i.test(text) && text.length / 2 >= minBytes && text.length / 2 <= maxBytes ? Buffer.from(text, "hex") : null;

// Returns "scrypt$N$r$p$salt$hash" (salt and hash in hex), the value stored in users.password_hash.
export const hashPassword = async (password: string): Promise<string> => {
    const salt = randomBytes(SALT_BYTES);
    const hash = await deriveKey(normalizePassword(password), salt, KEY_BYTES, COST);

    return ["scrypt", COST.N, COST.r, COST.p, salt.toString("hex"), hash.toString("hex")].join("$");
};

// True when a stored hash was made with other cost parameters than the current ones, so it should be replaced
// the next time its password is known (a successful login).
export const needsRehash = (storedHash: string): boolean => {
    const [, N, r, p] = storedHash.split("$");

    return parseWholeNumber(N ?? "") !== COST.N || parseWholeNumber(r ?? "") !== COST.r || parseWholeNumber(p ?? "") !== COST.p;
};

interface ParsedHash {
    N: number;
    r: number;
    p: number;
    salt: Buffer;
    expected: Buffer;
}

// The parts of a stored hash, or null when it is not one this code can check (the wrong shape, hex that is not hex, or
// cost parameters outside the allowed ranges).
const parseStoredHash = (storedHash: string): ParsedHash | null => {
    const parts = storedHash.split("$");

    if (parts.length !== 6 || parts[0] !== "scrypt") {
        return null;
    }

    const [, costN, costR, costP, saltHex, hashHex] = parts;
    const N = parseWholeNumber(costN);
    const r = parseWholeNumber(costR);
    const p = parseWholeNumber(costP);
    const salt = parseHex(saltHex, 1, MAX_SALT_BYTES);
    const expected = parseHex(hashHex, MIN_KEY_BYTES, MAX_KEY_BYTES);

    if (!isUsableCost(N, r, p) || !salt || !expected) {
        return null;
    }

    return { N, r, p, salt, expected };
};

// True when verifyPassword can check a password against the stored hash; when it cannot, it answers false without
// doing any work.
export const isUsableHash = (storedHash: string): boolean => parseStoredHash(storedHash) !== null;

// Recomputes the hash with the stored salt and parameters. timingSafeEqual takes the same time whether the
// first or the last byte differs, so response times reveal nothing about the hash. A malformed value, or cost
// parameters outside the allowed ranges, is false: it never throws.
export const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
    const parsed = parseStoredHash(storedHash);

    if (!parsed) {
        return false;
    }

    const { N, r, p, salt, expected } = parsed;
    let actual: Buffer;

    try {
        actual = await deriveKey(normalizePassword(password), salt, expected.length, { N, r, p });
    } catch {
        // scrypt refused the parameters (the memory limit, for example): the stored value is not one this code made
        return false;
    }

    return timingSafeEqual(actual, expected);
};
