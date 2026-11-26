// PreToolUse hook for every session and agent in RAG Lab (docs/design.md, section 9). The orchestrator may push
// feature branches of this one repository and open pull requests on it; the owner merges. This hook blocks what
// would go around that:
// - pushing to main, force-pushing, deleting remote branches, merging, changing the repository's settings;
// - pushing from any other repository on this computer, or to any GitHub repository but RAG_LAB_REPOSITORY
//   (the owner's credentials reach all their repositories, and the other projects' own hooks do not run here);
// - gh commands that act on another repository, publish elsewhere (gists, new repositories, forks) or touch
//   credentials;
// - git and gh aliases, configuration that redirects pushes, and edits inside .git/.
// While the repository is private on GitHub Free there is no branch protection, so this hook is the only barrier.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { deny, runHook } from "./lib/hook-io.mjs";
import { findProgram, programName, splitCommands } from "./lib/shell.mjs";

// The only GitHub repository anything in RAG Lab may push to or act on, as owner/name in lower case.
const RAG_LAB_REPOSITORY = "diegodebece/rag-lab";
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const OWNER_NOTE = "In RAG Lab, only feature/* branches of github.com/Diegodebece/RAG-Lab are pushed, and the owner merges; give the owner the exact command instead.";

// git options placed before the subcommand that take a separate value
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
// `git push` options that take a separate value
const PUSH_OPTIONS_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);
// `git push` options that rewrite or delete remote history, or push more than one branch
const PUSH_FORBIDDEN_OPTIONS = [
    /^--force/, /^--force-with-lease/, /^--force-if-includes/, /^--delete$/, /^--mirror$/, /^--all$/,
    /^--branches$/, /^--prune$/
];
// git configuration that changes where a push goes (including URL rewriting), or defines aliases
const GIT_CONFIG_FORBIDDEN_KEYS = /^(alias\.|push\.|url\.|remote\..+\.(push|pushurl|mirror)$|branch\..+\.(merge|pushremote)$|remote\.pushdefault$)/i;
// environment variables that point gh at another repository, host or account
const GH_ENVIRONMENT = /\b(GH_REPO|GH_HOST|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b/;

const isProtected = (name) => PROTECTED_BRANCHES.has(name.replace(/^refs\/heads\//, "").toLowerCase());

const runGit = (cwd, args) => {
    try {
        return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
        return null;
    }
};

// The repository's shared .git folder: the same for the main checkout and every worktree of it.
const commonGitDir = (dir) => {
    const found = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return found ? path.resolve(found).toLowerCase() : null;
};

// "owner/name" in lower case for a GitHub URL or repository argument, or null when it is not GitHub.
// Accepts https://github.com/o/r(.git), git@github.com:o/r.git, github.com/o/r and o/r.
const githubRepository = (value) => {
    const text = String(value ?? "").trim();
    const url = text.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (url) {
        return `${url[1]}/${url[2]}`.toLowerCase();
    }
    const short = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    return short ? `${short[1]}/${short[2]}`.toLowerCase() : null;
};

const isRagLab = (value) => githubRepository(value) === RAG_LAB_REPOSITORY;

// Why running in `cwd` is not inside RAG Lab's repository (its checkout or one of its worktrees), or null.
const checkInsideProject = (cwd, projectDir, what) => {
    const projectGit = commonGitDir(projectDir);
    if (!projectGit) {
        return `RAG Lab's repository could not be found, so ${what} is blocked.`;
    }
    if (commonGitDir(cwd) !== projectGit) {
        return `${what} runs in ${cwd}, which is not RAG Lab's repository or one of its worktrees.`;
    }
    return null;
};

// The URL a push goes to: the repository argument when it is a URL, otherwise the push URL of the named remote,
// or of the remote git would choose (branch.<name>.pushRemote, remote.pushDefault, branch.<name>.remote, origin).
const resolvePushUrl = (cwd, repository) => {
    if (repository && /[:/\\]/.test(repository)) {
        return repository;
    }
    let remote = repository;
    if (!remote) {
        const branch = runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
        const keys = branch ? [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`] : ["remote.pushDefault"];
        remote = keys.map((key) => runGit(cwd, ["config", "--get", key])).find(Boolean) ?? "origin";
    }
    return runGit(cwd, ["remote", "get-url", "--push", remote]);
};

// Why pushing the current branch without naming a destination could reach a protected branch, or null.
const checkCurrentBranchPush = (cwd) => {
    const branch = runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch) {
        return "The current branch could not be determined, so a push without an explicit feature/* refspec is blocked.";
    }
    if (isProtected(branch)) {
        return `The current branch is ${branch}.`;
    }
    const pushTarget = runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
    if (pushTarget && isProtected(pushTarget.split("/").slice(1).join("/"))) {
        return `The current branch pushes to ${pushTarget}.`;
    }
    return null;
};

// Why `git push <args>` run in `cwd` is blocked, or null.
const checkPush = (args, cwd, projectDir) => {
    const positional = [];
    let repositoryOption = null;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--repo") {
            repositoryOption = args[index + 1] ?? "";
            index++;
        } else if (arg.startsWith("--repo=")) {
            repositoryOption = arg.slice("--repo=".length);
        } else if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
            index++;
        } else if (arg.startsWith("--")) {
            if (PUSH_FORBIDDEN_OPTIONS.some((pattern) => pattern.test(arg))) {
                return `"git push ${arg}" can rewrite or delete remote branches.`;
            }
        } else if (arg.startsWith("-") && arg.length > 1) {
            // combined short options such as -uf
            if (/[fd]/.test(arg.slice(1))) {
                return `"git push ${arg}" forces a push or deletes a branch.`;
            }
        } else {
            positional.push(arg);
        }
    }

    const outside = checkInsideProject(cwd, projectDir, "This push");
    if (outside) {
        return outside;
    }

    const repository = repositoryOption ?? positional[0] ?? null;
    const pushUrl = resolvePushUrl(cwd, repository);
    if (!pushUrl || !isRagLab(pushUrl)) {
        return `The push goes to ${pushUrl ?? repository ?? "a remote that could not be resolved"}, not to github.com/Diegodebece/RAG-Lab.`;
    }

    const refspecs = repositoryOption === null ? positional.slice(1) : positional;
    if (refspecs.length === 0) {
        return checkCurrentBranchPush(cwd);
    }

    for (const refspec of refspecs) {
        if (refspec.startsWith("+")) {
            return `The refspec ${refspec} forces the push.`;
        }
        if (refspec.startsWith(":")) {
            return `The refspec ${refspec} deletes a remote branch.`;
        }
        if (refspec.includes("*")) {
            return `The refspec ${refspec} can push to any branch.`;
        }
        const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
        if (destination === "HEAD" || destination === "@") {
            const reason = checkCurrentBranchPush(cwd);
            if (reason) {
                return reason;
            }
        } else if (isProtected(destination)) {
            return `The push goes to ${destination}.`;
        }
    }

    return null;
};

// Why a git command is blocked, or null. `cwd` is where it runs.
const checkGit = (tokens, cwd, projectDir) => {
    let index = 0;
    let workingDir = cwd;

    while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index];
        if (option === "-C") {
            workingDir = path.resolve(workingDir, tokens[index + 1] ?? ".");
        }
        // -c takes key=value; only the key matters
        if (option === "-c" && GIT_CONFIG_FORBIDDEN_KEYS.test((tokens[index + 1] ?? "").split("=")[0])) {
            return `"git -c ${tokens[index + 1]}" changes where git pushes or defines an alias.`;
        }
        index += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    }

    const subcommand = tokens[index];
    const args = tokens.slice(index + 1);

    if (subcommand === "push") {
        return checkPush(args, workingDir, projectDir);
    }
    if (subcommand === "config" && args.some((arg) => GIT_CONFIG_FORBIDDEN_KEYS.test(arg))) {
        return "This git configuration changes where git pushes or defines an alias that could hide a push.";
    }
    if (subcommand === "remote" && args.includes("--push")) {
        return "Changing a remote's push URL is blocked.";
    }
    return null;
};

// The repository a gh command names with -R/--repo, or null.
const ghRepositoryOption = (args) => {
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "-R" || args[index] === "--repo") {
            return args[index + 1] ?? "";
        }
        const attached = args[index].match(/^(?:--repo=|-R)(.+)$/);
        if (attached) {
            return attached[1];
        }
    }
    return null;
};

// Why a gh command is blocked, or null. `cwd` is where it runs.
const checkGh = (tokens, cwd, projectDir) => {
    const [group, action] = tokens;

    if (group === "pr" && action === "merge") {
        return "\"gh pr merge\" merges a pull request.";
    }
    if (group === "repo" && !["view", "list"].includes(action)) {
        return `"gh repo ${action ?? ""}" creates, copies or changes a repository.`;
    }
    if (["alias", "extension", "ext", "ruleset"].includes(group)) {
        return `"gh ${group}" is blocked (aliases and extensions can hide commands; rulesets are the owner's).`;
    }
    if (group === "gist" && !["view", "list"].includes(action)) {
        return `"gh gist ${action ?? ""}" publishes or changes content outside RAG Lab.`;
    }
    if (group === "auth" && action !== "status") {
        return `"gh auth ${action ?? ""}" reads or changes the owner's GitHub credentials.`;
    }
    if (["secret", "variable", "ssh-key", "gpg-key", "config"].includes(group) && !["list", "get", "view"].includes(action)) {
        return `"gh ${group} ${action ?? ""}" changes settings or credentials, which are the owner's.`;
    }

    const repositoryOption = ghRepositoryOption(tokens);
    if (repositoryOption !== null && !isRagLab(repositoryOption)) {
        return `"gh --repo ${repositoryOption}" acts on a repository other than RAG-Lab.`;
    }

    if (group === "api") {
        const reason = checkGhApi(tokens.slice(1));
        if (reason) {
            return reason;
        }
    }

    // without --repo, gh acts on the repository of the folder it runs in
    if (repositoryOption === null) {
        return checkInsideProject(cwd, projectDir, `"gh ${group ?? ""}"`);
    }
    return null;
};

// gh api: reading is free, and so is commenting on RAG-Lab; merging, deleting, changing refs or settings, and
// any GraphQL mutation (which names its target by an opaque id) are not.
const checkGhApi = (args) => {
    let method = null;
    let hasFields = false;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "-X" || arg === "--method") {
            method = String(args[index + 1] ?? "").toUpperCase();
            index++;
        } else if (/^(-X|--method=)/.test(arg)) {
            method = arg.replace(/^(-X|--method=)/, "").toUpperCase();
        } else if (/^(-f|-F|--field|--raw-field|--input)/.test(arg)) {
            hasFields = true;
        }
    }

    const effectiveMethod = method ?? (hasFields ? "POST" : "GET");
    const target = args.join(" ").toLowerCase();

    for (const match of target.matchAll(/repos\/([^/\s{}]+)\/([^/\s{}?]+)/g)) {
        if (`${match[1]}/${match[2]}` !== RAG_LAB_REPOSITORY) {
            return `This "gh api" call acts on ${match[1]}/${match[2]}, not on RAG-Lab.`;
        }
    }
    if (["DELETE", "PATCH", "PUT"].includes(effectiveMethod)) {
        return `"gh api" with ${effectiveMethod} can merge, delete or change settings.`;
    }
    if (effectiveMethod !== "GET" && /merge|git\/refs|protection|rulesets|visibility/.test(target)) {
        return "This \"gh api\" call merges, moves refs or changes protection.";
    }
    if (/graphql/.test(target) && /mutation/.test(target)) {
        return "GraphQL mutations are blocked: their target cannot be checked. Use the REST endpoints of RAG-Lab instead.";
    }
    return null;
};

// GitHub MCP tools: block merges, deletions, new repositories, direct writes to a protected or unnamed branch,
// and anything but reading on a repository other than RAG-Lab.
const checkGithubMcp = (toolName, toolInput) => {
    const name = toolName.toLowerCase();
    const action = name.split("__").pop();

    if (/merge|delete|update_ref|update_repo|create_repo|fork|transfer|protection|ruleset/.test(action)) {
        return `The ${toolName} tool merges, deletes or creates or changes a repository.`;
    }
    if (toolInput.owner !== undefined || toolInput.repo !== undefined) {
        const repository = `${toolInput.owner ?? ""}/${toolInput.repo ?? ""}`.toLowerCase();
        if (repository !== RAG_LAB_REPOSITORY && !/^(get|list|search)_/.test(action)) {
            return `The ${toolName} tool would act on ${repository}, not on RAG-Lab.`;
        }
    }
    if (/push_files|create_or_update_file|update_file/.test(action)) {
        const branch = String(toolInput.branch ?? "");
        if (!branch || isProtected(branch)) {
            return `The ${toolName} tool would write to ${branch || "the default branch"}.`;
        }
    }
    return null;
};

const checkShellCommand = (command, startDir, projectDir) => {
    if (GH_ENVIRONMENT.test(command)) {
        return "Setting GH_REPO, GH_HOST or a GitHub token points gh at another repository or account.";
    }

    let cwd = startDir;

    for (const segment of splitCommands(command)) {
        const tokens = segment.map((token) => token.text);
        const first = programName(tokens[0] ?? "");

        // follow simple directory changes so `cd other && git push` is checked in the right repository
        if (["cd", "set-location", "pushd", "sl", "chdir"].includes(first) && tokens[1]) {
            cwd = path.resolve(cwd, tokens[1]);
            continue;
        }

        const gitIndex = findProgram(segment, new Set(["git"]));
        if (gitIndex !== -1) {
            const reason = checkGit(tokens.slice(gitIndex + 1), cwd, projectDir);
            if (reason) {
                return reason;
            }
        }

        const ghIndex = findProgram(segment, new Set(["gh"]));
        if (ghIndex !== -1) {
            const reason = checkGh(tokens.slice(ghIndex + 1), cwd, projectDir);
            if (reason) {
                return reason;
            }
        }
    }

    return null;
};

await runHook(async (input) => {
    const toolName = String(input.tool_name ?? "");
    const toolInput = input.tool_input ?? {};
    const cwd = String(input.cwd ?? "") || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;

    if (toolName === "Bash" || toolName === "PowerShell") {
        const reason = checkShellCommand(String(toolInput.command ?? ""), cwd, projectDir);
        if (reason) {
            deny(`${reason} ${OWNER_NOTE}`);
        }
    }

    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
        const filePath = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
        const parts = path.resolve(cwd, filePath).split(path.sep).map((part) => part.toLowerCase());
        if (parts.includes(".git")) {
            deny(`Editing files inside .git/ (${filePath}) is blocked: it could change where git pushes. ${OWNER_NOTE}`);
        }
    }

    if (/github/i.test(toolName) && toolName.startsWith("mcp__")) {
        const reason = checkGithubMcp(toolName, toolInput);
        if (reason) {
            deny(`${reason} ${OWNER_NOTE}`);
        }
    }
});
