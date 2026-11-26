import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { attribute, buildWindows, findOverlaps, parseMerges, pullRequestOf } from "../lib/attribution.mjs";
import { call } from "./helpers.mjs";

const at = (minute) => `2026-11-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const begin = (branch, minute, sessionId = "s-main") => ({ type: "begin", branch, at: at(minute), sessionId });
const merge = (branch, minute, pr) => ({ branch, mergedAt: at(minute), pr });
const NO_OVERRIDES = { windows: [], agents: {}, sessions: {} };

const decide = (calls, { markers = [], merges = [], overrides = NO_OVERRIDES } = {}) => {
    const windows = buildWindows({ markers, merges, overrides });
    return attribute(calls, { windows, markers, overrides });
};

describe("parseMerges", () => {
    test("reads the pull request merges of the main branch's history", () => {
        const log = [
            "e09bbeb\t2026-11-26T12:25:19-03:00\tMerge pull request #3 from Diegodebece/feature/foundations",
            "1c4d21f\t2026-11-26T11:00:00-03:00\tAdd the tests of layer 1",
            "687db18\t2026-11-26T02:00:16-03:00\tMerge pull request #1 from Diegodebece/feature/hook-reference-folders",
            ""
        ].join("\n");
        assert.deepEqual(parseMerges(log), [
            { pr: 3, branch: "feature/foundations", mergedAt: "2026-11-26T15:25:19.000Z" },
            { pr: 1, branch: "feature/hook-reference-folders", mergedAt: "2026-11-26T05:00:16.000Z" }
        ]);
    });
});

describe("buildWindows", () => {
    test("a loop runs from its begin marker to the merge of its branch, or stays open", () => {
        const windows = buildWindows({
            markers: [begin("feature/a", 0), begin("feature/a", 5, "s-other"), begin("feature/b", 30)],
            merges: [merge("feature/a", 20, 4)],
            overrides: { ...NO_OVERRIDES, windows: [{ bucket: "setup", from: at(40), to: at(50) }] }
        });
        assert.deepEqual(windows, [
            { bucket: "feature/a", from: at(0), to: at(20), pr: 4, source: "marker" },
            { bucket: "feature/b", from: at(30), to: null, pr: null, source: "marker" },
            { bucket: "setup", from: at(40), to: at(50), pr: null, source: "override" }
        ]);
    });

    test("a merge from before the begin marker belongs to an earlier use of the branch name", () => {
        const [window] = buildWindows({ markers: [begin("feature/a", 30)], merges: [merge("feature/a", 10, 1)], overrides: NO_OVERRIDES });
        assert.equal(window.to, null);
    });
});

describe("times and branch names", () => {
    test("times with an offset are compared as instants, not as text", () => {
        const overrides = { ...NO_OVERRIDES, windows: [{ bucket: "setup", from: "2026-11-26T08:00:00-03:00", to: "2026-11-26T09:00:00-03:00" }] };
        const result = decide([
            call({ id: "inside", timestamp: "2026-11-26T11:30:00.000Z" }),
            call({ id: "outside", timestamp: "2026-11-26T08:30:00.000Z" })
        ], { overrides });
        assert.equal(result.get("inside").bucket, "setup");
        assert.equal(result.get("outside").rule, "unattributed");
    });

    test("refuses a window or marker whose time is not a date", () => {
        assert.throws(() => buildWindows({ markers: [], merges: [], overrides: { ...NO_OVERRIDES, windows: [{ bucket: "setup", from: "yesterday" }] } }), /Invalid time/);
        assert.throws(() => buildWindows({ markers: [{ type: "begin", branch: "feature/a", at: "soon" }], merges: [], overrides: NO_OVERRIDES }), /Invalid time/);
    });

    test("a branch name used again after its merge starts a new window, without the old pull request number", () => {
        const windows = buildWindows({
            markers: [begin("feature/a", 0), begin("feature/a", 10), begin("feature/a", 30, "s-later")],
            merges: [merge("feature/a", 20, 1)],
            overrides: NO_OVERRIDES
        });
        assert.deepEqual(windows.map((window) => [window.from, window.to, window.pr]), [[at(0), at(20), 1], [at(30), null, null]]);
        assert.equal(pullRequestOf("feature/a", windows), null);
        assert.equal(pullRequestOf("feature/b", windows), null);
        const result = decide([call({ id: "c1", timestamp: at(35), sessionId: "s-x" })], {
            markers: [begin("feature/a", 0), begin("feature/a", 30, "s-later")],
            merges: [merge("feature/a", 20, 1)]
        });
        assert.equal(result.get("c1").bucket, "feature/a");
    });

    test("the pull request of a loop is the one its latest window was merged in", () => {
        const windows = buildWindows({ markers: [begin("feature/a", 0)], merges: [merge("feature/a", 20, 4)], overrides: NO_OVERRIDES });
        assert.equal(pullRequestOf("feature/a", windows), 4);
    });
});

describe("findOverlaps", () => {
    test("lists the loops that were open at the same time", () => {
        const windows = buildWindows({
            markers: [begin("feature/a", 0), begin("feature/b", 10), begin("feature/c", 40)],
            merges: [merge("feature/a", 20, 1), merge("feature/b", 30, 2)],
            overrides: NO_OVERRIDES
        });
        assert.deepEqual(findOverlaps(windows), [["feature/a", "feature/b"]]);
    });
});

describe("attribute", () => {
    test("a call inside one loop's window belongs to it; outside every window it stays unattributed", () => {
        const result = decide([call({ id: "in", timestamp: at(5), sessionId: "s-x" }), call({ id: "out", timestamp: at(25), sessionId: "s-x" })], {
            markers: [begin("feature/a", 0)],
            merges: [merge("feature/a", 20, 1)]
        });
        assert.deepEqual(result.get("in"), { bucket: "feature/a", rule: "time", candidates: [] });
        assert.deepEqual(result.get("out"), { bucket: null, rule: "unattributed", candidates: [] });
    });

    test("the session that began a loop belongs to it, even while another loop is open", () => {
        const result = decide([call({ id: "c1", timestamp: at(15), sessionId: "s-b" })], {
            markers: [begin("feature/a", 0, "s-a"), begin("feature/b", 10, "s-b")]
        });
        assert.deepEqual(result.get("c1"), { bucket: "feature/b", rule: "session", candidates: [] });
    });

    test("a session's later begin marker moves its next calls to the new loop", () => {
        const result = decide([call({ id: "c1", timestamp: at(5), sessionId: "s-main" }), call({ id: "c2", timestamp: at(25), sessionId: "s-main" })], {
            markers: [begin("feature/a", 0), begin("feature/b", 21)],
            merges: [merge("feature/a", 20, 1)]
        });
        assert.deepEqual(result.get("c1"), { bucket: "feature/a", rule: "session", candidates: [] });
        assert.deepEqual(result.get("c2"), { bucket: "feature/b", rule: "session", candidates: [] });
    });

    test("after its loop is merged, a session's calls are no longer that loop's", () => {
        const result = decide([call({ id: "c1", timestamp: at(25), sessionId: "s-main" })], {
            markers: [begin("feature/a", 0)],
            merges: [merge("feature/a", 20, 1)]
        });
        assert.equal(result.get("c1").rule, "unattributed");
    });

    test("in an overlap, the worktree the call ran in decides; otherwise the call is ambiguous", () => {
        const markers = [begin("feature/a", 0, "s-a"), begin("feature/b", 10, "s-b")];
        const result = decide([
            call({ id: "in-worktree", timestamp: at(15), sessionId: "s-x", cwd: ".claude/worktrees/b" }),
            call({ id: "in-main", timestamp: at(15), sessionId: "s-x", cwd: "." })
        ], { markers });
        assert.deepEqual(result.get("in-worktree"), { bucket: "feature/b", rule: "time+cwd", candidates: [] });
        assert.deepEqual(result.get("in-main"), { bucket: null, rule: "ambiguous", candidates: ["feature/a", "feature/b"] });
    });

    test("all the calls of an agent follow its first call, even after its loop is merged", () => {
        const result = decide([
            call({ id: "a-1", timestamp: at(19), agentId: "a1", role: "implementer", sessionId: "s-x" }),
            call({ id: "a-2", timestamp: at(22), agentId: "a1", role: "implementer", sessionId: "s-x" })
        ], { markers: [begin("feature/a", 0)], merges: [merge("feature/a", 20, 1)] });
        assert.equal(result.get("a-1").bucket, "feature/a");
        assert.deepEqual(result.get("a-2"), { bucket: "feature/a", rule: "time", candidates: [] });
    });

    test("an agent launched from a session that began a loop belongs to that loop", () => {
        const result = decide([call({ id: "a-1", timestamp: at(15), agentId: "a1", role: "planner", sessionId: "s-b" })], {
            markers: [begin("feature/a", 0, "s-a"), begin("feature/b", 10, "s-b")]
        });
        assert.equal(result.get("a-1").bucket, "feature/b");
    });

    test("manual overrides win: agent first, then session, then override windows over marker windows", () => {
        const overrides = {
            windows: [{ bucket: "setup", from: at(0), to: at(30) }],
            agents: { a1: "feature/hooks" },
            sessions: { "s-side": "feature/side" }
        };
        const result = decide([
            call({ id: "agent", timestamp: at(5), agentId: "a1", role: "test-writer", sessionId: "s-side" }),
            call({ id: "session", timestamp: at(5), sessionId: "s-side" }),
            call({ id: "window", timestamp: at(5), sessionId: "s-x" })
        ], { markers: [begin("feature/a", 0, "s-a")], overrides });
        assert.deepEqual(result.get("agent"), { bucket: "feature/hooks", rule: "override:agent", candidates: [] });
        assert.deepEqual(result.get("session"), { bucket: "feature/side", rule: "override:session", candidates: [] });
        assert.deepEqual(result.get("window"), { bucket: "setup", rule: "override:window", candidates: [] });
    });
});
