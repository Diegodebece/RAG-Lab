import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTempDir, runHook, writeFiles } from "./helpers.mjs";

let base;
let project;
let data;
let reference;

before(() => {
    base = makeTempDir("scope");
    project = path.join(base, "lab");
    data = path.join(base, "lab-data");
    reference = path.join(base, "web");
    writeFiles(project, {
        "src/app.ts": "",
        "test/app.test.ts": "",
        "migrations/001_init.sql": "",
        "docs/design.md": "",
        "docs/experiments/2026-11-25-chunks.md": "# Chunks\r\n\r\nold result\r\n",
        "docs/experiments/leaderboard.md": "| a |\n",
        "package.json": "{}",
        "README.md": "",
        ".env": `RAG_LAB_DATA_DIR="${data}"\nRAG_WEB_DIR=${reference}\nJWT_SECRET=do-not-read\n`,
        ".env.example": "",
        ".claude/hooks/agent-scope.mjs": "",
        ".claude/settings.local.json": "{}",
        "data/copy.json": "{}"
    });
    writeFiles(data, { "evaluation-100.json": "[]", ".env": "" });
    writeFiles(reference, {
        "src/v1/services/questions.service.ts": "",
        "test/routes/auth.test.ts": "",
        "migrations/001_init.sql": "",
        "scripts/create-app-role.sql": "",
        "docs/guides/setup.md": "",
        ".claude/skills/layered-express-service/SKILL.md": "",
        "CLAUDE.md": "",
        ".env": "SECRET=1",
        "RAG project/data/evaluation-100.json": "[]",
        "docs/git-cheatsheet.txt": "",
        "audit-report-2026-10-17.md": ""
    });
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

const call = (role, toolName, toolInput, env = {}) =>
    runHook("agent-scope.mjs", { tool_name: toolName, tool_input: toolInput, cwd: project },
        { args: role ? [role] : [], env: { CLAUDE_PROJECT_DIR: project, ...env } }).decision;

const read = (role, file) => call(role, "Read", { file_path: path.isAbsolute(file) ? file : path.join(project, file) });
const write = (role, file, content = "x") => call(role, "Write", { file_path: path.join(project, file), content });
const edit = (role, file, oldText, newText) =>
    call(role, "Edit", { file_path: path.join(project, file), old_string: oldText, new_string: newText });
const bash = (role, command) => call(role, "Bash", { command });

describe("agent-scope: every role", () => {
    const roles = ["planner", "test-writer", "implementer", "code-auditor", "owasp-auditor", "finding-verifier",
        "experiment-runner", "lab-reporter", "analyst", "docs-keeper"];

    test("an unknown or missing role is denied everything", () => {
        assert.equal(read("orchestrator", "src/app.ts"), "deny");
        assert.equal(read("", "src/app.ts"), "deny");
    });

    for (const role of roles) {
        test(`${role}: never reads secrets, git internals or local settings`, () => {
            assert.equal(read(role, ".env"), "deny");
            assert.equal(read(role, ".git/config"), "deny");
            assert.equal(read(role, ".claude/settings.local.json"), "deny");
            assert.equal(read(role, "data/copy.json"), "deny");
            assert.equal(read(role, path.join(reference, ".env")), "deny");
            assert.equal(read(role, path.join(reference, "RAG project/data/evaluation-100.json")), "deny");
            assert.equal(read(role, path.join(base, "elsewhere.txt")), "deny");
        });

        test(`${role}: never edits the hooks, agents or settings`, () => {
            assert.equal(write(role, ".claude/hooks/agent-scope.mjs"), "deny");
            assert.equal(write(role, ".claude/agents/planner.md"), "deny");
            assert.equal(write(role, ".claude/settings.json"), "deny");
            assert.equal(write(role, "CLAUDE.md"), "deny");
            assert.equal(write(role, "package.json"), "deny");
        });

        test(`${role}: never pushes, fetches or uses gh, and is told the orchestrator does`, () => {
            for (const command of [
                "git push -u origin feature/x",
                "git status && git push origin feature/x",
                "git -C . push origin feature/x",
                "git fetch origin",
                "git pull",
                "git remote add other https://example.invalid/r.git",
                "gh pr create --title t --body b",
                "gh pr comment 3 --body thanks",
                "gh api repos/o/r/pulls/3/comments"
            ]) {
                const result = runHook("agent-scope.mjs", { tool_name: "Bash", tool_input: { command }, cwd: project },
                    { args: [role], env: { CLAUDE_PROJECT_DIR: project } });
                assert.equal(result.decision, "deny", command);
                assert.match(result.reason, /Only the orchestrator pushes/, command);
            }
        });

        test(`${role}: has no web, agent or notebook tools, and may hand back its report`, () => {
            assert.equal(call(role, "WebFetch", { url: "https://example.invalid" }), "deny");
            assert.equal(call(role, "Agent", { prompt: "x" }), "deny");
            assert.equal(call(role, "NotebookEdit", { notebook_path: path.join(project, "test/a.ipynb") }), "deny");
            assert.equal(call(role, "mcp__github__get_me", {}), "deny");
            assert.equal(call(role, "SubagentHandback", { result: "report" }), "allow");
        });
    }
});

describe("agent-scope: read-only roles", () => {
    for (const role of ["planner", "analyst"]) {
        test(`${role} reads the project but writes and runs nothing`, () => {
            assert.equal(read(role, "src/app.ts"), "allow");
            assert.equal(read(role, "docs/design.md"), "allow");
            assert.equal(read(role, ".env.example"), "allow");
            assert.equal(write(role, "docs/plan.md"), "deny");
            assert.equal(bash(role, "npm test"), "deny");
        });
    }

    test("planner reads RAG Web's code and skills, but not its private files", () => {
        assert.equal(read("planner", path.join(reference, "src/v1/services/questions.service.ts")), "allow");
        assert.equal(read("planner", path.join(reference, ".claude/skills/layered-express-service/SKILL.md")), "allow");
        assert.equal(read("planner", path.join(reference, "CLAUDE.md")), "allow");
        assert.equal(read("planner", path.join(reference, "docs/git-cheatsheet.txt")), "deny");
        assert.equal(read("planner", path.join(reference, "audit-report-2026-10-17.md")), "deny");
        assert.equal(read("planner", path.join(data, "evaluation-100.json")), "deny");
    });

    test("planner searches RAG Web's top-level code folders, but never through its private files", () => {
        const search = (role, toolName, folder) =>
            call(role, toolName, { pattern: toolName === "Glob" ? "**/*" : "x", path: path.join(reference, folder) });
        for (const folder of ["src", "test", "migrations", "scripts"]) {
            assert.equal(search("planner", "Grep", folder), "allow", `Grep ${folder}`);
            assert.equal(search("planner", "Glob", folder), "allow", `Glob ${folder}`);
        }
        // docs/ holds git-cheatsheet.txt: listing its names is fine, reading through its contents is not
        assert.equal(search("planner", "Glob", "docs"), "allow");
        assert.equal(search("planner", "Grep", "docs"), "deny");
        assert.equal(search("planner", "Grep", "docs/guides"), "allow");
        assert.equal(search("planner", "Grep", ".claude/skills"), "allow");
        assert.equal(search("planner", "Grep", "."), "deny");
        assert.equal(search("planner", "Glob", "."), "deny");
        assert.equal(search("planner", "Glob", "RAG project"), "deny");
        assert.equal(search("planner", "Glob", ".claude"), "deny");
        assert.equal(search("analyst", "Grep", "src"), "deny");
    });

    test("analyst reads the private data folder", () => {
        assert.equal(read("analyst", path.join(data, "evaluation-100.json")), "allow");
        assert.equal(read("analyst", path.join(data, ".env")), "deny");
        assert.equal(read("analyst", path.join(reference, "CLAUDE.md")), "deny");
    });

    test("an environment variable takes precedence over .env", () => {
        const other = path.join(base, "other-data");
        assert.equal(call("analyst", "Read", { file_path: path.join(other, "a.json") }, { RAG_LAB_DATA_DIR: other }), "allow");
        assert.equal(call("analyst", "Read", { file_path: path.join(data, "a.json") }, { RAG_LAB_DATA_DIR: other }), "deny");
    });
});

describe("agent-scope: auditors and verifier see only the code", () => {
    for (const role of ["code-auditor", "owasp-auditor", "finding-verifier"]) {
        test(role, () => {
            assert.equal(read(role, "src/app.ts"), "allow");
            assert.equal(read(role, "test/app.test.ts"), "allow");
            assert.equal(read(role, "package.json"), "allow");
            assert.equal(read(role, ".env.example"), "allow");
            assert.equal(read(role, "docs/design.md"), "deny");
            assert.equal(read(role, "README.md"), "deny");
            assert.equal(read(role, path.join(reference, "src/v1/services/questions.service.ts")), "deny");
            assert.equal(call(role, "Grep", { pattern: "jwt", path: "src" }), "allow");
            assert.equal(call(role, "Grep", { pattern: "jwt" }), "deny");
            assert.equal(call(role, "Glob", { pattern: "**/*.md", path: "docs" }), "deny");
            assert.equal(bash(role, "npm test"), "deny");
        });
    }
});

describe("agent-scope: searches", () => {
    test("Grep and Glob need a folder the role may read", () => {
        assert.equal(call("planner", "Grep", { pattern: "x", path: "docs" }), "allow");
        assert.equal(call("planner", "Glob", { pattern: "**/*.ts", path: "src" }), "allow");
        assert.equal(call("planner", "Grep", { pattern: "SECRET" }), "deny");
        assert.equal(call("planner", "Grep", { pattern: "x", path: "." }), "deny");
        assert.equal(call("planner", "Glob", { pattern: "../**", path: "src" }), "deny");
        assert.equal(call("planner", "Grep", { pattern: "x", path: "src", glob: "../../**" }), "deny");
        assert.equal(call("analyst", "Grep", { pattern: "x", path: data }), "allow");
    });
});

describe("agent-scope: test-writer", () => {
    test("writes only test/", () => {
        assert.equal(write("test-writer", "test/new.test.ts"), "allow");
        assert.equal(edit("test-writer", "test/app.test.ts", "a", "b"), "allow");
        assert.equal(write("test-writer", "src/app.ts"), "deny");
        assert.equal(write("test-writer", "migrations/002.sql"), "deny");
    });

    for (const command of [
        "npm test",
        "npm run test:hooks",
        "npm test -- --test-name-pattern=router",
        "node --test test/app.test.ts",
        "npm run typecheck && npm test",
        "git status",
        "git diff --stat"
    ]) {
        test(`runs: ${command}`, () => assert.equal(bash("test-writer", command), "allow"));
    }

    for (const command of [
        "npm test > out.txt",
        "npm test; rm -rf src",
        "npm test | tee src/app.ts",
        "rm src/app.ts",
        "npm run build",
        "npm run eval",
        "node --test --import ./x.mjs test/a.test.ts",
        "node -e \"require('fs').writeFileSync('src/a','')\"",
        "npm test --script-shell=bash",
        "git diff --output=src/app.ts",
        "git checkout -- src/app.ts",
        "echo $(cat .env)"
    ]) {
        test(`does not run: ${command}`, () => assert.equal(bash("test-writer", command), "deny"));
    }

    test("commits its tests, without skipping hooks or rewriting commits", () => {
        assert.equal(bash("test-writer", "git add test/new.test.ts && git commit -m \"Add router tests\""), "allow");
        assert.equal(bash("test-writer", "git commit -am \"Add router tests\""), "allow");
        for (const command of [
            "git commit --no-verify -m \"x\"",
            "git commit -n -m \"x\"",
            "git commit -nm \"x\"",
            "git commit --amend -m \"x\"",
            "git commit --fixup=HEAD~1"
        ]) {
            assert.equal(bash("test-writer", command), "deny", command);
        }
    });

    test("explains why redirections and separators are refused", () => {
        const result = runHook("agent-scope.mjs", { tool_name: "Bash", tool_input: { command: "npm test > out.txt" }, cwd: project },
            { args: ["test-writer"], env: { CLAUDE_PROJECT_DIR: project } });
        assert.match(result.reason, /Redirections, pipes/);
    });
});

describe("agent-scope: implementer", () => {
    test("writes only src/ and migrations/", () => {
        assert.equal(write("implementer", "src/v1/services/router.service.ts"), "allow");
        assert.equal(write("implementer", "migrations/002_runs.sql"), "allow");
        assert.equal(write("implementer", "test/app.test.ts"), "deny");
        assert.equal(write("implementer", "docs/design.md"), "deny");
        assert.equal(write("implementer", "src/.env"), "deny");
    });

    test("commits its work in its worktree", () => {
        assert.equal(bash("implementer", "git add src/v1/services/router.service.ts && git commit -m \"Add router service\""), "allow");
    });

    test("runs tests, typecheck, build and lint, not the evaluation", () => {
        assert.equal(bash("implementer", "npm test"), "allow");
        assert.equal(bash("implementer", "npm run build"), "allow");
        assert.equal(bash("implementer", "npm run lint"), "allow");
        assert.equal(bash("implementer", "npm run eval"), "deny");
        assert.equal(bash("implementer", "npm run migrate"), "deny");
    });
});

describe("agent-scope: experiment-runner", () => {
    test("runs only the evaluation scripts and writes nothing", () => {
        assert.equal(bash("experiment-runner", "npm run eval"), "allow");
        assert.equal(bash("experiment-runner", "npm run eval:retrieval -- --chunk-size=500 --profile=baseline"), "allow");
        assert.equal(bash("experiment-runner", "npm test"), "deny");
        assert.equal(bash("experiment-runner", "ollama pull gpt-oss:20b"), "deny");
        assert.equal(write("experiment-runner", "docs/experiments/x.md"), "deny");
        assert.equal(write("experiment-runner", "src/app.ts"), "deny");
        assert.equal(read("experiment-runner", path.join(data, "evaluation-100.json")), "allow");
    });
});

describe("agent-scope: lab-reporter keeps an append-only notebook", () => {
    const entry = "docs/experiments/2026-11-25-chunks.md";

    test("creates new entries", () => assert.equal(write("lab-reporter", "docs/experiments/2026-11-26-hybrid.md"), "allow"));
    test("appends to an entry", () =>
        assert.equal(write("lab-reporter", entry, "# Chunks\n\nold result\n\n## Re-run\n\nnew result\n"), "allow"));
    test("does not rewrite an entry", () =>
        assert.equal(write("lab-reporter", entry, "# Chunks\n\nbetter result\n"), "deny"));
    test("inserts with Edit", () =>
        assert.equal(edit("lab-reporter", entry, "old result", "old result (superseded, see 2026-11-26)"), "allow"));
    test("does not remove with Edit", () => assert.equal(edit("lab-reporter", entry, "old result", "new result"), "deny"));
    test("reorders the leaderboard freely", () =>
        assert.equal(write("lab-reporter", "docs/experiments/leaderboard.md", "| b |\n| a |\n"), "allow"));
    test("writes nothing outside docs/experiments", () => {
        assert.equal(write("lab-reporter", "docs/design.md"), "deny");
        assert.equal(write("lab-reporter", "README.md"), "deny");
    });
    test("reads results and runs nothing", () => {
        assert.equal(read("lab-reporter", path.join(data, "evaluation-100.json")), "allow");
        assert.equal(bash("lab-reporter", "npm run eval"), "deny");
    });
});

describe("agent-scope: docs-keeper", () => {
    test("writes docs, README, .env.example and skills", () => {
        assert.equal(write("docs-keeper", "docs/guide.md"), "allow");
        assert.equal(write("docs-keeper", "docs/api/openapi.yaml"), "allow");
        assert.equal(write("docs-keeper", "README.md"), "allow");
        assert.equal(write("docs-keeper", ".env.example"), "allow");
        assert.equal(write("docs-keeper", ".claude/skills/layered-express-service/SKILL.md"), "allow");
    });

    test("does not touch the lab notebook, code or tests", () => {
        assert.equal(write("docs-keeper", "docs/experiments/leaderboard.md"), "deny");
        assert.equal(write("docs-keeper", "src/app.ts"), "deny");
        assert.equal(write("docs-keeper", "test/app.test.ts"), "deny");
        assert.equal(bash("docs-keeper", "npm test"), "deny");
        // its changes are committed by the orchestrator
        assert.equal(bash("docs-keeper", "git commit -m \"Update docs\""), "deny");
    });
});
