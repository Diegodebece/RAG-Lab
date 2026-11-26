import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getStartupConfigProblems, readIntegerSetting, readListSetting } from "../../src/v1/config/env.config.js";
import { SECRET_KEY_PLACEHOLDER } from "./placeholder.js";

describe("getStartupConfigProblems", () => {
    it("accepts a long random SECRET_KEY", () => {
        assert.deepEqual(getStartupConfigProblems({ SECRET_KEY: "a".repeat(32) }), []);
    });

    it("refuses to start without SECRET_KEY", () => {
        assert.deepEqual(getStartupConfigProblems({}), ["SECRET_KEY is not set"]);
        assert.deepEqual(getStartupConfigProblems({ SECRET_KEY: "" }), ["SECRET_KEY is not set"]);
    });

    it("refuses short secrets, including the old short placeholder", () => {
        for (const secret of ["change-me", "short", "a".repeat(31)]) {
            assert.deepEqual(
                getStartupConfigProblems({ SECRET_KEY: secret }),
                ["SECRET_KEY must be a random value of at least 32 characters"],
                secret
            );
        }
    });

    // The placeholder is longer than 32 characters, so the length rule lets it through: only a check for the
    // placeholder itself can refuse it.
    it("refuses the placeholder from .env.example, which is long enough for the length rule", () => {
        assert.ok(SECRET_KEY_PLACEHOLDER.length >= 32, "the placeholder must pass the length rule");

        const problems = getStartupConfigProblems({ SECRET_KEY: SECRET_KEY_PLACEHOLDER });

        assert.equal(problems.length, 1);
        assert.match(problems[0], /SECRET_KEY/);
    });
});

describe("getStartupConfigProblems: OLLAMA_BASE_URL", () => {
    const withUrl = (url: string): string[] => getStartupConfigProblems({ SECRET_KEY: "a".repeat(32), OLLAMA_BASE_URL: url });

    it("accepts the default, an absolute http or https URL, and a trailing slash", () => {
        assert.deepEqual(getStartupConfigProblems({ SECRET_KEY: "a".repeat(32) }), [], "not set");
        assert.deepEqual(withUrl(""), [], "empty means the default");

        for (const url of ["http://localhost:11434", "https://ollama.example.com", "http://host.docker.internal:11434/", "HTTP://LOCALHOST:11434"]) {
            assert.deepEqual(withUrl(url), [], url);
        }
    });

    it("refuses anything that is not an absolute http or https URL", () => {
        const values = ["localhost:11434", "11434", "ftp://ollama.example.com", "file:///etc/hosts", "javascript:alert(1)", "/api/tags", "//localhost:11434", "not a url", "http://"];

        for (const url of values) {
            const problems = withUrl(url);

            assert.equal(problems.length, 1, `${url}: ${JSON.stringify(problems)}`);
            assert.match(problems[0], /OLLAMA_BASE_URL/, url);
            assert.match(problems[0], /http/, `${url}: it says what is accepted`);
        }
    });
});

describe("readIntegerSetting and readListSetting", () => {
    const withSetting = <T>(value: string | undefined, read: () => T): T => {
        const previous = process.env.TEST_SETTING;
        if (value === undefined) {
            delete process.env.TEST_SETTING;
        } else {
            process.env.TEST_SETTING = value;
        }
        try {
            return read();
        } finally {
            if (previous === undefined) {
                delete process.env.TEST_SETTING;
            } else {
                process.env.TEST_SETTING = previous;
            }
        }
    };

    it("uses the default when the setting is missing or empty, and the value when it is valid", () => {
        assert.equal(withSetting(undefined, () => readIntegerSetting("TEST_SETTING", 7)), 7);
        assert.equal(withSetting("  ", () => readIntegerSetting("TEST_SETTING", 7)), 7);
        assert.equal(withSetting("42", () => readIntegerSetting("TEST_SETTING", 7)), 42);
        assert.equal(withSetting("0", () => readIntegerSetting("TEST_SETTING", 7, 0)), 0);
    });

    it("stops the app at startup on a value outside the range or that is not a whole number", () => {
        for (const value of ["abc", "1.5", "0", "-5", "1e3x"]) {
            assert.throws(() => withSetting(value, () => readIntegerSetting("TEST_SETTING", 7)), /TEST_SETTING must be a whole number at least 1/, value);
        }
        assert.throws(() => withSetting("70000", () => readIntegerSetting("TEST_SETTING", 3000, 1, 65535)), /from 1 to 65535/);
    });

    // Number() would read all of these as whole numbers, and each one is a typo or a trick in a setting file:
    // only plain decimal digits count.
    it("stops the app at startup on a number written in any way but plain decimal digits", () => {
        for (const value of ["0x10", "0b11", "0o7", "1e3", "1E3", " 5 ", "\t5", "5.0", "+5", "1_000", "Infinity"]) {
            assert.throws(() => withSetting(value, () => readIntegerSetting("TEST_SETTING", 7)), /TEST_SETTING must be a whole number at least 1/, JSON.stringify(value));
        }
    });

    it("accepts the edges of the range, and refuses one step beyond them", () => {
        assert.equal(withSetting("65535", () => readIntegerSetting("TEST_SETTING", 3000, 1, 65535)), 65535);
        assert.equal(withSetting("1", () => readIntegerSetting("TEST_SETTING", 3000, 1, 65535)), 1);
        assert.throws(() => withSetting("65536", () => readIntegerSetting("TEST_SETTING", 3000, 1, 65535)), /from 1 to 65535/);
        assert.throws(() => withSetting("0", () => readIntegerSetting("TEST_SETTING", 3000, 1, 65535)), /from 1 to 65535/);
    });

    it("reads a comma-separated list, trimming and dropping empty entries", () => {
        assert.deepEqual(withSetting(" a, b ,,c ", () => readListSetting("TEST_SETTING")), ["a", "b", "c"]);
        assert.deepEqual(withSetting(undefined, () => readListSetting("TEST_SETTING", ["loopback"])), ["loopback"]);
        assert.deepEqual(withSetting(" , ", () => readListSetting("TEST_SETTING", ["loopback"])), ["loopback"]);
    });
});
