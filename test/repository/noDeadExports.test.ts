import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Code nobody calls is code nobody tests or audits, and it can be called by mistake later: queueIndexBuildService
// (documentIndexes.service.ts) checked the caps and queued an index in one call, and both of its callers do the two steps
// themselves, under the locks they hold. The name must not appear anywhere in src/.
const ROOT = path.join(import.meta.dirname, "..", "..");

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

describe("dead exports", () => {
    it("queueIndexBuildService is not in the sources: it was exported and nobody used it", async () => {
        const files = await listSourceFiles(path.join(ROOT, "src"));

        // the scan found the files it is meant to read, so a pass is not a scan of nothing
        assert.ok(files.some((file) => file.endsWith("documentIndexes.service.ts")));

        const mentions: string[] = [];

        for (const file of files) {
            if ((await readFile(file, "utf8")).includes("queueIndexBuildService")) {
                mentions.push(path.relative(ROOT, file));
            }
        }

        assert.deepEqual(mentions, [], "remove the function and its mentions");
    });
});
