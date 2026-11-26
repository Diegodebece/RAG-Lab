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

const loadLimits = async (setting: Record<string, string>): Promise<Loaded> => {
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
