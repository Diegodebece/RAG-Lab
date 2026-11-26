import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { METRICS_DIR, agentLaunch, assistant, makeTempDir, writeTranscripts } from "./helpers.mjs";

let base;
let repository;
let projects;
let dataDir;
let gitEnvironment;

const SCRIPT = path.join(METRICS_DIR, "usage-report.mjs");

// A git repository of its own, with the global and system git settings left out, so the test controls them.
const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { cwd: repository, encoding: "utf8", env: gitEnvironment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};

const run = (args, env = { RAG_LAB_DATA_DIR: dataDir }) => {
    const environment = { ...process.env, ...env };
    if (!("RAG_LAB_DATA_DIR" in env)) {
        delete environment.RAG_LAB_DATA_DIR;
    }
    return spawnSync(process.execPath, [SCRIPT, ...args, "--repo", repository, "--transcripts", projects],
        { encoding: "utf8", env: environment, timeout: 30000 });
};

before(() => {
    base = makeTempDir("cli");
    repository = path.join(base, "Repo");
    projects = path.join(base, "projects");
    dataDir = path.join(base, "Repo Data");
    const emptyConfig = path.join(base, "gitconfig");
    fs.writeFileSync(emptyConfig, "");
    gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };

    fs.mkdirSync(repository);
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "Start");
    git("checkout", "-b", "feature/x");
    git("commit", "--allow-empty", "-m", "Work");
    git("checkout", "main");
    git("merge", "--no-ff", "feature/x", "-m", "Merge pull request #7 from owner/feature/x");

    const slug = repository.replace(/[^A-Za-z0-9]/g, "-");
    const cwd = repository;
    writeTranscripts(projects, {
        [`${slug}/s1.jsonl`]: [
            ...assistant({ id: "m1", at: "2026-01-01T10:00:00.000Z", sessionId: "s1", cwd, blocks: 2 }),
            ...agentLaunch({ toolUseId: "t1", agentId: "a1", subagentType: "planner", description: "Plan the feature", at: "2026-01-01T10:01:00.000Z", sessionId: "s1" })
        ],
        [`${slug}/s1/subagents/agent-a1.jsonl`]: assistant({ id: "m2", at: "2026-01-01T10:02:00.000Z", sessionId: "s1", cwd, agentId: "a1" }),
        [`${slug}/s1/subagents/agent-a1.meta.json`]: { agentType: "planner", description: "Plan the feature" }
    });
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("usage-report.mjs", () => {
    test("refuses to run without RAG_LAB_DATA_DIR", () => {
        const result = run(["collect"], {});
        assert.equal(result.status, 1);
        assert.match(result.stderr, /RAG_LAB_DATA_DIR/);
    });

    test("refuses a data folder inside the repository", () => {
        const result = run(["collect"], { RAG_LAB_DATA_DIR: path.join(repository, "data") });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /inside the repository/);
    });

    test("collect stores one row per call and a copy of the transcripts, the same when run twice", () => {
        const first = run(["collect"]);
        assert.equal(first.status, 0, first.stderr);
        const callsFile = path.join(dataDir, "usage", "calls.jsonl");
        const rows = fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(rows.map((row) => [row.id, row.role]), [["m1", "orchestrator"], ["msg-launch-t1", "orchestrator"], ["m2", "planner"]]);
        assert.ok(fs.readdirSync(path.join(dataDir, "usage", "transcripts")).length > 0);

        const before = fs.readFileSync(callsFile, "utf8");
        assert.equal(run(["collect"]).status, 0);
        assert.equal(fs.readFileSync(callsFile, "utf8"), before);
    });

    test("begin records the loop's start and session, and warns about a loop still open", () => {
        const first = run(["begin", "feature/x", "--at", "2026-01-01T09:00:00.000Z", "--session", "s1"]);
        assert.equal(first.status, 0, first.stderr);
        // after the session's calls, so they stay feature/x's
        const second = run(["begin", "feature/y", "--at", "2026-01-01T11:00:00.000Z"]);
        assert.equal(second.status, 0, second.stderr);
        // without --session, the newest session transcript is the current session
        assert.match(second.stdout, /session s1/);
        const markers = fs.readFileSync(path.join(dataDir, "usage", "loops.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(markers.map((marker) => [marker.branch, marker.sessionId]), [["feature/x", "s1"], ["feature/y", "s1"]]);
        // feature/x is merged in the git history, but only after feature/y began
        assert.match(second.stdout, /still open: feature\/x/);
    });

    test("begin asks for --session when more than one session is active", () => {
        const slug = repository.replace(/[^A-Za-z0-9]/g, "-");
        const other = path.join(projects, slug, "s2.jsonl");
        writeTranscripts(projects, { [`${slug}/s2.jsonl`]: [] });
        const result = run(["begin", "feature/w", "--at", "2026-01-01T12:00:00.000Z"]);
        fs.rmSync(other);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /--session/);
        assert.match(result.stderr, /s1.*s2|s2.*s1/);
        const markers = fs.readFileSync(path.join(dataDir, "usage", "loops.jsonl"), "utf8");
        assert.doesNotMatch(markers, /feature\/w/);
    });

    test("report writes the generated part of the pull request's process report", () => {
        const target = path.join(base, "docs", "process", "07-x.md");
        const result = run(["report", "feature/x", "--write", target]);
        assert.equal(result.status, 0, result.stderr);
        const text = fs.readFileSync(target, "utf8");
        assert.match(text, /^# PR #7: feature\/x/);
        assert.match(text, /<!-- usage-report:start -->/);
        assert.match(text, /planner/);
        assert.match(text, /Plan the feature/);
        assert.equal(result.stdout.trim().length > 0, true);
    });

    test("windows lists each loop with its calls, and summary writes the table of every loop", () => {
        const windows = run(["windows"]);
        assert.equal(windows.status, 0, windows.stderr);
        assert.match(windows.stdout, /feature\/x/);
        assert.match(windows.stdout, /PR #7/);

        // a loop made of several windows is listed once, with its windows and its calls
        const overrides = path.join(dataDir, "usage", "overrides.json");
        fs.writeFileSync(overrides, JSON.stringify({ windows: [
            { bucket: "setup", from: "2026-01-01T07:00:00.000Z", to: "2026-01-01T07:30:00.000Z" },
            { bucket: "setup", from: "2026-01-01T08:00:00.000Z", to: "2026-01-01T08:30:00.000Z" }
        ] }));
        const grouped = run(["windows"]);
        fs.rmSync(overrides);
        assert.equal(grouped.stdout.split("\n").filter((line) => line.startsWith("- setup")).length, 1, grouped.stdout);
        assert.match(grouped.stdout, /07:00.*07:30.*08:00.*08:30/);

        const target = path.join(base, "docs", "process", "README.md");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "# Process reports\n");
        const summary = run(["summary", "--write", target]);
        assert.equal(summary.status, 0, summary.stderr);
        assert.match(fs.readFileSync(target, "utf8"), /<!-- usage-summary:start -->[\s\S]*#7[\s\S]*<!-- usage-summary:end -->/);
    });

    test("reads the merges of origin/main too, for pull requests merged on GitHub and not pulled yet", () => {
        // origin/main is one merge ahead of the local main
        git("checkout", "-b", "remote-main");
        git("checkout", "-b", "feature/z");
        git("commit", "--allow-empty", "-m", "Remote work");
        git("checkout", "remote-main");
        git("merge", "--no-ff", "feature/z", "-m", "Merge pull request #8 from owner/feature/z");
        git("update-ref", "refs/remotes/origin/main", "remote-main");
        git("checkout", "main");
        assert.equal(run(["begin", "feature/z", "--at", "2026-01-01T13:00:00.000Z", "--session", "s9"]).status, 0);
        const windows = run(["windows"]);
        assert.equal(windows.status, 0, windows.stderr);
        assert.match(windows.stdout, /- feature\/z \(PR #8/);
        assert.match(windows.stdout, /- feature\/x \(PR #7/);
    });

    test("an unknown command prints the usage and fails", () => {
        const result = run(["frobnicate"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Usage/);
    });
});
