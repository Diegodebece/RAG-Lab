// PreToolUse hook for every session and agent in RAG Lab: the approval gates of docs/design.md (section 8) that a
// shell command can cross. The owner runs Docker and model downloads, so those are denied with a note to hand
// them the command. New dependencies and other downloads force a permission prompt ("ask"), so the owner
// approves each one even in auto mode. Read-only commands (docker ps, ollama list, npm ci) pass.

import { ask, deny, runHook } from "./lib/hook-io.mjs";
import { programName, splitCommands } from "./lib/shell.mjs";

const OWNER_RUNS = "The owner runs this in RAG Lab: give them the exact PowerShell command, one per block.";

// docker subcommands that only read (docker compose config is excluded: it prints secrets)
const DOCKER_READ_ONLY = new Set(["ps", "logs", "inspect", "images", "version", "info", "stats", "top", "port"]);
const DOCKER_COMPOSE_READ_ONLY = new Set(["ps", "logs", "images", "top", "version", "ls"]);
// ollama subcommands that only read; pull, run (it pulls a missing model), push, rm, cp and create are not
const OLLAMA_READ_ONLY = new Set(["list", "ls", "ps", "show", "--version", "-v", "help", "--help", "-h"]);
const OLLAMA_DOWNLOADS = new Set(["pull", "run", "push", "create", "cp", "rm"]);
// npm subcommands (and their abbreviations) that add, remove or upgrade packages when given a package name
const NPM_CHANGES = new Set([
    "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
    "uninstall", "un", "unlink", "remove", "rm", "r", "update", "up", "upgrade", "udpate"
]);

// Why a simple command needs the owner: { decision: "deny" | "ask", reason } or null.
const checkSegment = (tokens) => {
    const names = tokens.map(programName);

    const dockerIndex = names.findIndex((name) => name === "docker" || name === "docker-compose");
    if (dockerIndex !== -1) {
        const args = tokens.slice(dockerIndex + 1).filter((token) => !token.startsWith("-"));
        if (names[dockerIndex] === "docker-compose") {
            args.unshift("compose");
        }
        const [subcommand, action] = args;
        const readOnly = subcommand === undefined
            || (subcommand === "compose" ? DOCKER_COMPOSE_READ_ONLY.has(action) : DOCKER_READ_ONLY.has(subcommand));
        if (!readOnly) {
            return { decision: "deny", reason: `"docker ${args.slice(0, 2).join(" ")}" changes containers, images or downloads (docker model ls can start a download).` };
        }
    }

    const ollamaIndex = names.indexOf("ollama");
    if (ollamaIndex !== -1) {
        const subcommand = tokens[ollamaIndex + 1] ?? "";
        if (OLLAMA_DOWNLOADS.has(subcommand)) {
            return { decision: "deny", reason: `"ollama ${subcommand}" downloads or changes models.` };
        }
        if (!OLLAMA_READ_ONLY.has(subcommand)) {
            return { decision: "ask", reason: `"ollama ${subcommand}" is not a read-only Ollama command.` };
        }
    }

    const npmIndex = names.findIndex((name) => name === "npm" || name === "pnpm" || name === "yarn");
    if (npmIndex !== -1) {
        const args = tokens.slice(npmIndex + 1).filter((token) => !token.startsWith("-"));
        const [subcommand, ...packages] = args;
        if (names[npmIndex] !== "npm" && subcommand !== "test" && subcommand !== "run") {
            return { decision: "ask", reason: `"${names[npmIndex]} ${subcommand ?? ""}" may install packages.` };
        }
        if (NPM_CHANGES.has(subcommand) && (packages.length > 0 || subcommand !== "install" && subcommand !== "i")) {
            return { decision: "ask", reason: `"npm ${args.join(" ")}" changes dependencies, which needs the owner's approval.` };
        }
        if (subcommand === "exec" || subcommand === "x") {
            return { decision: "ask", reason: "\"npm exec\" can download and run a package." };
        }
    }

    if (names.some((name) => ["npx", "pnpx", "bunx"].includes(name))) {
        return { decision: "ask", reason: "npx can download and run a package." };
    }
    if (names.some((name) => ["wget", "winget", "choco", "scoop", "start-bitstransfer"].includes(name))) {
        return { decision: "ask", reason: "This command downloads or installs software." };
    }
    if (names.some((name) => ["curl", "invoke-webrequest", "iwr"].includes(name))
        && tokens.some((token) => /^(-o|-O|--output|--remote-name|-outfile)$/i.test(token))) {
        return { decision: "ask", reason: "This command downloads a file." };
    }
    if (names.some((name) => /^pip3?$/.test(name)) && tokens.includes("install")) {
        return { decision: "ask", reason: "\"pip install\" installs packages." };
    }

    return null;
};

await runHook(async (input) => {
    const toolName = String(input.tool_name ?? "");
    if (toolName !== "Bash" && toolName !== "PowerShell") {
        return;
    }

    let askReason = null;
    for (const segment of splitCommands(String(input.tool_input?.command ?? ""))) {
        const result = checkSegment(segment.map((token) => token.text));
        if (result?.decision === "deny") {
            deny(`${result.reason} ${OWNER_RUNS}`);
        }
        askReason ??= result?.reason ?? null;
    }

    if (askReason) {
        ask(`${askReason} Approval gate (docs/design.md, section 8): the owner approves new dependencies and downloads.`);
    }
});
