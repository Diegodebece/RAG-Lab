import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Invisible characters (zero-width spaces, direction marks, line and paragraph separators, invisible operators,
// the byte order mark) hide in pasted text and change what code or a document says without showing. They are
// written here only as numbers, so this file never contains one itself.
const INVISIBLE_RANGES: [first: number, last: number][] = [
    [0x200b, 0x200f],
    [0x2028, 0x202f],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff]
];

const isInvisible = (codePoint: number): boolean => INVISIBLE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);

interface Finding {
    line: number;
    column: number;
    codePoint: string;
}

// Where each invisible character is in the text: 1-based line and column, and its code point.
const findInvisibleCharacters = (text: string): Finding[] => {
    const findings: Finding[] = [];

    text.split("\n").forEach((lineText, index) => {
        let column = 0;

        for (const character of lineText) {
            column++;
            const codePoint = character.codePointAt(0) ?? 0;

            if (isInvisible(codePoint)) {
                findings.push({ line: index + 1, column, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}` });
            }
        }
    });

    return findings;
};

const ROOT = path.join(import.meta.dirname, "..", "..");

// folders scanned from top to bottom
const FOLDERS = ["src", "test", "migrations", "docs", ".claude/skills"];
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", ".git"]);

// Every file this check covers, as paths relative to the project root with forward slashes.
const listProjectFiles = async (): Promise<string[]> => {
    const files: string[] = [];

    const walk = async (folder: string): Promise<void> => {
        let entries: Dirent[];

        try {
            entries = await readdir(path.join(ROOT, folder), { withFileTypes: true });
        } catch (error) {
            // a layer that does not exist yet (no migrations folder, for example) has nothing to scan
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return;
            }
            throw error;
        }

        for (const entry of entries) {
            const relative = `${folder}/${entry.name}`;

            if (entry.isDirectory()) {
                if (!SKIPPED_FOLDERS.has(entry.name)) {
                    await walk(relative);
                }
            } else if (entry.isFile()) {
                files.push(relative);
            }
        }
    };

    for (const folder of FOLDERS) {
        await walk(folder);
    }

    // the files in the project root: README.md, .env.example, CLAUDE.md and the configuration files
    for (const entry of await readdir(ROOT, { withFileTypes: true })) {
        // .env and .env.local hold secrets and are git-ignored: only the example file is part of the project
        const isSecretFile = entry.name.startsWith(".env") && entry.name !== ".env.example";

        if (entry.isFile() && !isSecretFile) {
            files.push(entry.name);
        }
    }

    return files;
};

const isBinary = (content: Buffer): boolean => content.subarray(0, 8000).includes(0);

describe("the scanner for invisible characters", () => {
    it("finds a zero-width space and reports its line and column", () => {
        const text = `first line\nsecond${String.fromCodePoint(0x200b)} line`;

        assert.deepEqual(findInvisibleCharacters(text), [{ line: 2, column: 7, codePoint: "U+200B" }]);
    });

    it("covers the first and last character of every forbidden range, and nothing outside them", () => {
        const forbidden = [0x200b, 0x200f, 0x2028, 0x202f, 0x2060, 0x206f, 0xfeff];
        const allowed = [0x200a, 0x2010, 0x2027, 0x2030, 0x205f, 0x2070, 0xfefe, 0x00a0];

        for (const codePoint of forbidden) {
            assert.equal(findInvisibleCharacters(`a${String.fromCodePoint(codePoint)}b`).length, 1, `U+${codePoint.toString(16)}`);
        }
        for (const codePoint of allowed) {
            assert.deepEqual(findInvisibleCharacters(`a${String.fromCodePoint(codePoint)}b`), [], `U+${codePoint.toString(16)}`);
        }
    });
});

describe("project text files", () => {
    it("scans the project's files, not an empty list", async () => {
        const files = await listProjectFiles();

        assert.ok(files.includes("test/repository/invisibleCharacters.test.ts"), "it scans the tests");
        assert.ok(files.includes("package.json"), "it scans the root configuration files");
        assert.ok(files.some((file) => file.startsWith(".claude/skills/")), "it scans the skills");
        assert.ok(files.every((file) => !file.includes("node_modules/") && !file.startsWith(".git/")), "it skips dependencies and git");
    });

    it("contain no invisible characters", async () => {
        const problems: string[] = [];

        for (const file of await listProjectFiles()) {
            const content = await readFile(path.join(ROOT, file));

            if (isBinary(content)) {
                continue;
            }

            for (const finding of findInvisibleCharacters(content.toString("utf8"))) {
                problems.push(`${file}:${finding.line}:${finding.column} ${finding.codePoint}`);
            }
        }

        assert.deepEqual(problems, [], "remove these invisible characters");
    });
});
