import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Invisible characters (zero-width spaces, direction marks, line and paragraph separators, invisible operators,
// the byte order mark, the soft hyphen, the Mongolian vowel separator, variation selectors, and the "tag"
// characters that can carry a hidden message) hide in pasted text and change what code or a document says without
// showing. They are written here only as numbers, so this file never contains one itself.
const INVISIBLE_RANGES: [first: number, last: number][] = [
    [0x00ad, 0x00ad],
    [0x180e, 0x180e],
    [0x200b, 0x200f],
    [0x2028, 0x202f],
    [0x2060, 0x206f],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xe0000, 0xe007f]
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

const hasBom = (content: Buffer, first: number, second: number): boolean => content.length >= 2 && content[0] === first && content[1] === second;

// The text of a file, or null for a binary file. A UTF-16 file has a zero byte next to every ASCII character, so
// the zero-byte check alone would take it for binary and never scan it: its byte order mark (FF FE for
// little-endian, FE FF for big-endian) says it is text, and tells how to read it. The mark itself is the
// encoding's, not a character of the text, so it is not part of what is scanned.
const decodeTextFile = (content: Buffer): string | null => {
    if (hasBom(content, 0xff, 0xfe)) {
        return content.subarray(2).toString("utf16le");
    }

    if (hasBom(content, 0xfe, 0xff)) {
        const body = Buffer.from(content.subarray(2));
        return body.subarray(0, body.length - (body.length % 2)).swap16().toString("utf16le");
    }

    if (content.subarray(0, 8000).includes(0)) {
        return null;
    }

    return content.toString("utf8");
};

describe("the scanner for invisible characters", () => {
    it("finds a zero-width space and reports its line and column", () => {
        const text = `first line\nsecond${String.fromCodePoint(0x200b)} line`;

        assert.deepEqual(findInvisibleCharacters(text), [{ line: 2, column: 7, codePoint: "U+200B" }]);
    });

    it("covers the first and last character of every forbidden range, and nothing outside them", () => {
        const forbidden = [
            0x00ad, 0x180e,
            0x200b, 0x200f, 0x2028, 0x202f, 0x2060, 0x206f,
            0xfe00, 0xfe0f, 0xfeff,
            0xe0000, 0xe007f
        ];
        // each neighbor of a range is a character people do write: a non-breaking space, a registered sign, a
        // Mongolian digit, a presentation form
        const allowed = [0x00ac, 0x00ae, 0x00a0, 0x180d, 0x1810, 0x200a, 0x2010, 0x2027, 0x2030, 0x205f, 0x2070, 0xfdff, 0xfe10, 0xfefe, 0xdffff, 0xe0080];

        for (const codePoint of forbidden) {
            assert.equal(findInvisibleCharacters(`a${String.fromCodePoint(codePoint)}b`).length, 1, `U+${codePoint.toString(16)}`);
        }
        for (const codePoint of allowed) {
            assert.deepEqual(findInvisibleCharacters(`a${String.fromCodePoint(codePoint)}b`), [], `U+${codePoint.toString(16)}`);
        }
    });

    it("finds a character in the middle of a range, and a tag character beyond the first plane in a line of text", () => {
        for (const codePoint of [0xfe05, 0xe0041, 0x2065]) {
            assert.equal(findInvisibleCharacters(`a${String.fromCodePoint(codePoint)}b`).length, 1, `U+${codePoint.toString(16)}`);
        }

        // columns count characters, not UTF-16 units: a tag character is one column
        assert.deepEqual(findInvisibleCharacters(`ab${String.fromCodePoint(0xe0041)}`), [{ line: 1, column: 3, codePoint: "U+E0041" }]);
    });
});

describe("the reader of text files", () => {
    const withInvisible = `first\nsecond${String.fromCodePoint(0x200b)} line`;

    it("reads UTF-8 text, with or without a byte order mark, and the mark is found", () => {
        assert.equal(decodeTextFile(Buffer.from("plain text\n", "utf8")), "plain text\n");

        const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text", "utf8")]);
        assert.deepEqual(findInvisibleCharacters(decodeTextFile(withBom) ?? ""), [{ line: 1, column: 1, codePoint: "U+FEFF" }]);
    });

    it("scans a UTF-16 little-endian file with a byte order mark instead of skipping it as binary", () => {
        const file = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(withInvisible, "utf16le")]);

        assert.deepEqual(findInvisibleCharacters(decodeTextFile(file) ?? ""), [{ line: 2, column: 7, codePoint: "U+200B" }]);
    });

    it("scans a UTF-16 big-endian file with a byte order mark instead of skipping it as binary", () => {
        const file = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(withInvisible, "utf16le").swap16()]);

        assert.deepEqual(findInvisibleCharacters(decodeTextFile(file) ?? ""), [{ line: 2, column: 7, codePoint: "U+200B" }]);
    });

    it("scans a UTF-16 file for characters beyond the first plane (surrogate pairs)", () => {
        const file = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`ab${String.fromCodePoint(0xe0041)}`, "utf16le")]);

        assert.deepEqual(findInvisibleCharacters(decodeTextFile(file) ?? ""), [{ line: 1, column: 3, codePoint: "U+E0041" }]);
    });

    it("still skips a binary file, which has zero bytes and no byte order mark", () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

        assert.equal(decodeTextFile(png), null);
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
            const text = decodeTextFile(await readFile(path.join(ROOT, file)));

            if (text === null) {
                continue;
            }

            for (const finding of findInvisibleCharacters(text)) {
                problems.push(`${file}:${finding.line}:${finding.column} ${finding.codePoint}`);
            }
        }

        assert.deepEqual(problems, [], "remove these invisible characters");
    });
});
