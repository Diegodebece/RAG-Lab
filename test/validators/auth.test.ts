import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ValidationResult } from "joi";
import { loginUserSchema } from "../../src/v1/validators/auth.validator.js";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (body: unknown): ValidationResult => loginUserSchema.validate(body, { abortEarly: false });

// the keys of the fields that were refused
const refusedFields = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

// special characters from code points, so this file stays plain ASCII
const char = (codePoint: number): string => String.fromCodePoint(codePoint);

// An address of exactly `length` characters that is valid in every other way: a 64-character local part and
// domain labels of at most 63 characters, ending in .com.
const emailOfLength = (length: number): string => {
    const local = "a".repeat(64);
    const domainLength = length - local.length - 1;
    // labels: 63, 63 and a middle one that takes the rest, then com (3 + 1 for its dot)
    const middle = domainLength - 63 - 1 - 63 - 1 - 4;
    assert.ok(middle >= 1 && middle <= 63, `cannot build an address of ${length} characters`);

    return `${local}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(middle)}.com`;
};

describe("the login schema: email", () => {
    it("accepts a valid email and gives it back trimmed, lowercased and in Unicode form NFC", () => {
        // "jose" with the accent as a combining character (NFD), padded and with capitals
        const result = validate({ email: `  Jose${char(0x301)}@Example.COM  `, password: "x" });

        assert.equal(result.error, undefined);
        assert.equal(result.value.email, `jos${char(0xe9)}@example.com`);
    });

    it("rejects an invalid email, an empty one and a missing one", () => {
        for (const email of ["not-an-email", "a@b", "@example.com", "a b@example.com", "", "   "]) {
            assert.deepEqual(refusedFields(validate({ email, password: "x" })), ["email"], JSON.stringify(email));
        }

        assert.deepEqual(refusedFields(validate({ password: "x" })), ["email"], "missing");
    });

    it("rejects an email that is not a string", () => {
        for (const email of [["a@example.com"], { $gt: "" }, 42, true, null]) {
            const result = validate({ email, password: "x" });

            assert.deepEqual(refusedFields(result), ["email"], JSON.stringify(email));
        }

        assert.match(validate({ email: ["a@example.com"], password: "x" }).error?.details.map((detail) => detail.message).join(" ") ?? "", /must be a string/);
    });

    it("accepts an email of exactly 254 characters and rejects one of 255", () => {
        assert.equal(emailOfLength(254).length, 254);
        assert.equal(validate({ email: emailOfLength(254), password: "x" }).error, undefined);

        assert.equal(emailOfLength(255).length, 255);
        assert.deepEqual(refusedFields(validate({ email: emailOfLength(255), password: "x" })), ["email"]);
    });

    // the length is checked after trimming: spaces around an address that fits are not part of it
    it("accepts an email of 254 characters with spaces around it, and rejects one of 255 with spaces around it", () => {
        const padded = `   ${emailOfLength(254)}   `;
        assert.ok(padded.length > 254);

        const accepted = validate({ email: padded, password: "x" });
        assert.equal(accepted.error, undefined);
        assert.equal(accepted.value.email, emailOfLength(254));

        assert.deepEqual(refusedFields(validate({ email: `   ${emailOfLength(255)}   `, password: "x" })), ["email"]);
    });

    it("rejects a 90,000-character email", () => {
        assert.deepEqual(refusedFields(validate({ email: `${"a".repeat(90_000)}@example.com`, password: "x" })), ["email"]);
    });

    it("rejects an email with a null byte or a line break", () => {
        for (const email of [`a${char(0)}b@example.com`, `a${char(10)}b@example.com`]) {
            assert.deepEqual(refusedFields(validate({ email, password: "x" })), ["email"], JSON.stringify(email));
        }
    });
});

describe("the login schema: password", () => {
    it("has no minimum length: login only checks the password, it does not enforce the policy again", () => {
        assert.equal(validate({ email: "a@example.com", password: "x" }).error, undefined);
    });

    it("accepts 64 characters and rejects 65", () => {
        assert.equal(validate({ email: "a@example.com", password: "x".repeat(64) }).error, undefined);
        assert.deepEqual(refusedFields(validate({ email: "a@example.com", password: "x".repeat(65) })), ["password"]);
    });

    it("rejects an empty password and a missing one", () => {
        assert.deepEqual(refusedFields(validate({ email: "a@example.com", password: "" })), ["password"]);
        assert.deepEqual(refusedFields(validate({ email: "a@example.com" })), ["password"]);
    });

    it("never trims the password: spaces are part of it", () => {
        const result = validate({ email: "a@example.com", password: "  padded password  " });

        assert.equal(result.error, undefined);
        assert.equal(result.value.password, "  padded password  ");
        assert.equal(validate({ email: "a@example.com", password: "   " }).value.password, "   ", "a password of spaces stays as it is");
    });

    it("rejects a password that is not a string", () => {
        for (const password of [["secret password"], { $ne: "" }, 12345678, null]) {
            assert.deepEqual(refusedFields(validate({ email: "a@example.com", password })), ["password"], JSON.stringify(password));
        }
    });
});

describe("the login schema: other fields", () => {
    it("rejects keys it does not know, so a client cannot send fields the route never meant to read", () => {
        for (const extra of [{ role: "admin" }, { status: "active" }, { tokenVersion: 5 }, { rememberMe: true }]) {
            const result = validate({ email: "a@example.com", password: "x", ...extra });

            assert.deepEqual(refusedFields(result), [Object.keys(extra)[0]], JSON.stringify(extra));
        }
    });

    it("rejects a body without fields, reporting both as missing", () => {
        assert.deepEqual(refusedFields(validate({})).sort(), ["email", "password"]);
    });
});
