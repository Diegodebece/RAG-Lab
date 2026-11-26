// PreToolUse hook of every RAG Lab subagent (.claude/agents/*.md), called with the agent's role as its argument:
//   node .claude/hooks/agent-scope.mjs <role>
// It enforces the "Allowed" column of the agent team in docs/design.md (section 8): what each agent may read,
// write and run. Prompts describe the limits; this hook is what holds them.
//
// Places a path can be in:
// - project:   this repository, minus secrets (.env), .git, local settings, worktrees and private-data folders;
//              for an agent working in a worktree (.claude/worktrees/<name>), that worktree instead;
// - code:      only src/, test/, migrations/, node_modules/ and a few config files (the independent auditors and
//              the verifier, so they judge the code and not the author's notes);
// - reference: RAG Web's code, tests, skills and docs (RAG_WEB_DIR), for porting; never its .env or RAG1's data;
// - data:      the private data folder outside the repository (RAG_LAB_DATA_DIR): evaluation sets and results.
// RAG_WEB_DIR and RAG_LAB_DATA_DIR come from the environment or from the main checkout's .env.
//
// GitHub: subagents never push, fetch or use gh, whatever their role; test-writer and implementer may commit in
// their own worktree. Only the orchestrator (the main session, which has no agent-scope hook) pushes feature/*
// branches, opens pull requests and answers comments.
//
// Limits: this hook checks tool calls. Code that an agent runs through an allowed command (a test, an eval
// script) is not sandboxed by it.

import fs from "node:fs";
import path from "node:path";
import { deny, runHook } from "./lib/hook-io.mjs";
import { findProgram, splitCommands } from "./lib/shell.mjs";

const ARGS = String.raw`(?: [\w./:=@*,+%"'\\-]+)*`;
const DEV_TEST_COMMANDS = [
    new RegExp(`^npm (test|t)${ARGS}$`),
    new RegExp(`^npm run test(:[\\w-]+)?${ARGS}$`),
    new RegExp(`^npm run typecheck${ARGS}$`),
    new RegExp(`^node --test${ARGS}$`),
    new RegExp(`^git (status|diff|log|show)${ARGS}$`),
    // subagents commit their work in their own worktree; the orchestrator pushes it
    new RegExp(`^git (add|commit)${ARGS}$`)
];
// commit options that skip the git hooks or rewrite a commit already made
// (-n may be grouped with other short options, as in -nm)
const FORBIDDEN_COMMIT_ARGUMENTS = /^git commit( .*)? (--no-verify|-[a-zA-Z]*n[a-zA-Z]*|--amend|--fixup(=\S*)?|--squash(=\S*)?)( |$)/;
// git subcommands that talk to a remote or change one: only the orchestrator pushes and fetches
const GIT_REMOTE_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "remote", "ls-remote", "submodule", "request-pull", "send-email"]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const ORCHESTRATOR_ONLY = "Only the orchestrator pushes, opens pull requests and answers comments; commit in your worktree and report back.";
const DEV_IMPLEMENT_COMMANDS = [...DEV_TEST_COMMANDS, new RegExp(`^npm run (build|lint)(:[\\w-]+)?${ARGS}$`)];
const EVAL_COMMANDS = [new RegExp(`^npm run eval(:[\\w-]+)?${ARGS}$`)];
// arguments that would make an allowed command run other code, write files or read another npm configuration
const FORBIDDEN_ARGUMENTS = /(^| )(--script-shell|--node-options|--prefix|--userconfig|--globalconfig|--import|--require|--eval|--print|--loader|--experimental-loader|--output|--ext-diff|--textconv)(=| |$)/;
// short node options that evaluate code or preload a module
const FORBIDDEN_NODE_ARGUMENTS = / (-r|-e|-p|-i)( |$)/;

const ROLES = {
    "planner": { read: ["project", "reference"] },
    "test-writer": { read: ["project", "reference"], write: [["test"]], commands: DEV_TEST_COMMANDS },
    "implementer": { read: ["project", "reference"], write: [["src"], ["migrations"]], commands: DEV_IMPLEMENT_COMMANDS },
    "code-auditor": { read: ["code"] },
    "owasp-auditor": { read: ["code"] },
    "finding-verifier": { read: ["code"] },
    "experiment-runner": { read: ["project", "data"], commands: EVAL_COMMANDS },
    "lab-reporter": { read: ["project", "data"], write: [["docs", "experiments"]], appendOnly: true },
    "analyst": { read: ["project", "data"] },
    "docs-keeper": {
        read: ["project", "reference"],
        write: [["docs"], ["readme.md"], [".env.example"], [".claude", "skills"]],
        writeExcluded: [["docs", "experiments"]]
    }
};

// Tools that only hand text back to the caller.
const HANDBACK_TOOLS = new Set(["SubagentHandback", "StructuredOutput"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// Top-level entries of this repository nobody reads: git internals and copies of private data.
const PROJECT_BLOCKED_TOP = new Set([".git", "data", "results", "eval-data", "rag project", "pgdata"]);
const CODE_DIRECTORIES = new Set(["src", "test", "migrations", "node_modules"]);
const CODE_FILES = new Set([
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.test.json", "docker-compose.yml", "dockerfile",
    ".env.example", ".gitignore"
]);
const REFERENCE_DIRECTORIES = new Set(["src", "test", "migrations", "scripts", "docs"]);
const REFERENCE_CLAUDE_DIRECTORIES = new Set(["skills", "agents", "hooks"]);
const REFERENCE_FILES = new Set([
    "claude.md", "readme.md", "package.json", "tsconfig.json", "tsconfig.test.json", ".env.example",
    "docker-compose.yml", "dockerfile", ".gitignore"
]);
const LEADERBOARD = ["docs", "experiments", "leaderboard.md"];

const isSecretName = (name) =>
    (/^\.env(\..*)?$/.test(name) && name !== ".env.example") || /\.(pem|key|p12|pfx)$/.test(name)
    || /-cheatsheet\.txt$/.test(name) || name === "cv-context.md";

// The value of a setting, from the environment or from the project's .env.
const readSetting = (projectDir, key) => {
    if (process.env[key]) {
        return process.env[key];
    }
    try {
        for (const line of fs.readFileSync(path.join(projectDir, ".env"), "utf8").split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
            if (match && match[1] === key) {
                return match[2].replace(/^(["'])(.*)\1$/, "$2") || null;
            }
        }
    } catch {
        // no .env: the setting is simply missing
    }
    return null;
};

// The lower-case path components of `target` below `root`, [] for the root itself, or null when outside it.
const partsBelow = (root, target) => {
    if (!root) {
        return null;
    }
    const relative = path.relative(path.resolve(root), target);
    if (relative === "") {
        return [];
    }
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return null;
    }
    return relative.split(path.sep).map((part) => part.toLowerCase());
};

const startsWith = (parts, prefix) => prefix.every((part, index) => parts[index] === part);

// The root of the worktree that `cwd` is in (.claude/worktrees/<name> below the main checkout `root`), or null.
// Claude Code sets CLAUDE_PROJECT_DIR to the main checkout even for an agent working in a worktree.
const worktreeRoot = (root, cwd) => {
    const parts = partsBelow(root, path.resolve(cwd));
    if (parts === null || parts.length < 3 || parts[0] !== ".claude" || parts[1] !== "worktrees") {
        return null;
    }
    return path.join(path.resolve(root), ...path.relative(path.resolve(root), path.resolve(cwd)).split(path.sep).slice(0, 3));
};

const isReadableProjectPath = (parts) => {
    if (parts.length === 0) {
        return true;
    }
    if (PROJECT_BLOCKED_TOP.has(parts[0]) || parts.some(isSecretName)) {
        return false;
    }
    if (parts[0] === ".claude" && (parts[1] === "settings.local.json" || parts[1] === "worktrees")) {
        return false;
    }
    return true;
};

const isCodePath = (parts) =>
    parts.length > 0 && !parts.some(isSecretName)
    && (CODE_DIRECTORIES.has(parts[0]) || (parts.length === 1 && CODE_FILES.has(parts[0])));

const isReferencePath = (parts) => {
    if (parts.length === 0 || parts.some(isSecretName)) {
        return false;
    }
    if (parts.length === 1) {
        return REFERENCE_FILES.has(parts[0]) || REFERENCE_DIRECTORIES.has(parts[0]);
    }
    return REFERENCE_DIRECTORIES.has(parts[0]) || (parts[0] === ".claude" && REFERENCE_CLAUDE_DIRECTORIES.has(parts[1]));
};

// Whether a file with a secret name sits anywhere below `folder` (symbolic links are not followed, as in Grep).
const hasSecretBelow = (folder) => {
    let entries;
    try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
        return false;
    }
    return entries.some((entry) => isSecretName(entry.name.toLowerCase())
        || (entry.isDirectory() && hasSecretBelow(path.join(folder, entry.name))));
};

// Where `target` is and whether the role may read it. `search` is "Grep" or "Glob" for search paths, null for
// Read: a search of a whole root would read through the blocked files too, except in the data folder, which is
// readable entirely. In RAG Web, Grep reads file contents, so it may not search a folder that holds a secret
// file (for example a cheatsheet in docs/); Glob only lists names.
const canRead = (policy, places, target, search) => {
    const projectParts = partsBelow(places.project, target);
    const dataParts = partsBelow(places.data, target);
    const referenceParts = partsBelow(places.reference, target);

    // the data folder may sit inside the project or next to it; check it first
    if (dataParts !== null && policy.read.includes("data")) {
        return !dataParts.some(isSecretName);
    }
    if (projectParts !== null) {
        if (policy.read.includes("code")) {
            return isCodePath(projectParts);
        }
        if (search && projectParts.length === 0) {
            return false;
        }
        return policy.read.includes("project") && isReadableProjectPath(projectParts);
    }
    if (referenceParts !== null && policy.read.includes("reference")) {
        return isReferencePath(referenceParts) && !(search === "Grep" && hasSecretBelow(target));
    }
    return false;
};

const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n");

// lab-reporter: the notebook only grows. Edits may insert text but never remove it; a whole-file write must keep
// the old content as its beginning. The leaderboard is the exception: it is a ranking that gets reordered.
const checkAppendOnly = (toolName, toolInput, target, parts) => {
    if (parts.length === LEADERBOARD.length && startsWith(parts, LEADERBOARD)) {
        return null;
    }
    if (toolName === "Edit") {
        const oldText = String(toolInput.old_string ?? "");
        const newText = String(toolInput.new_string ?? "");
        return oldText !== "" && newText.includes(oldText)
            ? null
            : "The lab notebook is append-only: an edit must keep the text it replaces (insert, never remove).";
    }
    if (toolName === "Write") {
        if (!fs.existsSync(target)) {
            return null;
        }
        const existing = normalizeNewlines(fs.readFileSync(target, "utf8")).trimEnd();
        return normalizeNewlines(String(toolInput.content ?? "")).startsWith(existing)
            ? null
            : "The lab notebook is append-only: rewriting a file must keep its old content as the beginning.";
    }
    return `${toolName} is not allowed in the lab notebook.`;
};

const checkWrite = (policy, places, toolName, toolInput) => {
    if (toolName === "NotebookEdit" || toolName === "MultiEdit") {
        return `${toolName} is not allowed for this agent.`;
    }
    const filePath = String(toolInput.file_path ?? "");
    const target = path.resolve(places.cwd, filePath);
    const parts = partsBelow(places.project, target);

    if (!filePath || parts === null || parts.length === 0 || !isReadableProjectPath(parts)) {
        return `Writing ${filePath || "that path"} is not allowed.`;
    }
    const inScope = (policy.write ?? []).some((prefix) => startsWith(parts, prefix))
        && !(policy.writeExcluded ?? []).some((prefix) => startsWith(parts, prefix));
    if (!inScope) {
        const scope = (policy.write ?? []).map((prefix) => prefix.join("/")).join(", ") || "nothing";
        return `Writing ${filePath} is outside this agent's scope (it may write: ${scope}).`;
    }
    return policy.appendOnly ? checkAppendOnly(toolName, toolInput, target, parts) : null;
};

// Why a command reaches GitHub or a remote, or null. Checked for every role before its allowlist, so the rule
// holds even if an allowlist grows: subagents never push, fetch or use gh.
const findRemoteAccess = (command) => {
    for (const segment of splitCommands(command)) {
        const tokens = segment.map((token) => token.text);
        if (findProgram(segment, new Set(["gh"])) !== -1) {
            return "Subagents may not use the gh CLI.";
        }
        const gitIndex = findProgram(segment, new Set(["git"]));
        if (gitIndex === -1) {
            continue;
        }
        let index = gitIndex + 1;
        while (index < tokens.length && tokens[index].startsWith("-")) {
            index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
        }
        if (GIT_REMOTE_SUBCOMMANDS.has(tokens[index])) {
            return `Subagents may not run "git ${tokens[index]}".`;
        }
    }
    return null;
};

const checkCommand = (policy, command) => {
    const remoteAccess = findRemoteAccess(command);
    if (remoteAccess) {
        return `${remoteAccess} ${ORCHESTRATOR_ONLY}`;
    }
    if (!policy.commands) {
        return "This agent may not run commands.";
    }
    const trimmed = command.trim();
    if (/[<>|;&`$(){}\r\n]/.test(trimmed.replace(/&&/g, ""))) {
        return "Redirections, pipes, variables, subshells and command separators other than && are not allowed.";
    }
    for (const part of trimmed.split("&&").map((piece) => piece.trim().replace(/\s+/g, " "))) {
        if (FORBIDDEN_ARGUMENTS.test(part) || (part.startsWith("node ") && FORBIDDEN_NODE_ARGUMENTS.test(part))) {
            return `"${part}" uses an argument that could run other code or write files.`;
        }
        if (FORBIDDEN_COMMIT_ARGUMENTS.test(part)) {
            return `"${part}" skips the git hooks or rewrites an earlier commit.`;
        }
        if (!policy.commands.some((pattern) => pattern.test(part))) {
            return `"${part}" is not one of this agent's allowed commands.`;
        }
    }
    return null;
};

const hasEscapingPattern = (pattern) => pattern.includes("..") || path.isAbsolute(pattern) || /^[a-z]:/i.test(pattern);

await runHook(async (input) => {
    const role = process.argv[2] ?? "";
    const policy = Object.hasOwn(ROLES, role) ? ROLES[role] : null;
    const toolName = String(input.tool_name ?? "");
    const toolInput = input.tool_input ?? {};

    if (!policy) {
        deny(`Unknown agent role "${role}": every tool call is blocked.`);
    }

    // An agent working in a worktree has that worktree as its project: it cannot reach the main checkout or
    // another worktree. The settings still come from the main checkout's .env, since worktrees have none.
    const root = process.env.CLAUDE_PROJECT_DIR || String(input.cwd ?? "") || process.cwd();
    const cwd = String(input.cwd ?? "") || root;
    const places = {
        project: worktreeRoot(root, cwd) ?? root,
        cwd,
        data: readSetting(root, "RAG_LAB_DATA_DIR"),
        reference: readSetting(root, "RAG_WEB_DIR")
    };
    const prefix = `[${role}]`;

    if (HANDBACK_TOOLS.has(toolName)) {
        return;
    }

    if (toolName === "Read") {
        const filePath = String(toolInput.file_path ?? "");
        if (!filePath || !canRead(policy, places, path.resolve(places.cwd, filePath), null)) {
            deny(`${prefix} Reading ${filePath || "that file"} is outside this agent's scope.`);
        }
        return;
    }

    if (toolName === "Grep" || toolName === "Glob") {
        const searchPath = path.resolve(places.cwd, String(toolInput.path ?? "") || ".");
        const pattern = String((toolName === "Glob" ? toolInput.pattern : toolInput.glob) ?? "");
        if (hasEscapingPattern(pattern) || !canRead(policy, places, searchPath, toolName)) {
            deny(`${prefix} ${toolName} needs a "path" to a folder this agent may read (for example "src" or "docs"), with no private files below it for Grep, and a pattern that stays inside it.`);
        }
        return;
    }

    if (WRITE_TOOLS.has(toolName)) {
        const reason = checkWrite(policy, places, toolName, toolInput);
        if (reason) {
            deny(`${prefix} ${reason}`);
        }
        return;
    }

    if (SHELL_TOOLS.has(toolName)) {
        const reason = checkCommand(policy, String(toolInput.command ?? ""));
        if (reason) {
            deny(`${prefix} ${reason}`);
        }
        return;
    }

    deny(`${prefix} The ${toolName} tool is not part of this agent's job.`);
});
