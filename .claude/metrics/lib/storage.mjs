// Files the metrics keep in the private data folder (RAG_LAB_DATA_DIR), never in the repository:
//   usage/calls.jsonl       one record per model call, kept after Claude Code deletes the transcripts
//   usage/loops.jsonl       begin markers of each loop
//   usage/overrides.json    manual attribution: { windows: [...], agents: {...}, sessions: {...} }
//   usage/cost-state.json   Claude Code's own latest cost estimate per session
//   usage/transcripts/      gzip copies of the transcripts, with a manifest of the sizes copied

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const usageDir = (dataDir) => path.join(dataDir, "usage");

export const readJsonl = (filePath) => {
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
};

// Writes to a temporary file first, so an interrupted run never leaves a half-written file.
const writeAtomic = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, filePath);
};

export const writeJsonl = (filePath, rows) => writeAtomic(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));

export const readJson = (filePath, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") {
            return fallback;
        }
        throw error;
    }
};

export const writeJson = (filePath, value) => writeAtomic(filePath, `${JSON.stringify(value, null, 4)}\n`);

// The stored calls plus the fresh ones, by id, sorted by time. A fresh record updates a stored one, but never
// makes it know less: once Claude Code deletes a transcript, the session it was copied in and the agent's role
// found through it are gone from the fresh read, and the stored record keeps them.
export const mergeCalls = (stored, fresh) => {
    const byId = new Map(stored.map((call) => [call.id, call]));
    for (const call of fresh) {
        const old = byId.get(call.id);
        if (!old) {
            byId.set(call.id, call);
            continue;
        }
        byId.set(call.id, {
            ...call,
            role: call.role === "unknown-agent" && old.role ? old.role : call.role,
            agentDescription: call.agentDescription ?? old.agentDescription ?? null,
            sessions: [...new Set([...(old.sessions ?? []), ...call.sessions])].sort()
        });
    }
    return [...byId.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : (a.id < b.id ? -1 : 1)));
};

export const readMarkers = (dataDir) => readJsonl(path.join(usageDir(dataDir), "loops.jsonl"));

export const appendMarker = (dataDir, marker) => {
    fs.mkdirSync(usageDir(dataDir), { recursive: true });
    fs.appendFileSync(path.join(usageDir(dataDir), "loops.jsonl"), `${JSON.stringify(marker)}\n`);
};

export const readOverrides = (dataDir) => {
    const stored = readJson(path.join(usageDir(dataDir), "overrides.json"), {});
    return { windows: stored.windows ?? [], agents: stored.agents ?? {}, sessions: stored.sessions ?? {} };
};

// Copies each transcript (and an agent's meta file) as gzip, again only when it has grown. A copy stays when
// Claude Code deletes the original. Returns how many files were copied and how many were already up to date.
export const snapshotTranscripts = (files, snapshotDir) => {
    const manifestPath = path.join(snapshotDir, "manifest.json");
    const manifest = readJson(manifestPath, {});
    const result = { copied: 0, unchanged: 0 };
    const sources = [];
    for (const file of files) {
        sources.push({ path: file.path, relative: file.relative });
        const meta = file.path.replace(/\.jsonl$/, ".meta.json");
        if (meta !== file.path && fs.existsSync(meta)) {
            sources.push({ path: meta, relative: file.relative.replace(/\.jsonl$/, ".meta.json") });
        }
    }
    for (const source of sources) {
        let size;
        try {
            size = fs.statSync(source.path).size;
        } catch {
            continue;
        }
        if (manifest[source.relative] === size) {
            result.unchanged++;
            continue;
        }
        writeAtomic(path.join(snapshotDir, `${source.relative}.gz`), gzipSync(fs.readFileSync(source.path)));
        manifest[source.relative] = size;
        result.copied++;
    }
    writeJson(manifestPath, manifest);
    return result;
};

// The data folder must be outside the repository: it holds conversations and private data.
export const assertOutsideRepository = (dataDir, repoRoot) => {
    const relative = path.relative(path.resolve(repoRoot).toLowerCase(), path.resolve(dataDir).toLowerCase());
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        throw new Error(`RAG_LAB_DATA_DIR (${dataDir}) is inside the repository; it must be outside it, because it holds private data.`);
    }
};
