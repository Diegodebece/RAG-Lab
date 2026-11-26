import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import {
    appendMarker, assertOutsideRepository, mergeCalls, readJsonl, readMarkers, readOverrides, snapshotTranscripts, writeJsonl
} from "../lib/storage.mjs";
import { call, makeTempDir } from "./helpers.mjs";

let base;

before(() => {
    base = makeTempDir("storage");
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("mergeCalls", () => {
    test("adds new calls, keeps the ones whose transcripts are gone, and is the same when run twice", () => {
        const stored = [call({ id: "old", timestamp: "2026-11-25T10:00:00.000Z" }), call({ id: "both", timestamp: "2026-11-26T09:00:00.000Z", role: "unknown-agent" })];
        const fresh = [call({ id: "both", timestamp: "2026-11-26T09:00:00.000Z", role: "planner" }), call({ id: "new", timestamp: "2026-11-26T11:00:00.000Z" })];
        const merged = mergeCalls(stored, fresh);
        assert.deepEqual(merged.map((found) => [found.id, found.role]), [["old", "orchestrator"], ["both", "planner"], ["new", "orchestrator"]]);
        assert.deepEqual(mergeCalls(merged, fresh), merged);
    });

    test("keeps what a stored record knew when a later read knows less, after Claude Code deleted a transcript", () => {
        const stored = [call({ id: "m9", agentId: "a1", role: "implementer", agentDescription: "Implement", sessions: ["s2", "s3"] })];
        const fresh = [call({ id: "m9", agentId: "a1", role: "unknown-agent", agentDescription: null, sessions: ["s3"] })];
        const [merged] = mergeCalls(stored, fresh);
        assert.equal(merged.role, "implementer");
        assert.equal(merged.agentDescription, "Implement");
        assert.deepEqual(merged.sessions, ["s2", "s3"]);
    });
});

describe("jsonl files", () => {
    test("write and read back, and a missing file reads as empty", () => {
        const file = path.join(base, "rows", "calls.jsonl");
        writeJsonl(file, [{ a: 1 }, { b: 2 }]);
        assert.deepEqual(readJsonl(file), [{ a: 1 }, { b: 2 }]);
        assert.deepEqual(readJsonl(path.join(base, "missing.jsonl")), []);
    });
});

describe("markers and overrides", () => {
    test("begin markers are appended and read in order", () => {
        const dataDir = path.join(base, "markers");
        appendMarker(dataDir, { type: "begin", branch: "feature/a", at: "2026-11-26T10:00:00.000Z", sessionId: "s1" });
        appendMarker(dataDir, { type: "begin", branch: "feature/b", at: "2026-11-26T11:00:00.000Z", sessionId: "s2" });
        assert.deepEqual(readMarkers(dataDir).map((marker) => marker.branch), ["feature/a", "feature/b"]);
    });

    test("no overrides file means no overrides, and a partial one is completed", () => {
        const dataDir = path.join(base, "overrides");
        assert.deepEqual(readOverrides(dataDir), { windows: [], agents: {}, sessions: {} });
        fs.mkdirSync(path.join(dataDir, "usage"), { recursive: true });
        fs.writeFileSync(path.join(dataDir, "usage", "overrides.json"), JSON.stringify({ agents: { a1: "setup" } }));
        assert.deepEqual(readOverrides(dataDir), { windows: [], agents: { a1: "setup" }, sessions: {} });
    });
});

describe("snapshotTranscripts", () => {
    const transcripts = () => path.join(base, "projects");
    const snapshots = () => path.join(base, "snapshots");
    const source = (relative) => path.join(transcripts(), relative);
    const copyOf = (relative) => gunzipSync(fs.readFileSync(path.join(snapshots(), `${relative}.gz`))).toString("utf8");
    const files = () => [
        { path: source("P/s1.jsonl"), relative: "P/s1.jsonl" },
        { path: source("P/s1/subagents/agent-a1.jsonl"), relative: "P/s1/subagents/agent-a1.jsonl" }
    ];

    before(() => {
        fs.mkdirSync(source("P/s1/subagents"), { recursive: true });
        fs.writeFileSync(source("P/s1.jsonl"), "row 1\n");
        fs.writeFileSync(source("P/s1/subagents/agent-a1.jsonl"), "agent row\n");
        fs.writeFileSync(source("P/s1/subagents/agent-a1.meta.json"), "{\"agentType\":\"planner\"}");
    });

    test("copies each transcript and its agent's meta file, compressed", () => {
        const result = snapshotTranscripts(files(), snapshots());
        assert.equal(result.copied, 3);
        assert.equal(copyOf("P/s1.jsonl"), "row 1\n");
        assert.equal(copyOf("P/s1/subagents/agent-a1.meta.json"), "{\"agentType\":\"planner\"}");
    });

    test("copies nothing again until a transcript grows", () => {
        assert.deepEqual(snapshotTranscripts(files(), snapshots()), { copied: 0, unchanged: 3 });
        fs.appendFileSync(source("P/s1.jsonl"), "row 2\n");
        assert.deepEqual(snapshotTranscripts(files(), snapshots()), { copied: 1, unchanged: 2 });
        assert.equal(copyOf("P/s1.jsonl"), "row 1\nrow 2\n");
    });

    test("keeps the copy when Claude Code deletes the transcript", () => {
        fs.rmSync(source("P/s1.jsonl"));
        snapshotTranscripts(files().slice(1), snapshots());
        assert.equal(copyOf("P/s1.jsonl"), "row 1\nrow 2\n");
    });
});

describe("assertOutsideRepository", () => {
    test("refuses a data folder inside the repository, whatever the letter case", () => {
        const repository = path.join(base, "Repo");
        assert.throws(() => assertOutsideRepository(path.join(repository, "data"), repository), /inside the repository/);
        assert.throws(() => assertOutsideRepository(repository.toUpperCase(), repository), /inside the repository/);
        assert.doesNotThrow(() => assertOutsideRepository(path.join(base, "Repo Data"), repository));
    });
});
