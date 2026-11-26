import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTempDir, runHook } from "./helpers.mjs";

const RAG_LAB_URL = "https://github.com/Diegodebece/RAG-Lab.git";
const OTHER_URL = "https://github.com/Diegodebece/RAG-WebApi.git";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// RAG Lab's repository checked out on main, two worktrees of it on feature branches (one whose upstream is
// main), another project's repository on a feature branch, and a folder that is not a repository.
let root;
let lab;
let labFeature;
let labTracksMain;
let other;

const initRepo = (dir, url) => {
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "user.name", "test");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    git(dir, "remote", "add", "origin", url);
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
};

before(() => {
    root = makeTempDir("guard");
    lab = path.join(root, "lab");
    labFeature = path.join(root, "lab-feature");
    labTracksMain = path.join(root, "lab-tracks-main");
    other = path.join(root, "other");

    initRepo(lab, RAG_LAB_URL);
    git(lab, "remote", "add", "web", OTHER_URL);
    git(lab, "worktree", "add", "-q", "-b", "feature/x", labFeature);
    git(lab, "worktree", "add", "-q", "-b", "feature/y", labTracksMain);
    git(lab, "config", "branch.feature/y.remote", "origin");
    git(lab, "config", "branch.feature/y.merge", "refs/heads/main");
    git(lab, "config", "push.default", "upstream");

    initRepo(other, OTHER_URL);
    git(other, "branch", "feature/z");
    git(other, "symbolic-ref", "HEAD", "refs/heads/feature/z");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const decide = (input) => runHook("guard-github.mjs", input, { env: { CLAUDE_PROJECT_DIR: lab } });
const shell = (command, cwd = labFeature, tool = "Bash") => decide({ tool_name: tool, tool_input: { command }, cwd }).decision;

describe("guard-github: pushes from RAG Lab", () => {
    const denied = [
        "git push origin main",
        "git push origin master",
        "git push origin feature/x:main",
        "git push origin HEAD:refs/heads/main",
        "git push --force origin feature/x",
        "git push --force-with-lease origin feature/x",
        "git push -f origin feature/x",
        "git push -uf origin feature/x",
        "git push origin +feature/x",
        "git push origin :feature/x",
        "git push origin --delete feature/x",
        "git push -d origin feature/x",
        "git push --mirror origin",
        "git push --all origin",
        "git push origin 'refs/heads/*:refs/heads/*'",
        "git status && git push origin main",
        "bash -c \"git push origin main\"",
        "\"C:\\Program Files\\Git\\cmd\\git.exe\" push origin main"
    ];
    for (const command of denied) {
        test(`denies: ${command}`, () => assert.equal(shell(command), "deny"));
    }

    test("denies a PowerShell push to main", () => {
        assert.equal(shell("git status; git push origin main", labFeature, "PowerShell"), "deny");
        assert.equal(shell("powershell -Command \"git push origin main\"", labFeature, "PowerShell"), "deny");
    });

    test("denies a push without refspec while on main", () => assert.equal(shell("git push", lab), "deny"));
    test("denies pushing HEAD while on main", () => assert.equal(shell("git push -u origin HEAD", lab), "deny"));
    test("denies a push from a branch whose upstream is main", () => assert.equal(shell("git push", labTracksMain), "deny"));
    test("follows cd into the checkout on main", () => assert.equal(shell(`cd "${lab}" && git push`), "deny"));
    test("follows git -C into the checkout on main", () => assert.equal(shell(`git -C "${lab}" push`), "deny"));

    const allowed = [
        "git push -u origin feature/x",
        "git push origin feature/x:feature/x",
        "git push",
        "git push -u origin HEAD",
        `git push ${RAG_LAB_URL} feature/x`,
        "git push git@github.com:Diegodebece/RAG-Lab.git feature/x",
        "git status",
        "git commit -m \"push to main later\"",
        "git log --oneline main"
    ];
    for (const command of allowed) {
        test(`allows from a RAG Lab worktree: ${command}`, () => assert.equal(shell(command), "allow"));
    }
});

describe("guard-github: pushes anywhere else", () => {
    test("denies pushing a feature branch of another project", () => {
        assert.equal(shell("git push -u origin feature/z", other), "deny");
        assert.equal(shell(`git -C "${other}" push origin feature/z`), "deny");
        assert.equal(shell(`cd "${other}" && git push -u origin feature/z`), "deny");
        assert.equal(shell(`Set-Location "${other}"; git push origin feature/z`, labFeature, "PowerShell"), "deny");
    });

    test("denies pushing RAG Lab's branches to another GitHub repository", () => {
        assert.equal(shell("git push web feature/x"), "deny");
        assert.equal(shell(`git push ${OTHER_URL} feature/x`), "deny");
        assert.equal(shell(`git push --repo=${OTHER_URL} feature/x`), "deny");
        assert.equal(shell(`git push --repo ${OTHER_URL} feature/x`), "deny");
    });

    test("names the reason", () => {
        const result = decide({ tool_name: "Bash", tool_input: { command: "git push -u origin feature/z" }, cwd: other });
        assert.match(result.reason, /not RAG Lab's repository/);
    });

    test("denies a push from a folder that is not a repository", () => assert.equal(shell("git push", root), "deny"));

    test("denies a push from a separate copy of RAG-Lab outside the project", () => {
        const copy = path.join(root, "stale-copy");
        initRepo(copy, RAG_LAB_URL);
        git(copy, "branch", "feature/old");
        git(copy, "symbolic-ref", "HEAD", "refs/heads/feature/old");
        assert.equal(shell("git push -u origin feature/old", copy), "deny");
    });
});

describe("guard-github: configuration that hides a push", () => {
    for (const command of [
        "git config alias.ship push",
        "git config remote.origin.push refs/heads/*:refs/heads/main",
        "git config remote.origin.pushurl https://github.com/Diegodebece/RAG-WebApi.git",
        "git config remote.pushDefault web",
        "git config push.default upstream",
        "git config branch.feature/x.merge refs/heads/main",
        "git config url.https://github.com/Diegodebece/RAG-WebApi.insteadOf https://github.com/Diegodebece/RAG-Lab",
        "git -c remote.origin.push=+refs/heads/*:refs/heads/main push",
        "git -c url.https://github.com/Diegodebece/RAG-WebApi.pushInsteadOf=https://github.com/Diegodebece/RAG-Lab push origin feature/x",
        "git remote set-url --push origin https://example.invalid/other.git"
    ]) {
        test(`denies: ${command}`, () => assert.equal(shell(command), "deny"));
    }

    test("allows reading configuration", () => assert.equal(shell("git config user.name"), "allow"));

    test("denies editing files inside .git", () => {
        const result = decide({
            tool_name: "Edit",
            tool_input: { file_path: path.join(lab, ".git", "config"), old_string: "a", new_string: "b" },
            cwd: labFeature
        });
        assert.equal(result.decision, "deny");
    });

    test("allows editing ordinary files, also under .github", () => {
        for (const file of ["src/app.ts", ".github/workflows/ci.yml"]) {
            const result = decide({ tool_name: "Write", tool_input: { file_path: path.join(labFeature, file), content: "" }, cwd: labFeature });
            assert.equal(result.decision, "allow", file);
        }
    });
});

describe("guard-github: gh CLI on RAG-Lab", () => {
    for (const command of [
        "gh pr merge 3 --squash",
        "gh repo edit --visibility public",
        "gh repo delete Diegodebece/RAG-Lab --yes",
        "gh alias set ship 'pr merge'",
        "gh extension install someone/gh-merge",
        "gh api -X DELETE repos/Diegodebece/RAG-Lab/git/refs/heads/feature/x",
        "gh api repos/Diegodebece/RAG-Lab/pulls/3/merge -X PUT",
        "gh api --method=PATCH repos/Diegodebece/RAG-Lab -f visibility=public",
        "gh api repos/Diegodebece/RAG-Lab/git/refs -f ref=refs/heads/main -f sha=abc",
        "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
        "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'"
    ]) {
        test(`denies: ${command}`, () => assert.equal(shell(command), "deny"));
    }

    for (const command of [
        "gh pr create --base main --title t --body b",
        "gh pr create --repo Diegodebece/RAG-Lab --title t --body b",
        "gh pr view 3 --comments",
        "gh api repos/Diegodebece/RAG-Lab/pulls/3/comments",
        "gh api repos/{owner}/{repo}/pulls/3/comments -f body=thanks",
        "gh api graphql -f query='query { viewer { login } }'",
        "gh run view 42 --log-failed",
        "gh auth status"
    ]) {
        test(`allows from a RAG Lab worktree: ${command}`, () => assert.equal(shell(command), "allow"));
    }
});

describe("guard-github: gh CLI anywhere else", () => {
    for (const command of [
        "gh pr create --repo Diegodebece/RAG-WebApi --title t --body b",
        "gh pr create -R Diegodebece/RAG-WebApp --title t --body b",
        "gh pr comment 3 --repo=https://github.com/Diegodebece/RAG-WebApi --body hi",
        "gh api repos/Diegodebece/RAG-WebApi/pulls/1/comments -f body=x",
        "GH_REPO=Diegodebece/RAG-WebApi gh pr create --title t --body b",
        "gh gist create notes.md --public",
        "gh repo create new-project --public",
        "gh repo fork Diegodebece/RAG-WebApi",
        "gh repo clone Diegodebece/RAG-WebApi",
        "gh auth token",
        "gh secret set TOKEN --body x"
    ]) {
        test(`denies: ${command}`, () => assert.equal(shell(command), "deny"));
    }

    test("denies gh inside another project's folder", () => {
        assert.equal(shell("gh pr create --title t --body b", other), "deny");
        assert.equal(shell(`cd "${other}" && gh pr list`), "deny");
    });

    test("denies setting GH_REPO in PowerShell", () =>
        assert.equal(shell("$env:GH_REPO = 'Diegodebece/RAG-WebApi'; gh pr list", labFeature, "PowerShell"), "deny"));
});

describe("guard-github: GitHub MCP tools", () => {
    const mcp = (name, input = {}) =>
        decide({ tool_name: `mcp__github__${name}`, tool_input: input, cwd: labFeature }).decision;

    test("denies merging, deleting and creating repositories", () => {
        assert.equal(mcp("merge_pull_request", { owner: "Diegodebece", repo: "RAG-Lab", pullNumber: 3 }), "deny");
        assert.equal(mcp("delete_file", { owner: "Diegodebece", repo: "RAG-Lab", branch: "feature/x" }), "deny");
        assert.equal(mcp("create_repository", { name: "x" }), "deny");
    });
    test("denies writing to main or to an unnamed branch", () => {
        assert.equal(mcp("push_files", { owner: "Diegodebece", repo: "RAG-Lab", branch: "main" }), "deny");
        assert.equal(mcp("create_or_update_file", { owner: "Diegodebece", repo: "RAG-Lab" }), "deny");
    });
    test("denies writing to another repository", () => {
        assert.equal(mcp("create_pull_request", { owner: "Diegodebece", repo: "RAG-WebApi" }), "deny");
        assert.equal(mcp("push_files", { owner: "Diegodebece", repo: "RAG-WebApi", branch: "feature/x" }), "deny");
        assert.equal(mcp("add_issue_comment", { owner: "someone", repo: "else", body: "hi" }), "deny");
    });
    test("allows writing to a RAG-Lab feature branch, and reading anywhere", () => {
        assert.equal(mcp("push_files", { owner: "Diegodebece", repo: "RAG-Lab", branch: "feature/x" }), "allow");
        assert.equal(mcp("create_pull_request", { owner: "Diegodebece", repo: "RAG-Lab" }), "allow");
        assert.equal(mcp("get_pull_request", { owner: "Diegodebece", repo: "RAG-WebApi", pullNumber: 3 }), "allow");
        assert.equal(mcp("get_me", {}), "allow");
    });
});
