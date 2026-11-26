import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { findTranscriptFiles, projectSlug, readCalls } from "../lib/transcripts.mjs";
import { agentLaunch, assistant, costState, makeTempDir, usage, writeTranscripts } from "./helpers.mjs";

const SLUG = "C--Repo";
const REPO = "C:\\Repo";
let projects;

before(() => {
    projects = makeTempDir("transcripts");
});

after(() => fs.rmSync(projects, { recursive: true, force: true }));

// A fresh projects folder per test, so the cases do not see each other's files.
const setup = (name, files) => {
    const root = path.join(projects, name);
    writeTranscripts(root, files);
    return root;
};

const readAll = (root) => readCalls(findTranscriptFiles(root, SLUG), { repoRoot: REPO });

describe("projectSlug", () => {
    test("turns the repository path into Claude Code's folder name", () => {
        assert.equal(projectSlug("D:\\Claude\\RAG Lab"), "D--Claude-RAG-Lab");
        assert.equal(projectSlug("C:\\Repo"), "C--Repo");
    });
});

describe("findTranscriptFiles", () => {
    test("finds the sessions and their agents, in this project and in its worktree sessions only", () => {
        const root = setup("find", {
            [`${SLUG}/s1.jsonl`]: [],
            [`${SLUG}/s1/subagents/agent-a1.jsonl`]: [],
            [`${SLUG}/s1/subagents/agent-a1.meta.json`]: {},
            [`${SLUG}/s1/tool-results/x.txt`]: "not a transcript",
            [`${SLUG}--claude-worktrees-feature/s2.jsonl`]: [],
            [`${SLUG}-Data/s3.jsonl`]: [],
            ["C--Other/s4.jsonl"]: []
        });
        const files = findTranscriptFiles(root, SLUG);
        assert.deepEqual(files.map((file) => [file.relative, file.session, file.agentId]), [
            [`${SLUG}/s1.jsonl`, "s1", null],
            [`${SLUG}/s1/subagents/agent-a1.jsonl`, "s1", "a1"],
            [`${SLUG}--claude-worktrees-feature/s2.jsonl`, "s2", null]
        ]);
    });

    test("returns nothing when the folder does not exist", () => {
        assert.deepEqual(findTranscriptFiles(path.join(projects, "missing"), SLUG), []);
    });
});

describe("readCalls", () => {
    test("counts a message once, however many rows and sessions repeat it", () => {
        const rows = assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z", blocks: 3 });
        const root = setup("dedupe", {
            [`${SLUG}/s1.jsonl`]: rows,
            [`${SLUG}/s2.jsonl`]: rows
        });
        const { calls, stats } = readAll(root);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].sessions, ["s1", "s2"]);
        assert.equal(stats.rows, 6);
        assert.equal(stats.unique, 1);
    });

    test("reads every usage field", () => {
        const root = setup("fields", {
            [`${SLUG}/s1.jsonl`]: assistant({
                id: "m1",
                at: "2026-11-26T10:00:00.000Z",
                u: usage({
                    input_tokens: 3,
                    output_tokens: 500,
                    output_tokens_details: { thinking_tokens: 200 },
                    cache_creation_input_tokens: 70,
                    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
                    cache_read_input_tokens: 9000,
                    server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
                    speed: "fast"
                })
            })
        });
        const [found] = readAll(root).calls;
        assert.equal(found.input, 3);
        assert.equal(found.output, 500);
        assert.equal(found.thinking, 200);
        assert.equal(found.cacheWrite5m, 30);
        assert.equal(found.cacheWrite1h, 40);
        assert.equal(found.cacheRead, 9000);
        assert.equal(found.webSearch, 2);
        assert.equal(found.webFetch, 1);
        assert.equal(found.speed, "fast");
        assert.equal(found.model, "claude-opus-5-5");
        assert.equal(found.timestamp, "2026-11-26T10:00:00.000Z");
    });

    test("counts cache writes without a 5m/1h split as 5-minute writes", () => {
        const root = setup("no-split", {
            [`${SLUG}/s1.jsonl`]: assistant({
                id: "m1",
                at: "2026-11-26T10:00:00.000Z",
                u: usage({ cache_creation_input_tokens: 70, cache_creation: undefined })
            })
        });
        const [found] = readAll(root).calls;
        assert.equal(found.cacheWrite5m, 70);
        assert.equal(found.cacheWrite1h, 0);
    });

    test("skips synthetic and API-error messages, and counts a broken line without stopping", () => {
        const root = setup("skips", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z", model: "<synthetic>" }),
                ...assistant({ id: "m2", at: "2026-11-26T10:00:01.000Z", extra: { isApiErrorMessage: true } }),
                "{ not json",
                ...assistant({ id: "m3", at: "2026-11-26T10:00:02.000Z" })
            ]
        });
        const { calls, stats } = readAll(root);
        assert.deepEqual(calls.map((found) => found.id), ["m3"]);
        assert.equal(stats.malformed, 1);
        assert.equal(stats.skipped, 2);
    });

    test("a line that is valid JSON but not an object counts as broken", () => {
        const root = setup("not-objects", {
            [`${SLUG}/s1.jsonl`]: ["null", "42", "\"text\"", ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z" })]
        });
        const { calls, stats } = readAll(root);
        assert.equal(calls.length, 1);
        assert.equal(stats.malformed, 3);
    });

    test("takes the largest count of each field when the rows of one message differ", () => {
        const [partial, final] = [usage({ output_tokens: 10, cache_read_input_tokens: 5 }), usage({ output_tokens: 100, cache_read_input_tokens: 50 })];
        const root = setup("partial-rows", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z", u: partial }),
                ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z", u: final })
            ]
        });
        const [found] = readAll(root).calls;
        assert.equal(found.output, 100);
        assert.equal(found.cacheRead, 50);
    });

    test("stores times in UTC and skips a row whose time is not a date", () => {
        const root = setup("times", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m1", at: "2026-11-26T07:00:00-03:00" }),
                ...assistant({ id: "m2", at: "not a time" })
            ]
        });
        const { calls, stats } = readAll(root);
        assert.deepEqual(calls.map((found) => found.timestamp), ["2026-11-26T10:00:00.000Z"]);
        assert.equal(stats.skipped, 1);
    });

    test("names the main session's calls orchestrator and finds each agent's role", () => {
        const root = setup("roles", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m0", at: "2026-11-26T09:59:00.000Z" }),
                ...agentLaunch({ toolUseId: "t3", agentId: "a3", subagentType: "implementer", description: "Implement layer 2", at: "2026-11-26T10:00:00.000Z", sessionId: "s1" })
            ],
            // from the agent's meta file
            [`${SLUG}/s1/subagents/agent-a1.jsonl`]: assistant({ id: "m1", at: "2026-11-26T10:01:00.000Z", agentId: "a1" }),
            [`${SLUG}/s1/subagents/agent-a1.meta.json`]: { agentType: "planner", description: "Plan layer 2", model: "claude-opus-5-5" },
            // from the rows' attribution, when the meta file is missing (a copy in another session)
            [`${SLUG}/s1/subagents/agent-a2.jsonl`]: assistant({ id: "m2", at: "2026-11-26T10:02:00.000Z", agentId: "a2", attributionAgent: "code-auditor" }),
            // from the Agent call in the parent transcript
            [`${SLUG}/s1/subagents/agent-a3.jsonl`]: assistant({ id: "m3", at: "2026-11-26T10:03:00.000Z", agentId: "a3" }),
            // from nothing
            [`${SLUG}/s1/subagents/agent-a4.jsonl`]: assistant({ id: "m4", at: "2026-11-26T10:04:00.000Z", agentId: "a4" })
        });
        const byId = Object.fromEntries(readAll(root).calls.map((found) => [found.id, found]));
        assert.equal(byId.m0.role, "orchestrator");
        assert.equal(byId.m0.agentId, null);
        assert.deepEqual([byId.m1.role, byId.m1.agentId, byId.m1.agentDescription], ["planner", "a1", "Plan layer 2"]);
        assert.equal(byId.m2.role, "code-auditor");
        assert.deepEqual([byId.m3.role, byId.m3.agentDescription], ["implementer", "Implement layer 2"]);
        assert.equal(byId.m4.role, "unknown-agent");
    });

    test("an agent's meta file in one session names its copy in another", () => {
        const rows = assistant({ id: "m1", at: "2026-11-26T10:01:00.000Z", agentId: "a1" });
        const root = setup("copied-agent", {
            [`${SLUG}/s1/subagents/agent-a1.jsonl`]: rows,
            [`${SLUG}/s2/subagents/agent-a1.jsonl`]: rows,
            [`${SLUG}/s2/subagents/agent-a1.meta.json`]: { agentType: "test-writer", description: "Write tests" }
        });
        const [found] = readAll(root).calls;
        assert.equal(found.role, "test-writer");
    });

    test("keeps the working folder relative to the repository, and nothing outside it", () => {
        const root = setup("cwd", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z", cwd: "C:\\Repo" }),
                ...assistant({ id: "m2", at: "2026-11-26T10:00:01.000Z", cwd: "c:\\repo\\.claude\\worktrees\\feature-x" }),
                ...assistant({ id: "m3", at: "2026-11-26T10:00:02.000Z", cwd: "C:\\Users\\someone\\elsewhere" }),
                ...assistant({ id: "m4", at: "2026-11-26T10:00:03.000Z", cwd: "C:\\Repository" })
            ]
        });
        assert.deepEqual(readAll(root).calls.map((found) => found.cwd), [".", ".claude/worktrees/feature-x", "<outside>", "<outside>"]);
    });

    test("keeps Claude Code's latest cost estimate of each session", () => {
        const root = setup("cost-state", {
            [`${SLUG}/s1.jsonl`]: [costState("s1", 1.5), ...assistant({ id: "m1", at: "2026-11-26T10:00:00.000Z" }), costState("s1", 2.25)]
        });
        assert.deepEqual(readAll(root).costStates, { s1: { totalCostUSD: 2.25 } });
    });

    test("keeps no message text, prompt or result", () => {
        const root = setup("private", {
            [`${SLUG}/s1.jsonl`]: [
                ...assistant({ id: "m0", at: "2026-11-26T09:59:00.000Z" }),
                ...agentLaunch({ toolUseId: "t1", agentId: "a1", subagentType: "planner", description: "Plan", at: "2026-11-26T10:00:00.000Z", sessionId: "s1" })
            ],
            [`${SLUG}/s1/subagents/agent-a1.jsonl`]: assistant({ id: "m1", at: "2026-11-26T10:01:00.000Z", agentId: "a1" })
        });
        const text = JSON.stringify(readAll(root));
        assert.ok(!text.includes("private"), text);
    });
});
