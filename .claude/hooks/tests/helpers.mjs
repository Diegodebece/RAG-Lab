// Runs a hook script the way Claude Code does: the tool call as JSON on stdin, the decision as JSON on stdout.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The settings the hooks read from the environment are removed, so each test controls them.
const baseEnv = () => {
    const env = { ...process.env };
    delete env.RAG_LAB_DATA_DIR;
    delete env.RAG_WEB_DIR;
    delete env.CLAUDE_PROJECT_DIR;
    return env;
};

// Returns "allow" (no output), "deny" or "ask", plus the reason.
export const runHook = (script, input, { args = [], env = {} } = {}) => {
    const result = spawnSync(process.execPath, [path.join(HOOKS_DIR, script), ...args], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...baseEnv(), ...env },
        timeout: 15000
    });
    if (result.status !== 0) {
        throw new Error(`hook exited with ${result.status}: ${result.stderr}`);
    }
    const output = result.stdout.trim();
    if (!output) {
        return { decision: "allow", reason: "" };
    }
    const parsed = JSON.parse(output).hookSpecificOutput;
    return { decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason };
};

export const makeTempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `rag-lab-${prefix}-`));

// Creates files below `root`: { "src/app.ts": "content" }.
export const writeFiles = (root, files) => {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
};
