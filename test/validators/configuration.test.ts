import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Schema, ValidationResult } from "joi";
import { completeSettingsSchema, resolveConfigurationSchema, settingsSchema } from "../../src/v1/validators/configuration.validator.js";
import { DEFAULT_SETTINGS, LABELS, SETTING_KEYS } from "../configurationFixtures.js";

// validated the way validateBodyMiddleware does it: every problem is collected, not only the first
const validate = (schema: Schema, body: unknown): ValidationResult => schema.validate(body, { abortEarly: false });

const messagesOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.message);

const pathsOf = (result: ValidationResult): string[] => (result.error?.details ?? []).map((detail) => detail.path.join("."));

const settings = (body: unknown): ValidationResult => validate(settingsSchema, body);

// One setting alone, refused: exactly one message, and it names the setting by its label.
const refusedWith = (key: string, value: unknown, sense: RegExp): void => {
    const result = settings({ [key]: value });
    const messages = messagesOf(result);

    assert.equal(messages.length, 1, `${key} = ${JSON.stringify(value)?.slice(0, 40)} gives one message: ${JSON.stringify(messages).slice(0, 300)}`);
    assert.ok(messages[0].startsWith(LABELS[key]), `${key}: the message names "${LABELS[key]}": ${messages[0].slice(0, 100)}`);
    assert.match(messages[0], sense, `${key} = ${JSON.stringify(value)?.slice(0, 40)}`);
    assert.ok(messages[0].length < 300, "the message does not echo a long value back");
};

const AT_LEAST = /must be at least/;
const AT_MOST = /must be at most/;
const ONE_OF = /must be one of/;

describe("the settings schema: values at the edge of their cap", () => {
    const accepted: Record<string, unknown[]> = {
        chunkSize: [300, 500, 750, 1000, 2000, 5000],
        embeddingModel: ["qwen3-embedding:0.6b"],
        retrievalMode: ["vector"],
        topK: [1, 2, 29, 30],
        minScore: [0, 0.01, 0.3, 0.99, 1],
        neighborWindow: [1, 2],
        smallModel: ["qwen3.5:4b"],
        temperature: [0, 0.25, 0.5, 0.99, 1],
        maxTokens: [1, 2, 1023, 1024],
        answerLanguage: ["en", "es"],
        answerMode: ["baseline", "structured"]
    };

    it("covers every one of the eleven settings", () => {
        assert.deepEqual(Object.keys(accepted), SETTING_KEYS);
    });

    for (const [key, values] of Object.entries(accepted)) {
        it(`accepts ${key} at ${values.map((value) => JSON.stringify(value)).join(", ")}, returned unchanged`, () => {
            for (const value of values) {
                const result = settings({ [key]: value });

                assert.equal(result.error, undefined, `${key} = ${JSON.stringify(value)}: ${JSON.stringify(messagesOf(result))}`);
                assert.deepEqual(result.value, { [key]: value });
            }
        });
    }

    it("accepts a body with no setting at all, and one with every setting", () => {
        assert.equal(settings({}).error, undefined);
        assert.deepEqual(settings({}).value, {});

        const everything = settings({ ...DEFAULT_SETTINGS });
        assert.equal(everything.error, undefined);
        assert.deepEqual(everything.value, DEFAULT_SETTINGS);
    });
});

describe("the settings schema: values just past their cap", () => {
    it("refuses a number below the minimum, with one message that names the setting", () => {
        refusedWith("topK", 0, AT_LEAST);
        refusedWith("minScore", -0.01, AT_LEAST);
        refusedWith("temperature", -0.01, AT_LEAST);
        refusedWith("maxTokens", 0, AT_LEAST);
    });

    it("refuses a number above the maximum, with one message that names the setting", () => {
        refusedWith("topK", 31, AT_MOST);
        refusedWith("minScore", 1.01, AT_MOST);
        refusedWith("temperature", 1.01, AT_MOST);
        refusedWith("maxTokens", 1025, AT_MOST);
    });

    it("refuses a number that is not one of the allowed ones", () => {
        refusedWith("neighborWindow", 0, ONE_OF);
        refusedWith("neighborWindow", 3, ONE_OF);
        refusedWith("chunkSize", 999, ONE_OF);
        refusedWith("chunkSize", 1001, ONE_OF);
        refusedWith("chunkSize", 5001, ONE_OF);
        refusedWith("chunkSize", 299, ONE_OF);
    });

    it("refuses a model or a mode that is not the allowed one, exactly as written", () => {
        refusedWith("smallModel", "gpt-oss:20b", ONE_OF);
        refusedWith("smallModel", "QWEN3.5:4B", ONE_OF);
        refusedWith("smallModel", "qwen3.5:4b ", ONE_OF);
        refusedWith("smallModel", " qwen3.5:4b", ONE_OF);
        refusedWith("embeddingModel", "qwen3-embedding:8b", ONE_OF);
        refusedWith("embeddingModel", "qwen3-embedding:0.6b ", ONE_OF);
        refusedWith("embeddingModel", "QWEN3-EMBEDDING:0.6B", ONE_OF);
        refusedWith("retrievalMode", "hybrid", ONE_OF);
        refusedWith("retrievalMode", "vector_query_instruction", ONE_OF);
        refusedWith("retrievalMode", "Vector", ONE_OF);
        refusedWith("answerLanguage", "EN", ONE_OF);
        refusedWith("answerLanguage", "fr", ONE_OF);
        refusedWith("answerLanguage", "en ", ONE_OF);
        refusedWith("answerMode", "Baseline", ONE_OF);
        refusedWith("answerMode", "free", ONE_OF);
    });

    it("refuses a value far past the cap: a huge or a very negative number, a 10,000-character text, a path as a model", () => {
        const long = "x".repeat(10_000);

        for (const key of ["topK", "minScore", "temperature", "maxTokens"]) {
            refusedWith(key, 1e9, AT_MOST);
            refusedWith(key, -1e9, AT_LEAST);
        }

        for (const key of ["chunkSize", "neighborWindow"]) {
            refusedWith(key, 1e9, ONE_OF);
            refusedWith(key, -1e9, ONE_OF);
        }

        for (const key of SETTING_KEYS) {
            const result = settings({ [key]: long });

            assert.equal(messagesOf(result).length, 1, key);
            assert.ok(messagesOf(result)[0].length < 300, `${key}: the 10,000 characters are not echoed back`);
        }

        for (const key of ["embeddingModel", "smallModel"]) {
            refusedWith(key, "../../api/pull", ONE_OF);
            refusedWith(key, "http://evil.example/model", ONE_OF);
        }
    });

    it("refuses a value with more than two decimals instead of rounding it", () => {
        refusedWith("minScore", 0.305, /at most 2 decimal places/);
        refusedWith("temperature", 0.305, /at most 2 decimal places/);
        refusedWith("minScore", 0.001, /at most 2 decimal places/);
        refusedWith("temperature", 0.999, /at most 2 decimal places/);
    });

    it("refuses a fraction where a whole number is needed", () => {
        refusedWith("topK", 3.5, /must be a whole number/);
        refusedWith("maxTokens", 100.5, /must be a whole number/);
    });

    it("refuses Infinity, which is what the text 1e400 becomes when a body is parsed, and an unsafe integer", () => {
        const parsed = JSON.parse("{\"minScore\": 1e400, \"temperature\": -1e400, \"topK\": 1e400, \"maxTokens\": 9007199254740993}") as Record<string, number>;

        assert.equal(parsed.minScore, Number.POSITIVE_INFINITY, "the parsed body does hold an infinity");

        const result = settings(parsed);

        assert.equal(messagesOf(result).length, 4, JSON.stringify(messagesOf(result)));

        for (const key of ["minScore", "temperature", "topK", "maxTokens"]) {
            assert.equal(messagesOf(settings({ [key]: parsed[key] })).length, 1, key);
            assert.match(messagesOf(settings({ [key]: parsed[key] }))[0], /is out of range/, key);
            assert.ok(messagesOf(settings({ [key]: parsed[key] }))[0].startsWith(LABELS[key]), key);
        }

        assert.match(messagesOf(settings({ topK: Number.MAX_SAFE_INTEGER + 2 }))[0], /is out of range/);
        assert.match(messagesOf(settings({ topK: Number.NaN }))[0] ?? "", /Top K/, "NaN is refused too");
    });
});

describe("the settings schema: values of the wrong type", () => {
    const wrongTypes = (key: string): unknown[] => {
        const valid = DEFAULT_SETTINGS[key];
        const wrong: unknown[] = [true, false, null, [valid], [], { value: valid }, {}];

        // a number written as text is the case that matters for the numeric settings: Joi would convert it
        // unless it is told not to
        if (typeof valid === "number") {
            wrong.push(String(valid), ` ${valid}`, `${valid} `, "0x10", "1e3", "");
        } else {
            wrong.push(5, 0);
        }

        return wrong;
    };

    for (const key of SETTING_KEYS) {
        it(`refuses ${key} as text, a boolean, null, a list or an object, with one message that names it`, () => {
            for (const value of wrongTypes(key)) {
                const result = settings({ [key]: value });
                const messages = messagesOf(result);

                assert.equal(messages.length, 1, `${key} = ${JSON.stringify(value)}: ${JSON.stringify(messages)}`);
                assert.ok(messages[0].startsWith(LABELS[key]), `${key} = ${JSON.stringify(value)}: ${messages[0]}`);
                assert.deepEqual(pathsOf(result), [key]);
            }
        });
    }

    it("says 'must be a number' for a number written as text, where the setting is a range and not a list", () => {
        for (const key of ["topK", "minScore", "temperature", "maxTokens"]) {
            refusedWith(key, String(DEFAULT_SETTINGS[key]), /must be a number/);
            refusedWith(key, true, /must be a number/);
            refusedWith(key, null, /must be a number/);
        }
    });

    it("does not convert text to a number, and does not change the body it was given", () => {
        const body = { topK: "3", temperature: "0.5" };

        assert.notEqual(settings(body).error, undefined);
        assert.deepEqual(body, { topK: "3", temperature: "0.5" });
    });
});

describe("the settings schema: keys it does not know", () => {
    it("refuses each unknown key with 'Unknown setting: <key>', one detail each", () => {
        const result = settings({ topk: 3, foo: 1, answer_language: "en", TopK: 3 });

        assert.deepEqual(messagesOf(result).sort(), [
            "Unknown setting: TopK",
            "Unknown setting: answer_language",
            "Unknown setting: foo",
            "Unknown setting: topk"
        ]);
        assert.deepEqual(pathsOf(result).sort(), ["TopK", "answer_language", "foo", "topk"]);
    });

    it("refuses an unknown key next to valid settings, and says nothing about the valid ones", () => {
        const result = settings({ topK: 5, temperature: 0.5, foo: true });

        assert.deepEqual(messagesOf(result), ["Unknown setting: foo"]);
    });

    it("refuses the settings that are not settings of this version: num_ctx, seed, think, prompts, dimensions", () => {
        for (const key of ["num_ctx", "numCtx", "seed", "think", "prompt", "systemPrompt", "dimensions", "embeddingDimensions"]) {
            assert.deepEqual(messagesOf(settings({ [key]: 1 })), [`Unknown setting: ${key}`], key);
        }
    });

    // JSON.parse makes "__proto__" an own key, unlike an object literal
    it("refuses __proto__, constructor and prototype as keys, and Object.prototype gains nothing", () => {
        const bodies = [
            "{\"__proto__\": {\"polluted\": true}}",
            "{\"constructor\": {\"prototype\": {\"polluted\": true}}}",
            "{\"prototype\": {\"polluted\": true}}"
        ];
        const names = ["__proto__", "constructor", "prototype"];

        bodies.forEach((text, index) => {
            const body = JSON.parse(text) as unknown;

            assert.ok(Object.hasOwn(body as object, names[index]), `${names[index]} is an own key of the parsed body`);
            assert.deepEqual(messagesOf(settings(body)), [`Unknown setting: ${names[index]}`], names[index]);
        });

        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
        assert.deepEqual(Object.keys(Object.prototype), []);
    });

    it("refuses __proto__ next to the eleven valid settings, in the complete schema too", () => {
        const body = JSON.parse(`{${SETTING_KEYS.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(DEFAULT_SETTINGS[key])}`).join(",")}, "__proto__": {"polluted": true}}`) as unknown;

        assert.deepEqual(messagesOf(validate(completeSettingsSchema, body)), ["Unknown setting: __proto__"]);
        assert.deepEqual(messagesOf(settings(body)), ["Unknown setting: __proto__"]);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });
});

describe("the settings schema: settings that are not an object", () => {
    it("refuses a list, a string, a number, a boolean and null with 'Settings must be an object'", () => {
        for (const body of [[], [{ topK: 3 }], "topK", "", 5, true, null]) {
            assert.deepEqual(messagesOf(settings(body)), ["Settings must be an object"], JSON.stringify(body));
            assert.deepEqual(messagesOf(validate(completeSettingsSchema, body)), ["Settings must be an object"], `complete ${JSON.stringify(body)}`);
        }
    });
});

describe("the complete settings schema", () => {
    const complete = (body: unknown): ValidationResult => validate(completeSettingsSchema, body);

    it("accepts the eleven settings, returned unchanged", () => {
        const result = complete({ ...DEFAULT_SETTINGS });

        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, DEFAULT_SETTINGS);
    });

    it("refuses a body that misses a setting, one message that names it, whichever it is", () => {
        for (const key of SETTING_KEYS) {
            const body = { ...DEFAULT_SETTINGS };
            delete body[key];

            const result = complete(body);

            assert.equal(messagesOf(result).length, 1, `${key}: ${JSON.stringify(messagesOf(result))}`);
            assert.ok(messagesOf(result)[0].includes(LABELS[key]) || messagesOf(result)[0].includes(key), `${key}: ${messagesOf(result)[0]}`);
            assert.deepEqual(pathsOf(result), [key]);
        }
    });

    it("refuses an empty body with one message for each of the eleven settings", () => {
        const result = complete({});

        assert.equal(messagesOf(result).length, 11);
        assert.deepEqual(pathsOf(result).sort(), [...SETTING_KEYS].sort());
    });

    it("reports every problem at once: a setting past its cap, a missing one and an unknown one", () => {
        const body = { ...DEFAULT_SETTINGS, topK: 31, foo: 1 } as Record<string, unknown>;
        delete body.temperature;

        const messages = messagesOf(complete(body));

        assert.equal(messages.length, 3, JSON.stringify(messages));
        assert.ok(messages.includes("Unknown setting: foo"));
        assert.ok(messages.some((message) => message.startsWith("Top K") && AT_MOST.test(message)));
        assert.ok(messages.some((message) => message.includes("Temperature") || message.includes("temperature")));
    });

    it("applies the same caps as the partial schema", () => {
        assert.match(messagesOf(complete({ ...DEFAULT_SETTINGS, topK: 31 }))[0], AT_MOST);
        assert.match(messagesOf(complete({ ...DEFAULT_SETTINGS, minScore: 0.305 }))[0], /at most 2 decimal places/);
        assert.match(messagesOf(complete({ ...DEFAULT_SETTINGS, smallModel: "gpt-oss:20b" }))[0], ONE_OF);
        assert.match(messagesOf(complete({ ...DEFAULT_SETTINGS, topK: "3" }))[0], /must be a number/);
    });
});

describe("the body of the resolver", () => {
    const resolve = (body: unknown): ValidationResult => validate(resolveConfigurationSchema, body);
    const UUID = "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c";

    it("takes a profileId and overrides, both optional", () => {
        assert.equal(resolve({}).error, undefined);
        assert.equal(resolve({ profileId: UUID }).error, undefined);
        assert.equal(resolve({ overrides: { topK: 5 } }).error, undefined);
        assert.equal(resolve({ profileId: UUID, overrides: { topK: 5, answerLanguage: "es" } }).error, undefined);
        assert.equal(resolve({ overrides: {} }).error, undefined);
        assert.deepEqual(resolve({ profileId: UUID, overrides: { topK: 5 } }).value, { profileId: UUID, overrides: { topK: 5 } });
    });

    it("refuses a profileId that is not a UUID, with 'Profile id must be a valid UUID'", () => {
        for (const profileId of ["not-a-uuid", " ", `${UUID}x`, "3f2b8c1e9a4d4e7fb2c18d5e6f7a9b0c0"]) {
            const result = resolve({ profileId });

            assert.deepEqual(messagesOf(result), ["Profile id must be a valid UUID"], JSON.stringify(profileId));
            assert.deepEqual(pathsOf(result), ["profileId"]);
        }
    });

    it("refuses a profileId that is empty or not text", () => {
        for (const profileId of ["", 5, true, ["a"], { id: UUID }]) {
            assert.deepEqual(pathsOf(resolve({ profileId })), ["profileId"], JSON.stringify(profileId));
        }
    });

    it("checks the overrides with the settings schema: a value past its cap, an unknown key and a number as text", () => {
        const past = resolve({ overrides: { topK: 31 } });
        assert.deepEqual(pathsOf(past), ["overrides.topK"]);
        assert.match(messagesOf(past)[0], /^Top K.*at most/);

        assert.deepEqual(messagesOf(resolve({ overrides: { foo: 1 } })), ["Unknown setting: foo"]);
        assert.deepEqual(pathsOf(resolve({ overrides: { topK: "3" } })), ["overrides.topK"]);
        assert.deepEqual(messagesOf(resolve({ overrides: [] })), ["Settings must be an object"]);
        assert.deepEqual(messagesOf(resolve({ overrides: "topK" })), ["Settings must be an object"]);
        assert.deepEqual(messagesOf(resolve({ overrides: JSON.parse("{\"__proto__\": {\"polluted\": true}}") as unknown })), ["Unknown setting: __proto__"]);
        assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    });

    it("refuses fields it does not know, with Joi's own '\"<field>\" is not allowed'", () => {
        for (const field of ["userId", "settings", "version", "name", "isDefault"]) {
            const result = resolve({ [field]: 1 });

            assert.deepEqual(messagesOf(result), [`"${field}" is not allowed`], field);
        }
    });
});
