import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Schema, ValidationResult } from "joi";
import { createProfileSchema, updateProfileSchema } from "../../src/v1/validators/profiles.validator.js";
import { ELLIPSIS, LONG_KEY, LONG_KEY_DETAIL, PROTO_WITH_OTHER_ERRORS, assertDetails } from "../configurationFixtures.js";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (schema: Schema, body: unknown): ValidationResult => schema.validate(body, { abortEarly: false });

const messagesOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.message);

// the keys of the fields that were refused ("" for the body as a whole)
const refusedFields = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const INVISIBLE_NAME = "Name cannot contain control or invisible characters";
const NO_LETTER = "Name must contain a letter, number, symbol or punctuation";

// Characters that draw nothing (or look like a blank) but are not format characters, so the category check did not
// catch them: the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0, the combining grapheme joiner U+034F and the
// braille blank U+2800.
const BLANK_LOOKING = [0x3164, 0x115f, 0x1160, 0xffa0, 0x034f, 0x2800];

const hex = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

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
    it("reports __proto__ in the settings together with a value past its cap and an unknown key, all three", () => {
        const body = { name: "Precise", settings: JSON.parse(PROTO_WITH_OTHER_ERRORS) as unknown };
        const messages = messagesOf(create(body));

        assert.equal(messages.length, 3, JSON.stringify(messages));
        assert.ok(messages.includes("Unknown setting: __proto__"));
        assert.ok(messages.includes("Unknown setting: foo"));
        assert.ok(messages.some((message) => /^Top K.*at most 30/.test(message)));
    });

    it("echoes an unknown setting of 15,000 characters cut to 64 and an ellipsis, and one of 64 whole", () => {
        assertDetails(messagesOf(create({ name: "Precise", settings: { [LONG_KEY]: 1 } })), [LONG_KEY_DETAIL]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: { ["k".repeat(65)]: 1 } })), [`Unknown setting: ${"k".repeat(64)}${ELLIPSIS}`]);
        assert.deepEqual(messagesOf(create({ name: "Precise", settings: { ["k".repeat(64)]: 1 } })), [`Unknown setting: ${"k".repeat(64)}`]);
    });

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

    it("reports __proto__ in the settings together with a value past its cap and an unknown key, all three", () => {
        const messages = messagesOf(update({ settings: JSON.parse(PROTO_WITH_OTHER_ERRORS) as unknown }));

        assert.equal(messages.length, 3, JSON.stringify(messages));
        assert.ok(messages.includes("Unknown setting: __proto__"));
        assert.ok(messages.includes("Unknown setting: foo"));
        assert.ok(messages.some((message) => /^Top K.*at most 30/.test(message)));
    });

    it("echoes an unknown setting of 15,000 characters cut to 64 and an ellipsis", () => {
        assertDetails(messagesOf(update({ settings: { [LONG_KEY]: 1 } })), [LONG_KEY_DETAIL]);
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

        it("refuses the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0, the combining grapheme joiner U+034F and the braille blank U+2800 inside a name", () => {
            for (const codePoint of BLANK_LOOKING) {
                const result = run({ name: withCharacter(codePoint) });

                assert.deepEqual(messagesOf(result), [INVISIBLE_NAME], hex(codePoint));
                assert.deepEqual(refusedFields(result), ["name"], hex(codePoint));
            }
        });

        it("refuses each of those blank-looking characters alone, and at the start or the end of a name", () => {
            for (const codePoint of BLANK_LOOKING) {
                const character = String.fromCodePoint(codePoint);
                const alone = run({ name: character });

                assert.ok(messagesOf(alone).includes(INVISIBLE_NAME), `${hex(codePoint)} alone: ${JSON.stringify(messagesOf(alone))}`);
                assert.ok(refusedFields(alone).every((field) => field === "name"), hex(codePoint));

                for (const name of [`${character}Precise`, `Precise${character}`]) {
                    assert.deepEqual(messagesOf(run({ name })), [INVISIBLE_NAME], `${hex(codePoint)} at an end`);
                }
            }
        });

        it("refuses a name made only of marks, with 'Name must contain a letter, number, symbol or punctuation'", () => {
            const names = [
                String.fromCodePoint(0x301),
                String.fromCodePoint(0x301, 0x302),
                ` ${String.fromCodePoint(0x301)} `,
                `${String.fromCodePoint(0x301)}${String.fromCodePoint(0x2003)}${String.fromCodePoint(0x301)}`
            ];

            for (const name of names) {
                const result = run({ name });

                assert.deepEqual(messagesOf(result), [NO_LETTER], JSON.stringify(name));
                assert.deepEqual(refusedFields(result), ["name"]);
            }
        });

        it("keeps refusing a blank name with 'Name cannot be empty': spaces alone, of any kind, are trimmed to nothing", () => {
            for (const name of ["", "   ", String.fromCodePoint(0xa0), String.fromCodePoint(0x2003, 0x3000)]) {
                assert.deepEqual(messagesOf(run({ name })), ["Name cannot be empty"], JSON.stringify(name));
            }
        });

        it("accepts a name that has a letter, a number, a symbol or punctuation, with or without marks: a mark does not make it refused", () => {
            const names = [
                "2024",
                "---",
                "(v2)",
                String.fromCodePoint(0x1f44d),
                String.fromCodePoint(0x2764, 0xfe0f),
                String.fromCodePoint(0x6a21),
                `e${String.fromCodePoint(0x301)}`,
                `${String.fromCodePoint(0x301)}a`
            ];

            for (const name of names) {
                const result = run({ name });

                assert.equal(result.error, undefined, `${JSON.stringify(name)}: ${JSON.stringify(messagesOf(result))}`);
            }
        });

        it("stores a space of category Zs inside the name as a plain space: no-break space, em space and ideographic space", () => {
            for (const codePoint of [0xa0, 0x2003, 0x3000]) {
                const result = run({ name: `a${String.fromCodePoint(codePoint)}b` });

                assert.equal(result.error, undefined, hex(codePoint));
                assert.equal(result.value.name, "a b", hex(codePoint));
            }
        });

        it("turns each of those spaces into one plain space, without collapsing a run of them, and trims them at the ends", () => {
            assert.equal(run({ name: `a${String.fromCodePoint(0xa0, 0x2003)}b` }).value.name, "a  b");
            assert.equal(run({ name: `${String.fromCodePoint(0xa0)}Precise${String.fromCodePoint(0x3000)}` }).value.name, "Precise");
        });

        it("keeps refusing a joined emoji sequence, because the zero-width joiner is a format character (the cost of refusing all of them)", () => {
            const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
            const result = run({ name: family });

            assert.deepEqual(messagesOf(result), [INVISIBLE_NAME]);
            assert.deepEqual(refusedFields(result), ["name"]);
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
