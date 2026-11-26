import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderSummaryTable, renderUsageSection, replaceBetweenMarkers, summarizeBucket } from "../lib/report.mjs";
import { call, testPrices } from "./helpers.mjs";

const at = (minute) => `2026-11-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
// every call below costs the same: (10 x 4 + 100 x 20 + 1000 x 8 + 10000 x 0.2) / 1e6 on Opus
const OPUS_CALL = 12040 / 1e6;

const BUCKET = "feature/x";
const sample = () => [
    call({ id: "o1", timestamp: at(0), sessionId: "s1", sessions: ["s1"] }),
    call({ id: "o2", timestamp: at(1), sessionId: "s1", sessions: ["s1"] }),
    call({ id: "p1", timestamp: at(2), sessionId: "s1", sessions: ["s1"], agentId: "a1", role: "planner", agentDescription: "Plan layer 2" }),
    call({ id: "i1", timestamp: at(3), sessionId: "s1", sessions: ["s1"], agentId: "a2", role: "implementer", agentDescription: "Implement layer 2" }),
    call({ id: "i2", timestamp: at(9), sessionId: "s1", sessions: ["s1"], agentId: "a3", role: "implementer", agentDescription: "Fix confirmed findings" }),
    call({ id: "i3", timestamp: at(10), sessionId: "s1", sessions: ["s1"], agentId: "a3", role: "implementer", agentDescription: "Fix confirmed findings" }),
    // another loop's call in another session
    call({ id: "z1", timestamp: at(30), sessionId: "s2", sessions: ["s2"] })
];
const attributionsOf = (calls, other = {}) =>
    new Map(calls.map((found) => [found.id, { bucket: other[found.id] ?? (found.id.startsWith("z") ? "feature/other" : BUCKET), rule: "time", candidates: [] }]));

const summarize = (calls = sample(), { costStates = {}, other = {} } = {}) =>
    summarizeBucket({ calls, attributions: attributionsOf(calls, other), bucket: BUCKET, prices: testPrices(), costStates });

describe("summarizeBucket", () => {
    test("adds up the bucket's calls by role, with the loop step and the share of the cost", () => {
        const summary = summarize();
        assert.equal(summary.totals.calls, 6);
        close(summary.totals.cost, 6 * OPUS_CALL);
        assert.equal(summary.totals.complete, true);
        const roles = Object.fromEntries(summary.byRole.map((row) => [row.role, row]));
        assert.deepEqual([roles.orchestrator.step, roles.orchestrator.calls, roles.orchestrator.launches], ["orchestration", 2, 0]);
        assert.deepEqual([roles.planner.step, roles.planner.launches], ["plan", 1]);
        assert.deepEqual([roles.implementer.step, roles.implementer.calls, roles.implementer.launches], ["code", 3, 2]);
        close(roles.implementer.share, 0.5);
        close(summary.byRole.reduce((sum, row) => sum + row.share, 0), 1);
        assert.equal(roles.implementer.output, 300);
        assert.equal(roles.implementer.thinking, 120);
        assert.equal(summary.byModel[0].model, "claude-opus-5-5");
        assert.deepEqual([summary.from, summary.to], [at(0), at(10)]);
    });

    test("counts the launches after a role's first as extra rounds, with their cost", () => {
        const { extraRounds } = summarize();
        assert.equal(extraRounds.length, 1);
        assert.equal(extraRounds[0].role, "implementer");
        assert.equal(extraRounds[0].extra, 1);
        close(extraRounds[0].extraCost, 2 * OPUS_CALL);
    });

    test("lists each agent with its start, calls and cost", () => {
        const { agents } = summarize();
        assert.deepEqual(agents.map((agent) => [agent.role, agent.description, agent.start, agent.calls]), [
            ["planner", "Plan layer 2", at(2), 1],
            ["implementer", "Implement layer 2", at(3), 1],
            ["implementer", "Fix confirmed findings", at(9), 2]
        ]);
    });

    test("a call without a price leaves the total incomplete", () => {
        const summary = summarize([...sample(), call({ id: "u1", timestamp: at(11), model: "claude-new-9" })]);
        assert.equal(summary.totals.complete, false);
        assert.match(summary.notes.join(" "), /claude-new-9/);
    });

    test("compares with Claude Code's estimate only for sessions entirely inside the bucket", () => {
        const flagged = summarize(sample(), { costStates: { s1: { totalCostUSD: 1 }, s2: { totalCostUSD: 5 } } }).crossCheck;
        assert.equal(flagged.length, 1);
        assert.equal(flagged[0].session, "s1");
        close(flagged[0].ours, 6 * OPUS_CALL);
        assert.equal(flagged[0].claudeCode, 1);
        assert.equal(flagged[0].flagged, true);

        const near = summarize(sample(), { costStates: { s1: { totalCostUSD: 6 * OPUS_CALL * 1.04 } } }).crossCheck;
        assert.equal(near[0].flagged, false);

        const spanning = summarize(sample(), { costStates: { s1: { totalCostUSD: 1 } }, other: { o2: "feature/other" } }).crossCheck;
        assert.deepEqual(spanning, [{ session: "s1", spans: true }]);
    });

    test("a session's calls are the ones it made, not the history copied into it from another session", () => {
        // s2 is a side session started from s1: its transcript repeats s1's calls, which keep s1's session id
        const calls = [
            call({ id: "o1", timestamp: at(0), sessionId: "s1", sessions: ["s1", "s2"] }),
            call({ id: "o2", timestamp: at(1), sessionId: "s1", sessions: ["s1", "s2"] }),
            call({ id: "f1", timestamp: at(2), sessionId: "s2", sessions: ["s2"] })
        ];
        const summary = summarize(calls, { costStates: { s1: { totalCostUSD: 2 * OPUS_CALL }, s2: { totalCostUSD: OPUS_CALL } } });
        assert.deepEqual(summary.sessions, ["s1", "s2"]);
        assert.deepEqual(summary.crossCheck.map((check) => [check.session, check.flagged]), [["s1", false], ["s2", false]]);
        close(summary.crossCheck[1].ours, OPUS_CALL);
    });
});

describe("renderUsageSection", () => {
    const render = (calls = sample()) =>
        renderUsageSection(summarize(calls), { prices: testPrices(), pr: 7, generatedAt: "2026-11-26T12:00:00.000Z" });

    test("shows the totals, the roles, the extra rounds and where the prices come from", () => {
        const text = render();
        assert.match(text, /PR #7/);
        assert.match(text, /orchestrator/);
        assert.match(text, /implementer/);
        assert.match(text, /Fix confirmed findings/);
        assert.match(text, /API-equivalent/);
        assert.match(text, /2026-11-03/);
        assert.match(text, /\$0\.07/);
    });

    test("names a loop that never had a pull request apart from one not merged yet", () => {
        const summary = summarize();
        const options = { prices: testPrices(), pr: null, generatedAt: "2026-11-26T12:00:00.000Z" };
        assert.match(renderUsageSection(summary, options), /`feature\/x` \(no pull request merged yet\)/);
        assert.match(renderUsageSection(summary, { ...options, withoutPullRequest: true }), /`feature\/x` \(work without a pull request\)/);
    });

    test("says when the price is incomplete", () => {
        assert.match(render([...sample(), call({ id: "u1", timestamp: at(11), model: "claude-new-9" })]), /incomplete/i);
    });

    test("never shows a path, a user folder or a full session id", () => {
        const calls = sample().map((found) => ({
            ...found,
            sessionId: "0123456789abcdef-session",
            sessions: ["0123456789abcdef-session"],
            cwd: "<outside>",
            agentDescription: found.agentDescription && `${found.agentDescription} in C:\\Users\\someone\\notes.txt and /Users/someone/x`
        }));
        const text = render(calls);
        assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
        assert.doesNotMatch(text, /Users/);
        assert.doesNotMatch(text, /0123456789abcdef-session/);
    });

    test("hides a description that names a path in any form, and keeps a plain one", () => {
        const descriptions = [
            "Read D:\\Claude\\RAG Lab Data\\eval\\questions-q12.json",
            "Check /c/Users/someone/notes.md",
            "Look at ~/.claude/projects/x",
            "Open \\\\server\\share\\someone\\x",
            "Read docs\\private\\notes.md",
            "Open /home/someone/x"
        ];
        const calls = descriptions.map((description, index) =>
            call({ id: `p${index}`, timestamp: at(index), agentId: `a${index}`, role: "planner", agentDescription: description }));
        const text = render([...calls, call({ id: "plain", timestamp: at(20), agentId: "a-plain", role: "planner", agentDescription: "Plan layer 2" })]);
        for (const secret of ["Lab Data", "someone", "projects", "server", "private", "home/"]) {
            assert.ok(!text.includes(secret), `${secret} leaked:\n${text}`);
        }
        assert.match(text, /Plan layer 2/);
        assert.equal((text.match(/hidden: it named a path/g) ?? []).length, descriptions.length);
    });

    test("prints a role or model only when it is a plain name", () => {
        const text = render([call({ id: "r1", timestamp: at(0), agentId: "a1", role: "evil|role C:\\x", model: "claude|x" })]);
        assert.ok(!text.includes("evil|role"));
        assert.ok(!text.includes("claude|x"));
        assert.match(text, /\(invalid name\)/);
    });
});

describe("replaceBetweenMarkers", () => {
    test("creates the report from a template when the file does not exist", () => {
        const text = replaceBetweenMarkers(null, "USAGE", { name: "usage-report", title: "# PR #7: feature/x" });
        assert.match(text, /^# PR #7: feature\/x/);
        assert.match(text, /<!-- usage-report:start -->\nUSAGE\n<!-- usage-report:end -->/);
        assert.match(text, /Decisions the AI took without asking/);
    });

    test("replaces only the generated part and keeps what was written by hand", () => {
        const existing = "# Title\n\nHand notes.\n\n<!-- usage-report:start -->\nOLD\n<!-- usage-report:end -->\n\nMore notes.\n";
        assert.equal(replaceBetweenMarkers(existing, "NEW", { name: "usage-report" }),
            "# Title\n\nHand notes.\n\n<!-- usage-report:start -->\nNEW\n<!-- usage-report:end -->\n\nMore notes.\n");
    });

    test("appends the generated part to a file that has no markers", () => {
        assert.equal(replaceBetweenMarkers("# Title\n", "NEW", { name: "summary" }),
            "# Title\n\n<!-- summary:start -->\nNEW\n<!-- summary:end -->\n");
    });
});

describe("renderSummaryTable", () => {
    test("one row per pull request, in order, with the orchestrator's share", () => {
        const text = renderSummaryTable([
            { bucket: "feature/b", pr: 2, from: at(10), calls: 3, output: 30, cacheRead: 300, cost: 2, complete: true, orchestratorShare: 0.5 },
            { bucket: "setup", pr: null, from: at(0), calls: 1, output: 10, cacheRead: 100, cost: 1, complete: false, orchestratorShare: 1 },
            { bucket: "feature/a", pr: 1, from: at(5), calls: 2, output: 20, cacheRead: 200, cost: 1.5, complete: true, orchestratorShare: 0.25 }
        ]);
        const lines = text.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Loop"));
        assert.match(lines[0], /setup/);
        assert.match(lines[1], /#1 .*feature\/a/);
        assert.match(lines[2], /#2 .*feature\/b/);
        assert.match(lines[0], /incomplete/);
        assert.match(lines[1], /25 %/);
    });
});
