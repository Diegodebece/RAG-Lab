import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "../../src/v1/utils/password.util.js";

const PASSWORD = "correct horse battery staple";

// one real hash for the checks that only read it: each costs about 400 ms
let stored = "";

before(async () => {
    stored = await hashPassword(PASSWORD);
});

// a stored hash made with chosen cost parameters, using node:crypto directly (not the code under test)
const storedWith = (password: string, N: number, r: number, p: number): string => {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { N, r, p });

    return ["scrypt", N, r, p, salt.toString("hex"), hash.toString("hex")].join("$");
};

describe("hashPassword", () => {
    it("stores the algorithm, cost parameters, salt and hash", () => {
        const [algorithm, N, r, p, salt, hash] = stored.split("$");

        assert.equal(algorithm, "scrypt");
        // OWASP's scrypt setting for 16 MiB of memory: N = 2^14, r = 8, p = 5
        assert.deepEqual([N, r, p], ["16384", "8", "5"]);
        assert.match(salt, /^[0-9a-f]{32}$/);
        assert.match(hash, /^[0-9a-f]{128}$/);
    });

    it("never stores the password itself", () => {
        assert.ok(!stored.includes(PASSWORD));
    });

    it("gives the same password a different hash every time, thanks to the random salt", async () => {
        assert.notEqual(await hashPassword(PASSWORD), stored);
    });
});

describe("verifyPassword", () => {
    it("accepts the right password and rejects any other", async () => {
        assert.equal(await verifyPassword(PASSWORD, stored), true);
        assert.equal(await verifyPassword("correct horse battery stapler", stored), false);
        assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
    });

    it("handles passwords with spaces and accented letters", async () => {
        const spaced = await hashPassword("  contraseña con ñ y tildes áé  ");

        assert.equal(await verifyPassword("  contraseña con ñ y tildes áé  ", spaced), true);
        assert.equal(await verifyPassword("contraseña con ñ y tildes áé", spaced), false, "spaces are part of the password");
    });

    it("accepts the same password typed in another Unicode form", async () => {
        const precomposed = `caf${String.fromCodePoint(0xe9)}`;
        const decomposed = `cafe${String.fromCodePoint(0x301)}`;

        assert.equal(await verifyPassword(decomposed, await hashPassword(precomposed)), true);
        assert.equal(await verifyPassword(precomposed, await hashPassword(decomposed)), true);
    });

    // NFKC, not only NFC: a compatibility form (the "fi" ligature, a full-width letter) is the same password too
    it("accepts a compatibility form of the same password (NFKC)", async () => {
        const ligature = `${String.fromCodePoint(0xfb01)}rst password`;

        assert.equal(await verifyPassword("first password", await hashPassword(ligature)), true);
        assert.equal(await verifyPassword(ligature, await hashPassword("first password")), true);
    });

    it("still accepts passwords hashed with the earlier cost parameters (p = 1)", async () => {
        const old = storedWith("old password", 16384, 8, 1);

        assert.equal(await verifyPassword("old password", old), true);
        assert.equal(await verifyPassword("other password", old), false);
    });

    it("rejects values that are not a stored scrypt hash", async () => {
        for (const value of ["", "plain-text-password", "bcrypt$10$abc", "scrypt$16384$8$1$$", "scrypt$16384$8$1$abcd$zz"]) {
            assert.equal(await verifyPassword("anything", value), false, value);
        }
    });

    // The cost parameters come from the stored value, which only the app writes, but a row edited by hand or restored
    // from somewhere else must never make a login throw (a 500) or allocate gigabytes of memory.
    it("returns false, without throwing, for cost parameters outside the allowed range", { timeout: 20_000 }, async () => {
        const salt = randomBytes(16).toString("hex");
        const hash = randomBytes(64).toString("hex");
        const withCost = (N: string, r: string, p: string): string => ["scrypt", N, r, p, salt, hash].join("$");

        const cases: Record<string, string> = {
            "N that is not a power of two (3)": withCost("3", "8", "1"),
            "N of zero": withCost("0", "8", "1"),
            "N of one": withCost("1", "8", "1"),
            "a negative N": withCost("-16384", "8", "1"),
            "a huge N (2^30)": withCost("1073741824", "8", "1"),
            "an N beyond the safe integers": withCost("99999999999999999999", "8", "1"),
            "N that is not a number": withCost("many", "8", "1"),
            "a fractional N": withCost("16384.5", "8", "1"),
            "r of zero": withCost("16384", "0", "1"),
            "a huge r": withCost("16384", "1073741824", "1"),
            "r that is not a number": withCost("16384", "wide", "1"),
            "p of zero": withCost("16384", "8", "0"),
            "a negative p": withCost("16384", "8", "-1"),
            "a huge p": withCost("16384", "8", "4294967295"),
            "p that is not a number": withCost("16384", "8", "NaN"),
            "an empty N": withCost("", "8", "1")
        };

        for (const [label, value] of Object.entries(cases)) {
            const started = Date.now();

            assert.equal(await verifyPassword("anything", value), false, label);
            assert.ok(Date.now() - started < 3000, `${label}: it answered at once instead of working on it`);
        }
    });
});

describe("needsRehash", () => {
    it("is false for a hash with the current parameters", () => {
        assert.equal(needsRehash(stored), false);
    });

    it("is true for a hash made with the earlier parameters (p = 1)", () => {
        assert.equal(needsRehash(storedWith("old password", 16384, 8, 1)), true);
    });

    it("is true when only N or only r differs", () => {
        assert.equal(needsRehash(storedWith("another", 8192, 8, 5)), true);
        assert.equal(needsRehash(storedWith("another", 16384, 4, 5)), true);
    });
});
