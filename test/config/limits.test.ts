import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanChildEnvironment } from "../childEnvironment.js";

const execFileAsync = promisify(execFile);

// The limits are read when limits.config.ts loads, so each case loads it in a child process of its own with the
// setting under test. Nothing else is set: the other limits are the app's defaults.
const ROOT = path.join(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "printLimits.ts");

let emptyEnvDirectory = "";
let emptyEnvFile = "";

before(async () => {
    // an empty .env, so the child process does not read the real one
    emptyEnvDirectory = await mkdtemp(path.join(tmpdir(), "rag-lab-limits-"));
    emptyEnvFile = path.join(emptyEnvDirectory, ".env");
    await writeFile(emptyEnvFile, "");
});

after(() => rm(emptyEnvDirectory, { recursive: true, force: true }));

interface Loaded {
    code: number;
    stdout: string;
    stderr: string;
}

// a value of undefined removes the variable, so the app's own default applies
const loadLimits = async (setting: Record<string, string | undefined>): Promise<Loaded> => {
    const env = cleanChildEnvironment({ DOTENV_CONFIG_PATH: emptyEnvFile, DOTENV_CONFIG_QUIET: "true", ...setting });

    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", FIXTURE], { cwd: ROOT, env, timeout: 25_000 });
        return { code: 0, stdout, stderr };
    } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
};

describe("TOKEN_LIFETIME_SECONDS", () => {
    it("accepts a lifetime up to one day", { timeout: 30_000 }, async () => {
        for (const value of ["1", "86400"]) {
            const loaded = await loadLimits({ TOKEN_LIFETIME_SECONDS: value });

            assert.equal(loaded.code, 0, `${value}: ${loaded.stderr}`);
            assert.equal(JSON.parse(loaded.stdout).TOKEN_LIFETIME_SECONDS, Number(value));
        }
    });

    it("stops the app at startup on a lifetime of more than a day, instead of shortening it", { timeout: 30_000 }, async () => {
        for (const value of ["86401", "604800"]) {
            const loaded = await loadLimits({ TOKEN_LIFETIME_SECONDS: value });

            assert.notEqual(loaded.code, 0, `${value}: it loaded`);
            assert.match(loaded.stderr, /TOKEN_LIFETIME_SECONDS must be a whole number from 1 to 86400/, value);
            assert.equal(loaded.stdout, "", `${value}: nothing was used`);
        }
    });

    it("stops the app at startup on a lifetime of zero or a malformed one", { timeout: 30_000 }, async () => {
        for (const value of ["0", "0x10", "1e3"]) {
            const loaded = await loadLimits({ TOKEN_LIFETIME_SECONDS: value });

            assert.notEqual(loaded.code, 0, value);
            assert.match(loaded.stderr, /TOKEN_LIFETIME_SECONDS must be a whole number/, value);
        }
    });
});

// The five limits of the account routes and the number of profiles a user may keep (layer 3): the default, a custom
// value, and a value that stops the app at startup (0 would switch the limit off, and a malformed one would be read
// as something else). Each is its own setting.
const ACCOUNT_LIMITS: [name: string, defaultValue: number][] = [
    ["REQUESTS_PER_ADDRESS_PER_MINUTE", 300],
    ["LOGINS_PER_15_MINUTES", 10],
    ["FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES", 5],
    ["PASSWORD_CHANGES_PER_15_MINUTES", 5],
    ["USER_CREATIONS_PER_HOUR", 20],
    ["MAX_PROFILES_PER_USER", 20],
    // documents and indexes (layer 4)
    ["MAX_DOCUMENTS_PER_USER", 3],
    ["MAX_DOCUMENT_CHARACTERS", 1_000_000],
    ["UPLOAD_REQUESTS_PER_MINUTE", 5],
    ["MAX_ACTIVE_INDEX_BUILDS_PER_USER", 1],
    ["MAX_QUEUED_INDEX_BUILDS", 20],
    ["MAX_INDEX_BUILDS_PER_DAY", 6],
    ["MAX_INDEX_BUILDS_PER_DAY_TOTAL", 100]
];

describe("the limits of the account routes", () => {
    it("have the agreed defaults when the settings are not set", { timeout: 30_000 }, async () => {
        const loaded = await loadLimits(Object.fromEntries(ACCOUNT_LIMITS.map(([name]) => [name, undefined])));

        assert.equal(loaded.code, 0, loaded.stderr);
        assert.deepEqual(
            Object.fromEntries(ACCOUNT_LIMITS.map(([name]) => [name, JSON.parse(loaded.stdout)[name]])),
            Object.fromEntries(ACCOUNT_LIMITS)
        );
    });

    for (const [name] of ACCOUNT_LIMITS) {
        it(`${name} takes a custom value, and only that setting changes`, { timeout: 30_000 }, async () => {
            const loaded = await loadLimits({
                ...Object.fromEntries(ACCOUNT_LIMITS.map(([other]) => [other, undefined])),
                [name]: "7"
            });

            assert.equal(loaded.code, 0, loaded.stderr);

            const printed = JSON.parse(loaded.stdout);

            for (const [other, defaultValue] of ACCOUNT_LIMITS) {
                assert.equal(printed[other], other === name ? 7 : defaultValue, other);
            }
        });

        it(`${name} stops the app at startup on zero or a malformed value, instead of switching the limit off`, { timeout: 60_000 }, async () => {
            for (const value of ["0", "-1", "1e3", "0x10", "5.5", "ten"]) {
                const loaded = await loadLimits({ [name]: value });

                assert.notEqual(loaded.code, 0, `${value}: it loaded`);
                assert.match(loaded.stderr, new RegExp(`${name} must be a whole number`), value);
                assert.equal(loaded.stdout, "", `${value}: nothing was used`);
            }
        });
    }
});

// The number of profiles a user may keep has a top as well as a bottom: each profile is a row, and a limit of a
// billion would be no limit at all.
describe("MAX_PROFILES_PER_USER", () => {
    it("accepts 1 and 1000, the ends of its range", { timeout: 30_000 }, async () => {
        for (const value of ["1", "1000"]) {
            const loaded = await loadLimits({ MAX_PROFILES_PER_USER: value });

            assert.equal(loaded.code, 0, `${value}: ${loaded.stderr}`);
            assert.equal(JSON.parse(loaded.stdout).MAX_PROFILES_PER_USER, Number(value));
        }
    });

    it("stops the app at startup on more than 1000, instead of shortening it", { timeout: 30_000 }, async () => {
        for (const value of ["1001", "5000", "99999999999999"]) {
            const loaded = await loadLimits({ MAX_PROFILES_PER_USER: value });

            assert.notEqual(loaded.code, 0, `${value}: it loaded`);
            assert.match(loaded.stderr, /MAX_PROFILES_PER_USER must be a whole number from 1 to 1000/, value);
            assert.equal(loaded.stdout, "", `${value}: nothing was used`);
        }
    });
});

// The settings of documents and indexes have a top as well as a bottom: each is a cap on what one user, or the whole
// server, may consume, and a cap of a billion would be no cap at all.
const DOCUMENT_LIMIT_RANGES: [name: string, max: number][] = [
    ["MAX_DOCUMENTS_PER_USER", 1000],
    ["MAX_DOCUMENT_CHARACTERS", 5_000_000],
    ["UPLOAD_REQUESTS_PER_MINUTE", 1000],
    ["MAX_ACTIVE_INDEX_BUILDS_PER_USER", 100],
    ["MAX_QUEUED_INDEX_BUILDS", 1000],
    ["MAX_INDEX_BUILDS_PER_DAY", 1000],
    ["MAX_INDEX_BUILDS_PER_DAY_TOTAL", 10_000]
];

describe("the ranges of the limits on documents and indexes", () => {
    for (const [name, max] of DOCUMENT_LIMIT_RANGES) {
        it(`${name} accepts 1 and ${max}, the ends of its range`, { timeout: 30_000 }, async () => {
            for (const value of ["1", String(max)]) {
                const loaded = await loadLimits({ [name]: value });

                assert.equal(loaded.code, 0, `${value}: ${loaded.stderr}`);
                assert.equal(JSON.parse(loaded.stdout)[name], Number(value));
            }
        });

        it(`${name} stops the app at startup on more than ${max}, instead of shortening it`, { timeout: 60_000 }, async () => {
            for (const value of [String(max + 1), "99999999999999"]) {
                const loaded = await loadLimits({ [name]: value });

                assert.notEqual(loaded.code, 0, `${value}: it loaded`);
                assert.match(loaded.stderr, new RegExp(`${name} must be a whole number from 1 to ${max}`), value);
                assert.equal(loaded.stdout, "", `${value}: nothing was used`);
            }
        });
    }

    it("MAX_DOCUMENT_CHARACTERS accepts digits only: a number written as 1e6, 0x10, 1,000 or with a sign is refused", { timeout: 60_000 }, async () => {
        for (const value of ["1e6", "0x10", "1,000", "+5", "1000.0", "1 000"]) {
            const loaded = await loadLimits({ MAX_DOCUMENT_CHARACTERS: value });

            assert.notEqual(loaded.code, 0, `${value}: it loaded`);
            assert.match(loaded.stderr, /MAX_DOCUMENT_CHARACTERS must be a whole number/, value);
        }
    });
});

// A document of the longest text takes up to 3 bytes a character in UTF-8 (the emoji, which takes 4 bytes, is two characters
// of the count), and the body also holds the filename and the JSON around it: 16 kB is the room for those.
describe("DOCUMENT_BODY_LIMIT", () => {
    it("is 3 times MAX_DOCUMENT_CHARACTERS plus 16 kB, in bytes: 3,016,384 with the default of a million characters", { timeout: 30_000 }, async () => {
        const loaded = await loadLimits({ MAX_DOCUMENT_CHARACTERS: undefined });

        assert.equal(loaded.code, 0, loaded.stderr);
        assert.equal(JSON.parse(loaded.stdout).DOCUMENT_BODY_LIMIT, 3 * 1_000_000 + 16 * 1024);
    });

    it("follows MAX_DOCUMENT_CHARACTERS", { timeout: 60_000 }, async () => {
        for (const [characters, bytes] of [["1", 3 + 16384], ["20000", 60_000 + 16384], ["5000000", 15_000_000 + 16384]] as const) {
            const loaded = await loadLimits({ MAX_DOCUMENT_CHARACTERS: characters });

            assert.equal(loaded.code, 0, `${characters}: ${loaded.stderr}`);
            assert.equal(JSON.parse(loaded.stdout).DOCUMENT_BODY_LIMIT, bytes, `${characters} characters`);
        }
    });

    it("is not a setting of its own: a DOCUMENT_BODY_LIMIT in the environment changes nothing", { timeout: 30_000 }, async () => {
        const loaded = await loadLimits({ MAX_DOCUMENT_CHARACTERS: "20000", DOCUMENT_BODY_LIMIT: "5" });

        assert.equal(loaded.code, 0, loaded.stderr);
        assert.equal(JSON.parse(loaded.stdout).DOCUMENT_BODY_LIMIT, 60_000 + 16384);
    });
});

describe("OLLAMA_TIMEOUT_MS", () => {
    it("is two minutes when the setting is not set", { timeout: 30_000 }, async () => {
        const loaded = await loadLimits({ OLLAMA_TIMEOUT_MS: undefined });

        assert.equal(loaded.code, 0, loaded.stderr);
        assert.equal(JSON.parse(loaded.stdout).OLLAMA_TIMEOUT_MS, 120_000);
    });

    it("accepts one second up to ten minutes", { timeout: 30_000 }, async () => {
        for (const value of ["1000", "600000"]) {
            const loaded = await loadLimits({ OLLAMA_TIMEOUT_MS: value });

            assert.equal(loaded.code, 0, `${value}: ${loaded.stderr}`);
            assert.equal(JSON.parse(loaded.stdout).OLLAMA_TIMEOUT_MS, Number(value));
        }
    });

    it("stops the app at startup on less than a second or more than ten minutes, instead of shortening it", { timeout: 60_000 }, async () => {
        for (const value of ["999", "1", "600001", "3600000"]) {
            const loaded = await loadLimits({ OLLAMA_TIMEOUT_MS: value });

            assert.notEqual(loaded.code, 0, `${value}: it loaded`);
            assert.match(loaded.stderr, /OLLAMA_TIMEOUT_MS must be a whole number from 1000 to 600000/, value);
            assert.equal(loaded.stdout, "", `${value}: nothing was used`);
        }
    });

    it("stops the app at startup on zero, a negative number or a malformed value", { timeout: 60_000 }, async () => {
        for (const value of ["0", "-1", "1e3", "0x10", "2.5", "two minutes"]) {
            const loaded = await loadLimits({ OLLAMA_TIMEOUT_MS: value });

            assert.notEqual(loaded.code, 0, value);
            assert.match(loaded.stderr, /OLLAMA_TIMEOUT_MS must be a whole number/, value);
        }
    });
});

describe("HEALTH_CACHE_SECONDS", () => {
    it("accepts zero (no cache) up to five minutes", { timeout: 30_000 }, async () => {
        for (const value of ["0", "300"]) {
            const loaded = await loadLimits({ HEALTH_CACHE_SECONDS: value });

            assert.equal(loaded.code, 0, `${value}: ${loaded.stderr}`);
            assert.equal(JSON.parse(loaded.stdout).HEALTH_CACHE_SECONDS, Number(value));
        }
    });

    it("stops the app at startup on more than five minutes, instead of shortening it", { timeout: 30_000 }, async () => {
        for (const value of ["301", "86400"]) {
            const loaded = await loadLimits({ HEALTH_CACHE_SECONDS: value });

            assert.notEqual(loaded.code, 0, `${value}: it loaded`);
            assert.match(loaded.stderr, /HEALTH_CACHE_SECONDS must be a whole number from 0 to 300/, value);
            assert.equal(loaded.stdout, "", `${value}: nothing was used`);
        }
    });

    it("stops the app at startup on a negative or malformed value", { timeout: 30_000 }, async () => {
        for (const value of ["-1", "5.0", "0x10"]) {
            const loaded = await loadLimits({ HEALTH_CACHE_SECONDS: value });

            assert.notEqual(loaded.code, 0, value);
            assert.match(loaded.stderr, /HEALTH_CACHE_SECONDS must be a whole number/, value);
        }
    });
});
