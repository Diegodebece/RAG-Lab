#!/usr/bin/env node
// Token usage and API-equivalent cost of each loop (pull request), from Claude Code's transcripts.
// No dependencies; run by the orchestrator, out of the agents' reach (like the hooks). See docs/process/README.md.
//
//   node .claude/metrics/usage-report.mjs begin <branch> [--session <id>] [--at <ISO time>]
//   node .claude/metrics/usage-report.mjs collect
//   node .claude/metrics/usage-report.mjs windows
//   node .claude/metrics/usage-report.mjs report <branch> [--write docs/process/NN-name.md]
//   node .claude/metrics/usage-report.mjs summary [--write docs/process/README.md]
//
// Options: --repo <main checkout> (default: found with git), --transcripts <Claude Code projects folder>
// (default: ~/.claude/projects). Everything it stores goes to RAG_LAB_DATA_DIR/usage, never into the repository.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attribute, buildWindows, findOverlaps, parseMerges, pullRequestOf } from "./lib/attribution.mjs";
import { loadPrices } from "./lib/pricing.mjs";
import { renderSummaryTable, renderUsageSection, replaceBetweenMarkers, summarizeBucket } from "./lib/report.mjs";
import {
    appendMarker, assertOutsideRepository, mergeCalls, readJson, readJsonl, readMarkers, readOverrides, snapshotTranscripts,
    usageDir, writeJson, writeJsonl
} from "./lib/storage.mjs";
import { findTranscriptFiles, projectSlug, readCalls } from "./lib/transcripts.mjs";

const USAGE = `Usage:
  node .claude/metrics/usage-report.mjs begin <branch> [--session <id>] [--at <ISO time>]
  node .claude/metrics/usage-report.mjs collect
  node .claude/metrics/usage-report.mjs windows
  node .claude/metrics/usage-report.mjs report <branch> [--write <file>]
  node .claude/metrics/usage-report.mjs summary [--write <file>]
Options: --repo <main checkout>, --transcripts <Claude Code projects folder>`;

const VALUE_OPTIONS = new Set(["--repo", "--transcripts", "--session", "--at", "--write"]);

const parseArguments = (argv) => {
    const positional = [];
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (VALUE_OPTIONS.has(argument)) {
            if (index + 1 >= argv.length) {
                throw new Error(`${argument} needs a value.\n${USAGE}`);
            }
            options[argument.slice(2)] = argv[++index];
        } else if (argument.startsWith("--")) {
            throw new Error(`Unknown option ${argument}.\n${USAGE}`);
        } else {
            positional.push(argument);
        }
    }
    return { command: positional[0], args: positional.slice(1), options };
};

const git = (repoRoot, args) => spawnSync("git", repoRoot ? ["-C", repoRoot, ...args] : args, { encoding: "utf8" });

// The main checkout, even when run from a worktree: the folder that holds the shared .git.
const findRepository = () => {
    const result = git(null, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (result.status !== 0) {
        throw new Error("Not inside a git repository; pass --repo <main checkout>.");
    }
    return path.dirname(path.resolve(result.stdout.trim()));
};

// A setting from the environment or from the main checkout's .env, as the hooks read it.
const readSetting = (repoRoot, key) => {
    if (process.env[key]) {
        return process.env[key];
    }
    try {
        for (const line of fs.readFileSync(path.join(repoRoot, ".env"), "utf8").split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
            if (match && match[1] === key) {
                return match[2].replace(/^(["'])(.*)\1$/, "$2") || null;
            }
        }
    } catch {
        // no .env: the setting is missing
    }
    return null;
};

// The pull request merges of main and of origin/main: the owner merges on GitHub, and the local main may not have
// been pulled yet.
const readMerges = (repoRoot) => {
    const merges = new Map();
    let read = 0;
    for (const ref of ["main", "origin/main"]) {
        const result = git(repoRoot, ["log", "--merges", "--first-parent", "--format=%H%x09%cI%x09%s", ref, "--"]);
        if (result.status !== 0) {
            continue;
        }
        read++;
        for (const merge of parseMerges(result.stdout)) {
            merges.set(merge.pr, merge);
        }
    }
    if (read === 0) {
        process.stderr.write("Warning: could not read the merges of main or origin/main; every loop counts as open.\n");
    }
    return [...merges.values()];
};

// Sessions whose transcripts changed within this long of the newest one count as active at the same time.
const ACTIVE_SESSION_WINDOW_MS = 10 * 60 * 1000;

// The session that runs `begin`: the newest main transcript, unless another one is active too.
const currentSession = (ctx) => {
    const sessions = findTranscriptFiles(ctx.transcriptsDir, ctx.slug)
        .filter((file) => file.agentId === null)
        .map((file) => ({ session: file.session, modified: fs.statSync(file.path).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
    if (sessions.length === 0) {
        return null;
    }
    const active = sessions.filter((entry) => sessions[0].modified - entry.modified <= ACTIVE_SESSION_WINDOW_MS);
    if (active.length > 1) {
        throw new Error(`More than one session is active (${active.map((entry) => entry.session).join(", ")}): pass --session <id> with this session's id.`);
    }
    return sessions[0].session;
};

const context = (options) => {
    const repoRoot = path.resolve(options.repo ?? findRepository());
    const dataDir = readSetting(repoRoot, "RAG_LAB_DATA_DIR");
    if (!dataDir) {
        throw new Error("RAG_LAB_DATA_DIR is not set (environment or the main checkout's .env): it is where the usage records are kept.");
    }
    assertOutsideRepository(dataDir, repoRoot);
    const transcriptsDir = path.resolve(options.transcripts ?? path.join(os.homedir(), ".claude", "projects"));
    return { repoRoot, dataDir: path.resolve(dataDir), transcriptsDir, slug: projectSlug(repoRoot) };
};

const callsFile = (dataDir) => path.join(usageDir(dataDir), "calls.jsonl");
const costStateFile = (dataDir) => path.join(usageDir(dataDir), "cost-state.json");

const loadAttribution = (ctx) => {
    const calls = readJsonl(callsFile(ctx.dataDir));
    const markers = readMarkers(ctx.dataDir);
    const overrides = readOverrides(ctx.dataDir);
    const merges = readMerges(ctx.repoRoot);
    const windows = buildWindows({ markers, merges, overrides });
    const attributions = attribute(calls, { windows, markers, overrides });
    return { calls, markers, overrides, merges, windows, attributions };
};

const prices = () => loadPrices(path.join(import.meta.dirname, "prices.json"));


const writeFile = (target, text) => {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, text);
};

const readOptional = (target) => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null);

const commands = {
    collect: (ctx) => {
        const files = findTranscriptFiles(ctx.transcriptsDir, ctx.slug);
        const { calls, costStates, stats } = readCalls(files, { repoRoot: ctx.repoRoot });
        const merged = mergeCalls(readJsonl(callsFile(ctx.dataDir)), calls);
        writeJsonl(callsFile(ctx.dataDir), merged);
        writeJson(costStateFile(ctx.dataDir), { ...readJson(costStateFile(ctx.dataDir), {}), ...costStates });
        const snapshot = snapshotTranscripts(files, path.join(usageDir(ctx.dataDir), "transcripts"));
        console.log(`Read ${stats.files} transcript files: ${stats.rows} rows, ${stats.unique} model calls (${stats.malformed} broken lines, ${stats.skipped} synthetic or error rows skipped).`);
        console.log(`calls.jsonl holds ${merged.length} calls. Copied ${snapshot.copied} transcript files (${snapshot.unchanged} already up to date).`);
    },

    begin: (ctx, [branch], options) => {
        if (!branch || /\s/.test(branch)) {
            throw new Error(`begin needs a branch name.\n${USAGE}`);
        }
        const at = options.at ? new Date(options.at).toISOString() : new Date().toISOString();
        const sessionId = options.session ?? currentSession(ctx);
        appendMarker(ctx.dataDir, { type: "begin", branch, at, sessionId });
        console.log(`Loop ${branch} begins at ${at} in session ${sessionId ?? "(none found)"}.`);
        const windows = buildWindows({ markers: readMarkers(ctx.dataDir), merges: readMerges(ctx.repoRoot), overrides: readOverrides(ctx.dataDir) });
        const open = windows.filter((window) => window.bucket !== branch && window.from <= at && (window.to === null || at < window.to));
        if (open.length > 0) {
            console.log(`Warning: another loop is still open: ${open.map((window) => window.bucket).join(", ")}. Calls outside this session in the overlap are attributed by worktree or left ambiguous.`);
        }
    },

    windows: (ctx) => {
        const { calls, windows, attributions } = loadAttribution(ctx);
        const counts = new Map();
        for (const decision of attributions.values()) {
            const key = decision.bucket ?? decision.rule;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        console.log(`${calls.length} calls in calls.jsonl.`);
        for (const bucket of [...new Set(windows.map((window) => window.bucket))]) {
            const ofBucket = windows.filter((window) => window.bucket === bucket);
            const pr = ofBucket.find((window) => window.pr)?.pr;
            const sources = [...new Set(ofBucket.map((window) => window.source))].join(", ");
            const spans = ofBucket.map((window) => `${window.from} to ${window.to ?? "open"}`).join("; ");
            console.log(`- ${bucket} (${pr ? `PR #${pr}` : "no pull request"}, ${sources}): ${counts.get(bucket) ?? 0} calls; ${spans}`);
        }
        const ambiguous = [...attributions.values()].filter((decision) => decision.rule === "ambiguous");
        const candidates = [...new Set(ambiguous.map((decision) => decision.candidates.join(" or ")))];
        console.log(`Ambiguous: ${ambiguous.length} calls${candidates.length ? ` (${candidates.join("; ")})` : ""}. Unattributed: ${counts.get("unattributed") ?? 0} calls.`);
        for (const [a, b] of findOverlaps(windows)) {
            console.log(`Overlap: ${a} and ${b} were open at the same time.`);
        }
    },

    report: (ctx, [branch], options) => {
        if (!branch) {
            throw new Error(`report needs a branch name.\n${USAGE}`);
        }
        const { calls, windows, attributions } = loadAttribution(ctx);
        const priceTable = prices();
        const costStates = readJson(costStateFile(ctx.dataDir), {});
        const summary = summarizeBucket({ calls, attributions, bucket: branch, prices: priceTable, costStates });
        const pr = pullRequestOf(branch, windows);
        // a bucket defined only by manual windows, with no pull request, is work that never had one (such as setup)
        const ofBucket = windows.filter((window) => window.bucket === branch);
        const withoutPullRequest = !pr && ofBucket.length > 0 && ofBucket.every((window) => window.source === "override");
        const section = renderUsageSection(summary, { prices: priceTable, pr, withoutPullRequest, generatedAt: new Date().toISOString() });
        if (options.write) {
            const title = pr ? `# PR #${pr}: ${branch}` : `# ${branch}`;
            writeFile(options.write, replaceBetweenMarkers(readOptional(options.write), section, { name: "usage-report", title }));
        }
        console.log(section);
    },

    summary: (ctx, _args, options) => {
        const { calls, windows, attributions } = loadAttribution(ctx);
        const priceTable = prices();
        const rows = [...new Set(windows.map((window) => window.bucket))].map((bucket) => {
            const summary = summarizeBucket({ calls, attributions, bucket, prices: priceTable });
            const orchestrator = summary.byRole.find((row) => row.role === "orchestrator");
            return {
                bucket, pr: pullRequestOf(bucket, windows), from: summary.from ?? windows.find((window) => window.bucket === bucket).from,
                calls: summary.totals.calls, output: summary.totals.output, cacheRead: summary.totals.cacheRead,
                cost: summary.totals.cost, complete: summary.totals.complete, orchestratorShare: orchestrator?.share ?? 0
            };
        });
        const table = renderSummaryTable(rows);
        if (options.write) {
            writeFile(options.write, replaceBetweenMarkers(readOptional(options.write), table, { name: "usage-summary", title: "# Process reports" }));
        }
        console.log(table);
    }
};

try {
    const { command, args, options } = parseArguments(process.argv.slice(2));
    if (!Object.hasOwn(commands, command ?? "")) {
        throw new Error(USAGE);
    }
    commands[command](context(options), args, options);
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
}
