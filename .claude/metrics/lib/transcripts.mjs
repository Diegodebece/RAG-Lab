// Reads Claude Code's transcripts into one record per model call. Only numbers and names are kept: never the
// text of a message, a prompt or a tool result, because the transcripts are private.
//
// Layout (per project folder, named after the repository path):
//   <session>.jsonl                          the main session (the orchestrator)
//   <session>/subagents/agent-<id>.jsonl     an agent it launched
//   <session>/subagents/agent-<id>.meta.json the agent's type, description and model
// A session started inside a worktree has its own folder, named after the worktree path.

import fs from "node:fs";
import path from "node:path";

// Claude Code's folder name for a project: every character that is not a letter or a digit becomes "-".
export const projectSlug = (repositoryPath) => repositoryPath.replace(/[^A-Za-z0-9]/g, "-");

const listDirectory = (folder) => {
    try {
        return fs.readdirSync(folder, { withFileTypes: true });
    } catch {
        return [];
    }
};

// The transcript files of this project and then of the sessions started in its worktrees, each sorted by path.
export const findTranscriptFiles = (projectsDir, slug) => {
    const files = [];
    const projectFolders = listDirectory(projectsDir)
        .filter((entry) => entry.isDirectory() && (entry.name === slug || entry.name.startsWith(`${slug}--claude-worktrees-`)));

    for (const project of projectFolders) {
        const projectPath = path.join(projectsDir, project.name);
        for (const entry of listDirectory(projectPath)) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                const session = entry.name.slice(0, -".jsonl".length);
                files.push({ path: path.join(projectPath, entry.name), relative: `${project.name}/${entry.name}`, session, agentId: null });
            }
            if (entry.isDirectory()) {
                const subagents = path.join(projectPath, entry.name, "subagents");
                for (const agentFile of listDirectory(subagents)) {
                    const match = agentFile.isFile() && agentFile.name.match(/^agent-(.+)\.jsonl$/);
                    if (match) {
                        files.push({
                            path: path.join(subagents, agentFile.name),
                            relative: `${project.name}/${entry.name}/subagents/${agentFile.name}`,
                            session: entry.name,
                            agentId: match[1]
                        });
                    }
                }
            }
        }
    }
    const key = (file) => `${file.relative.startsWith(`${slug}/`) ? 0 : 1}${file.relative}`;
    return files.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
};

const readRows = (filePath, stats) => {
    const rows = [];
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch {
        return rows;
    }
    for (const line of text.split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            stats.malformed++;
            continue;
        }
        if (row !== null && typeof row === "object" && !Array.isArray(row)) {
            rows.push(row);
        } else {
            stats.malformed++;
        }
    }
    return rows;
};

const readMeta = (agentFilePath) => {
    try {
        return JSON.parse(fs.readFileSync(agentFilePath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    } catch {
        return null;
    }
};

// The working folder relative to the repository, with forward slashes; "<outside>" for any other folder.
// Compared as text, ignoring letter case, because Windows paths are case-insensitive.
export const relativeFolder = (cwd, repoRoot) => {
    const normalize = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const folder = normalize(cwd);
    const root = normalize(repoRoot);
    if (folder.toLowerCase() === root.toLowerCase()) {
        return ".";
    }
    if (root !== "" && folder.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        return folder.slice(root.length + 1);
    }
    return "<outside>";
};

const count = (value) => (Number.isFinite(value) ? value : 0);

const COUNTED_FIELDS = ["input", "output", "thinking", "cacheWrite5m", "cacheWrite1h", "cacheRead", "webSearch", "webFetch"];

// The call of an assistant row, or null when its time is not a date. Times are stored in UTC, so they compare as text.
const toCall = (row, file, repoRoot) => {
    const time = new Date(row.timestamp);
    if (typeof row.timestamp !== "string" || Number.isNaN(time.getTime())) {
        return null;
    }
    const usage = row.message.usage;
    const split = usage.cache_creation;
    const write1h = count(split?.ephemeral_1h_input_tokens);
    const write5m = split ? count(split.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens);
    return {
        id: row.message.id,
        timestamp: time.toISOString(),
        sessionId: row.sessionId ?? file.session,
        sessions: [file.session],
        agentId: file.agentId,
        role: file.agentId ? null : "orchestrator",
        agentDescription: null,
        attributionAgent: file.agentId && typeof row.attributionAgent === "string" ? row.attributionAgent : null,
        model: row.message.model,
        speed: usage.speed ?? "standard",
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        thinking: count(usage.output_tokens_details?.thinking_tokens),
        cacheWrite5m: write5m,
        cacheWrite1h: write1h,
        cacheRead: count(usage.cache_read_input_tokens),
        webSearch: count(usage.server_tool_use?.web_search_requests),
        webFetch: count(usage.server_tool_use?.web_fetch_requests),
        cwd: relativeFolder(row.cwd, repoRoot),
        gitBranch: row.gitBranch ?? null
    };
};

// Agent launches in a parent transcript: the Agent tool call (type and description) joined to its result (agentId).
const collectLaunches = (rows, launches) => {
    const toolCalls = new Map();
    for (const row of rows) {
        if (row.type === "assistant" && Array.isArray(row.message?.content)) {
            for (const block of row.message.content) {
                if (block?.type === "tool_use" && block.name === "Agent") {
                    toolCalls.set(block.id, { role: block.input?.subagent_type ?? null, description: block.input?.description ?? null });
                }
            }
        }
    }
    for (const row of rows) {
        const agentId = row.type === "user" ? row.toolUseResult?.agentId : undefined;
        if (typeof agentId !== "string" || !Array.isArray(row.message?.content)) {
            continue;
        }
        for (const block of row.message.content) {
            const launch = block?.type === "tool_result" ? toolCalls.get(block.tool_use_id) : undefined;
            if (launch && !launches.has(agentId)) {
                launches.set(agentId, launch);
            }
        }
    }
};

// Reads every file and returns one record per model call (deduplicated by message id), Claude Code's own latest
// cost estimate of each session, and counts of what was read and skipped.
export const readCalls = (files, { repoRoot }) => {
    const stats = { files: files.length, rows: 0, unique: 0, malformed: 0, skipped: 0 };
    const calls = new Map();
    const metas = new Map();
    const launches = new Map();
    const costStates = {};

    for (const file of files) {
        const rows = readRows(file.path, stats);
        if (file.agentId) {
            const meta = readMeta(file.path);
            if (meta?.agentType && !metas.has(file.agentId)) {
                metas.set(file.agentId, meta);
            }
        } else {
            collectLaunches(rows, launches);
        }
        for (const row of rows) {
            if (row.type === "cost-state" && typeof row.sessionId === "string" && Number.isFinite(row.totalCostUSD)) {
                costStates[row.sessionId] = { totalCostUSD: row.totalCostUSD };
            }
            if (row.type !== "assistant" || !row.message?.usage || typeof row.message.id !== "string") {
                continue;
            }
            stats.rows++;
            if (row.message.model === "<synthetic>" || row.isApiErrorMessage) {
                stats.skipped++;
                continue;
            }
            const fresh = toCall(row, file, repoRoot);
            if (!fresh) {
                stats.skipped++;
                continue;
            }
            const existing = calls.get(row.message.id);
            if (existing) {
                // the rows of one message carry the same usage today; if a row was ever written mid-answer, the
                // largest count of each field is the final one
                for (const field of COUNTED_FIELDS) {
                    existing[field] = Math.max(existing[field], fresh[field]);
                }
                if (!existing.sessions.includes(file.session)) {
                    existing.sessions.push(file.session);
                }
                existing.attributionAgent ??= fresh.attributionAgent;
                continue;
            }
            calls.set(row.message.id, fresh);
        }
    }

    for (const found of calls.values()) {
        if (found.agentId) {
            const meta = metas.get(found.agentId);
            const launch = launches.get(found.agentId);
            found.role = meta?.agentType ?? found.attributionAgent ?? launch?.role ?? "unknown-agent";
            found.agentDescription = meta?.description ?? launch?.description ?? null;
        }
        delete found.attributionAgent;
        found.sessions.sort();
    }
    stats.unique = calls.size;
    const sorted = [...calls.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return { calls: sorted, costStates, stats };
};
