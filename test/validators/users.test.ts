import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ObjectSchema, ValidationResult } from "joi";
import { changePasswordSchema, createUserSchema, updateUserSchema } from "../../src/v1/validators/users.validator.js";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (schema: ObjectSchema, body: unknown): ValidationResult => schema.validate(body, { abortEarly: false });

// the keys of the fields that were refused ("" for the body as a whole)
const refusedFields = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const EMAIL = "new.user@example.com";
const PASSWORD = "a long enough password";

describe("the create user schema", () => {
    const create = (body: object): ValidationResult => validate(createUserSchema, body);

    it("accepts an email and a password, and the role is optional", () => {
        assert.equal(create({ email: EMAIL, password: PASSWORD }).error, undefined);
        assert.equal(create({ email: EMAIL, password: PASSWORD, role: "user" }).error, undefined);
        assert.equal(create({ email: EMAIL, password: PASSWORD, role: "admin" }).error, undefined);
    });

    it("gives the email back trimmed, lowercased and in Unicode form NFC", () => {
        const result = create({ email: `  Jose${String.fromCodePoint(0x301)}@Example.COM `, password: PASSWORD });

        assert.equal(result.value.email, `jos${String.fromCodePoint(0xe9)}@example.com`);
    });

    it("accepts an email of 254 characters, also with spaces around it, and rejects one of 255", () => {
        const emailOf = (length: number): string => `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 65 - 132)}.com`;

        assert.equal(emailOf(254).length, 254);
        assert.equal(create({ email: emailOf(254), password: PASSWORD }).error, undefined);
        assert.equal(create({ email: `  ${emailOf(254)}  `, password: PASSWORD }).error, undefined);
        assert.deepEqual(refusedFields(create({ email: emailOf(255), password: PASSWORD })), ["email"]);
        assert.deepEqual(refusedFields(create({ email: `  ${emailOf(255)}  `, password: PASSWORD })), ["email"]);
    });

    it("rejects an invalid, empty, missing or non-string email", () => {
        for (const email of ["not-an-email", "", undefined, ["a@example.com"], { $gt: "" }, 7]) {
            assert.deepEqual(refusedFields(create({ email, password: PASSWORD })), ["email"], JSON.stringify(email));
        }
    });

    it("takes a password of 8 to 64 characters: 7 and 65 are refused, 8 and 64 are accepted", () => {
        assert.deepEqual(refusedFields(create({ email: EMAIL, password: "x".repeat(7) })), ["password"]);
        assert.equal(create({ email: EMAIL, password: "x".repeat(8) }).error, undefined);
        assert.equal(create({ email: EMAIL, password: "x".repeat(64) }).error, undefined);
        assert.deepEqual(refusedFields(create({ email: EMAIL, password: "x".repeat(65) })), ["password"]);
    });

    it("rejects an empty, missing or non-string password", () => {
        for (const password of ["", undefined, [PASSWORD], { $ne: "" }, 12345678]) {
            assert.deepEqual(refusedFields(create({ email: EMAIL, password })), ["password"], JSON.stringify(password));
        }
    });

    // spaces are characters of the password, so they count towards the minimum and are kept
    it("never trims the password", () => {
        const padded = create({ email: EMAIL, password: "  1234  " });

        assert.equal(padded.error, undefined, "eight characters with the spaces");
        assert.equal(padded.value.password, "  1234  ");
        assert.deepEqual(refusedFields(create({ email: EMAIL, password: "      " })), ["password"], "six spaces are still six characters");
    });

    it("accepts only user and admin as the role, exactly as written", () => {
        for (const role of ["superadmin", "root", "ADMIN", "Admin", " admin", "", null, 1, ["admin"]]) {
            assert.deepEqual(refusedFields(create({ email: EMAIL, password: PASSWORD, role })), ["role"], JSON.stringify(role));
        }
    });

    it("rejects keys it does not know: status, id, token version, hash", () => {
        for (const extra of [{ status: "disabled" }, { id: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c" }, { tokenVersion: 3 }, { passwordHash: "x" }, { createdAt: "2026-01-01" }]) {
            assert.deepEqual(refusedFields(create({ email: EMAIL, password: PASSWORD, ...extra })), [Object.keys(extra)[0]], JSON.stringify(extra));
        }
    });
});

describe("the update user schema", () => {
    const update = (body: object): ValidationResult => validate(updateUserSchema, body);

    it("accepts a role, a status, or both", () => {
        assert.equal(update({ role: "admin" }).error, undefined);
        assert.equal(update({ role: "user" }).error, undefined);
        assert.equal(update({ status: "disabled" }).error, undefined);
        assert.equal(update({ status: "active" }).error, undefined);
        assert.equal(update({ role: "admin", status: "active" }).error, undefined);
    });

    it("needs at least one field", () => {
        const result = update({});

        assert.notEqual(result.error, undefined);
        assert.deepEqual(refusedFields(result), [""], "the body as a whole is refused, not a field");
    });

    it("rejects any other role or status", () => {
        for (const role of ["superadmin", "ADMIN", "", null, 1]) {
            assert.deepEqual(refusedFields(update({ role })), ["role"], JSON.stringify(role));
        }

        for (const status of ["banned", "ACTIVE", "inactive", "", null, true]) {
            assert.deepEqual(refusedFields(update({ status })), ["status"], JSON.stringify(status));
        }
    });

    it("rejects the email and the password: an admin changes the role and the status, nothing else", () => {
        assert.deepEqual(refusedFields(update({ email: EMAIL })), ["email"]);
        assert.deepEqual(refusedFields(update({ password: PASSWORD })), ["password"]);
        assert.deepEqual(refusedFields(update({ role: "admin", email: EMAIL })), ["email"]);
    });

    it("rejects keys it does not know", () => {
        for (const extra of [{ tokenVersion: 0 }, { id: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c" }, { passwordHash: "x" }]) {
            assert.deepEqual(refusedFields(update({ role: "user", ...extra })), [Object.keys(extra)[0]], JSON.stringify(extra));
        }
    });
});

describe("the change password schema", () => {
    const change = (body: object): ValidationResult => validate(changePasswordSchema, body);

    it("accepts the current password and a new one", () => {
        assert.equal(change({ currentPassword: "old", newPassword: PASSWORD }).error, undefined);
    });

    it("needs both fields", () => {
        assert.deepEqual(refusedFields(change({ newPassword: PASSWORD })), ["currentPassword"]);
        assert.deepEqual(refusedFields(change({ currentPassword: "old" })), ["newPassword"]);
        assert.deepEqual(refusedFields(change({})).sort(), ["currentPassword", "newPassword"]);
    });

    it("takes a new password of 8 to 64 characters", () => {
        assert.deepEqual(refusedFields(change({ currentPassword: "old", newPassword: "x".repeat(7) })), ["newPassword"]);
        assert.equal(change({ currentPassword: "old", newPassword: "x".repeat(8) }).error, undefined);
        assert.equal(change({ currentPassword: "old", newPassword: "x".repeat(64) }).error, undefined);
        assert.deepEqual(refusedFields(change({ currentPassword: "old", newPassword: "x".repeat(65) })), ["newPassword"]);
    });

    // an account made before a rule changed may have a password the rule would not allow today: it must still be
    // able to type it to change it
    it("has no minimum for the current password, and a maximum of 64", () => {
        assert.equal(change({ currentPassword: "x", newPassword: PASSWORD }).error, undefined);
        assert.equal(change({ currentPassword: "x".repeat(64), newPassword: PASSWORD }).error, undefined);
        assert.deepEqual(refusedFields(change({ currentPassword: "x".repeat(65), newPassword: PASSWORD })), ["currentPassword"]);
        assert.deepEqual(refusedFields(change({ currentPassword: "", newPassword: PASSWORD })), ["currentPassword"]);
    });

    it("never trims either password", () => {
        const result = change({ currentPassword: " old ", newPassword: "  12 34  " });

        assert.equal(result.error, undefined);
        assert.equal(result.value.currentPassword, " old ");
        assert.equal(result.value.newPassword, "  12 34  ");
    });

    it("rejects passwords that are not strings", () => {
        assert.deepEqual(refusedFields(change({ currentPassword: ["old"], newPassword: PASSWORD })), ["currentPassword"]);
        assert.deepEqual(refusedFields(change({ currentPassword: "old", newPassword: { $ne: "" } })), ["newPassword"]);
    });

    it("rejects keys it does not know, so the role cannot ride along with a password change", () => {
        for (const extra of [{ role: "admin" }, { email: EMAIL }, { status: "active" }]) {
            assert.deepEqual(refusedFields(change({ currentPassword: "old", newPassword: PASSWORD, ...extra })), [Object.keys(extra)[0]], JSON.stringify(extra));
        }
    });
});
