import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Schema, ValidationResult } from "joi";
import { createProfileSchema, updateProfileSchema } from "../../src/v1/validators/profiles.validator.js";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (schema: Schema, body: unknown): ValidationResult => schema.validate(body, { abortEarly: false });

const messagesOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.message);

// the keys of the fields that were refused ("" for the body as a whole)
const refusedFields = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const INVISIBLE_NAME = "Name cannot contain control or invisible characters";

// Characters are built from numbers, never written in this file: the repository check refuses invisible ones in any file.
const withCharacter = (codePoint: number): string => `a${String.fromCodePoint(codePoint)}b`;

// the name rules are the same for creating and for updating, so each case runs against both
const forms: [string, (body: object) => ValidationResult][] = [
    ["create", (body) => validate(createProfileSchema, body)],
    ["update", (body) => validate(updateProfileSchema, body)]
];

describe("the create profile schema", () => {
    const create = (body: unknown): ValidationResult => validate(createProfileSchema, body);

    it("needs a name", () => {
        assert.deepEqual(refusedFields(create({})), ["name"]);
        assert.deepEqual(refusedFields(create({ settings: { topK: 5 } })), ["name"]);
        assert.deepEqual(refusedFields(create({ name: undefined })), ["name"]);
        assert.equal(create({ name: "Precise" }).error, undefined);
    });

    it("takes settings, which are optional, and an empty settings object is valid", () => {
        assert.equal(create({ name: "Precise" }).error, undefined);
        assert.equal(create({ name: "Precise", settings: {} }).error, undefined);
        assert.equal(create({ name: "Precise", settings: { topK: 5, temperature: 0.5, answerLanguage: "es" } }).error, undefined);
        assert.deepEqual(create({ name: "Precise", settings: { topK: 5 } }).value, { name: "Precise", settings: { topK: 5 } });
    });

    it("checks the settings with the settings schema: a value past its cap, a number as text, an unknown key, a list", () => {
        const past = create({ name: "Precise", settings: { topK: 31 } });
        assert.deepEqual(refusedFields(past), ["settings.topK"]);
        assert.match(messagesOf(past)[0], /^Top K.*at most/);

        assert.deepEqual(refusedFields(create({ name: "Precise", settings: { topK: "3" } })), ["settings.topK"]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: { foo: 1 } })), ["Unknown setting: foo"]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: [] })), ["Settings must be an object"]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: null })), ["Settings must be an object"]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: "topK" })), ["Settings must be an object"]);
    });

    it("refuses __proto__ as a setting, and Object.prototype gains nothing", () => {
        const body = JSON.parse("{\"name\": \"Precise\", \"settings\": {\"__proto__\": {\"polluted\": true}}}") as unknown;

        assert.deepEqual(messagesOf(create(body)), ["Unknown setting: __proto__"]);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });

    // the fields the server decides: who owns a profile, its identity, its version and its dates
    it("refuses the fields a client must not set: userId, user_id, id, isDefault, version, createdAt, updatedAt", () => {
        for (const field of ["userId", "user_id", "id", "isDefault", "version", "createdAt", "updatedAt"]) {
            const result = create({ name: "Precise", [field]: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c" });

            assert.deepEqual(messagesOf(result), [`"${field}" is not allowed`], field);
            assert.deepEqual(refusedFields(result), [field], field);
        }
    });
});

describe("the update profile schema", () => {
    const update = (body: unknown): ValidationResult => validate(updateProfileSchema, body);

    it("needs at least one field", () => {
        const result = update({});

        assert.notEqual(result.error, undefined);
        assert.deepEqual(refusedFields(result), [""], "the body as a whole is refused, not a field");
    });

    it("accepts a name, settings, or both", () => {
        assert.equal(update({ name: "Renamed" }).error, undefined);
        assert.equal(update({ settings: { topK: 5 } }).error, undefined);
        assert.equal(update({ settings: {} }).error, undefined, "an empty settings object replaces the settings with nothing");
        assert.equal(update({ name: "Renamed", settings: { topK: 5 } }).error, undefined);
        assert.deepEqual(update({ settings: {} }).value, { settings: {} });
    });

    it("checks the settings with the settings schema", () => {
        assert.deepEqual(refusedFields(update({ settings: { topK: 31 } })), ["settings.topK"]);
        assert.deepEqual(refusedFields(update({ settings: { minScore: 0.305 } })), ["settings.minScore"]);
        assert.deepEqual(messagesOf(update({ settings: { foo: 1 } })), ["Unknown setting: foo"]);
        assert.deepEqual(messagesOf(update({ settings: [] })), ["Settings must be an object"]);
        assert.deepEqual(messagesOf(update({ settings: JSON.parse("{\"__proto__\": {\"polluted\": true}}") as unknown })), ["Unknown setting: __proto__"]);
    });

    it("refuses the fields a client must not change: userId, user_id, id, isDefault, version, createdAt, updatedAt", () => {
        for (const field of ["userId", "user_id", "id", "isDefault", "version", "createdAt", "updatedAt"]) {
            const alone = update({ [field]: 2 });

            assert.deepEqual(messagesOf(alone), [`"${field}" is not allowed`], `${field} alone`);

            const withName = update({ name: "Renamed", [field]: 2 });

            assert.deepEqual(messagesOf(withName), [`"${field}" is not allowed`], `${field} with a name`);
            assert.deepEqual(refusedFields(withName), [field], field);
        }
    });
});

for (const [form, run] of forms) {
    describe(`the name of a profile, in the ${form} schema`, () => {
        it("is given back in Unicode form NFC and trimmed", () => {
            const result = run({ name: `  Cafe${String.fromCodePoint(0x301)} bar  ` });

            assert.equal(result.error, undefined);
            assert.equal(result.value.name, `Caf${String.fromCodePoint(0xe9)} bar`);
        });

        it("keeps the spaces and the capitalization inside the name", () => {
            const result = run({ name: " Two  Words " });

            assert.equal(result.value.name, "Two  Words");
        });

        it("takes 1 to 100 characters: 1 and 100 are accepted, empty, blank and 101 are refused", () => {
            assert.equal(run({ name: "a" }).error, undefined);
            assert.equal(run({ name: "a".repeat(100) }).error, undefined);
            assert.equal(run({ name: ` ${"a".repeat(100)} ` }).error, undefined, "the spaces around it do not count");

            for (const name of ["", "   ", "a".repeat(101), ` ${"a".repeat(101)} `]) {
                assert.deepEqual(refusedFields(run({ name })), ["name"], JSON.stringify(name).slice(0, 30));
            }
        });

        it("refuses a name that is not text", () => {
            for (const name of [5, true, null, ["Precise"], { name: "Precise" }]) {
                assert.deepEqual(refusedFields(run({ name })), ["name"], JSON.stringify(name));
            }
        });

        it("refuses control, invisible, format and separator characters: NUL, tab, newline, U+200B, U+202E, U+FEFF, U+00AD, U+2028, a tag character and a lone surrogate", () => {
            for (const codePoint of [0x0000, 0x0009, 0x000a, 0x200b, 0x202e, 0xfeff, 0x00ad, 0x2028, 0xe0041, 0xd800]) {
                const result = run({ name: withCharacter(codePoint) });

                assert.deepEqual(messagesOf(result), [INVISIBLE_NAME], `U+${codePoint.toString(16).toUpperCase()}`);
                assert.deepEqual(refusedFields(result), ["name"]);
            }
        });

        it("refuses one of those characters at the start or the end, when trimming does not remove it", () => {
            for (const codePoint of [0x200b, 0x202e, 0x00ad, 0xe0041, 0x0000]) {
                for (const name of [`${String.fromCodePoint(codePoint)}Precise`, `Precise${String.fromCodePoint(codePoint)}`]) {
                    assert.deepEqual(messagesOf(run({ name })), [INVISIBLE_NAME], `U+${codePoint.toString(16).toUpperCase()}`);
                }
            }
        });

        it("accepts accents, other scripts, punctuation and emoji, also an emoji with a variation selector", () => {
            const names = [
                `Caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0xf1)}`,
                "Precisa (v2) - rápida",
                String.fromCodePoint(0x6a21, 0x578b),
                `Heart ${String.fromCodePoint(0x2764, 0xfe0f)}`,
                `Thumbs ${String.fromCodePoint(0x1f44d)}`
            ];

            for (const name of names) {
                const result = run({ name });

                assert.equal(result.error, undefined, name);
                assert.equal(result.value.name, name.normalize("NFC"));
            }
        });
    });
}
