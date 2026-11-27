import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// .env.example lists every variable the API reads, so someone setting the project up finds each one. This check reads
// the sources for the variables they ask for by name and looks for each in .env.example (a setting that has a default
// is there commented out, "# NAME=value", and counts).
//
// What is scanned: readIntegerSetting("NAME", ...), readListSetting("NAME", ...), process.env.NAME and
// process.env["NAME"] in every .ts file of src/. A name that is built at run time (process.env[name] inside the two
// readers themselves) cannot be found this way, and is covered by the call that gives the name.
const ROOT = path.join(import.meta.dirname, "..", "..");

const NAME_PATTERNS = [
    /\b(?:readIntegerSetting|readListSetting)\(\s*"([A-Z][A-Z0-9_]*)"/g,
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g
];

const variableNamesIn = (source: string): string[] => NAME_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));

const listSourceFiles = async (folder: string): Promise<string[]> => {
    const files: string[] = [];
    const entries: Dirent[] = await readdir(folder, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(folder, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await listSourceFiles(full)));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            files.push(full);
        }
    }

    return files;
};

// every variable name in the example file, set or commented out
const variableNamesInExample = (text: string): Set<string> =>
    new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

describe("the scan for the variables the API reads", () => {
    it("finds a name given to a reader and a name read from process.env", () => {
        const source = "const a = readIntegerSetting(\"A_ONE\", 5, 1, 9);\nconst b = readListSetting( \"B_TWO\");\nconst c = process.env.C_THREE || \"x\";\nconst d = process.env[\"D_FOUR\"];";

        assert.deepEqual(variableNamesIn(source).sort(), ["A_ONE", "B_TWO", "C_THREE", "D_FOUR"]);
    });

    it("does not take a variable that is read through a name built at run time, or a word in a comment", () => {
        assert.deepEqual(variableNamesIn("const raw = process.env[name];\n// see readIntegerSetting for the rules"), []);
    });

    it("finds the names written as a commented-out setting or as a set one in the example file", () => {
        assert.deepEqual([...variableNamesInExample("# a comment: not a name\nSET_ONE=1\n# COMMENTED_TWO=2\n#   SPACED_THREE=3\n")].sort(), ["COMMENTED_TWO", "SET_ONE", "SPACED_THREE"]);
    });
});

describe(".env.example", () => {
    it("lists every variable that src/ reads, so a setting that exists is a setting someone can find", async () => {
        const names = new Set<string>();

        for (const file of await listSourceFiles(path.join(ROOT, "src"))) {
            for (const name of variableNamesIn(await readFile(file, "utf8"))) {
                names.add(name);
            }
        }

        // the scan found the settings it is meant to find, so a pass is not a scan of nothing
        for (const known of ["SECRET_KEY", "DATABASE_URL", "MIGRATION_DATABASE_URL", "PORT", "HOST", "TRUSTED_PROXIES", "CORS_ORIGINS", "OLLAMA_BASE_URL", "TOKEN_LIFETIME_SECONDS", "HEALTH_CACHE_SECONDS"]) {
            assert.ok(names.has(known), `the scan of src/ did not find ${known}`);
        }

        const example = variableNamesInExample(await readFile(path.join(ROOT, ".env.example"), "utf8"));
        const missing = [...names].filter((name) => !example.has(name)).sort();

        assert.deepEqual(missing, [], "add these to .env.example, commented out with their default when they have one");
    });
});
