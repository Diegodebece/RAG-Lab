import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runHook } from "./helpers.mjs";

const decide = (command, tool = "Bash") =>
    runHook("approval-gates.mjs", { tool_name: tool, tool_input: { command }, cwd: process.cwd() }).decision;

describe("approval-gates: the owner runs Docker and model downloads", () => {
    for (const command of [
        "docker compose up -d",
        "docker-compose up -d",
        "docker model ls",
        "docker pull pgvector/pgvector:pg17",
        "docker rm -f rag-lab-db",
        "docker compose config",
        "ollama pull gpt-oss:20b",
        "ollama run qwen3.5:4b",
        "ollama rm qwen3.5:4b",
        "npm test && docker compose down",
        "pwsh -Command \"ollama pull gpt-oss:20b\""
    ]) {
        test(`denies: ${command}`, () => assert.equal(decide(command), "deny"));
    }
});

describe("approval-gates: dependencies and downloads need a prompt", () => {
    for (const command of [
        "npm install express",
        "npm i -D tsx",
        "npm uninstall joi",
        "npm update",
        "npx tsc --init",
        "npm exec some-tool",
        "pnpm add zod",
        "curl -o model.bin https://example.invalid/model.bin",
        "pip install tokenizers"
    ]) {
        test(`asks: ${command}`, () => assert.equal(decide(command), "ask"));
    }

    test("asks for Invoke-WebRequest with -OutFile in PowerShell", () =>
        assert.equal(decide("Invoke-WebRequest https://example.invalid/f -OutFile f", "PowerShell"), "ask"));
});

describe("approval-gates: read-only and routine commands pass", () => {
    for (const command of [
        "docker ps",
        "docker --version",
        "docker compose ps",
        "docker logs rag-lab-db",
        "ollama list",
        "ollama ps",
        "ollama show gpt-oss:20b",
        "npm install",
        "npm ci",
        "npm test",
        "npm run build",
        "git commit -m \"add docker and ollama notes\"",
        "git add docker-compose.yml",
        "curl.exe -s http://127.0.0.1:11434/api/tags"
    ]) {
        test(`allows: ${command}`, () => assert.equal(decide(command), "allow"));
    }

    test("ignores tools other than the shells", () =>
        assert.equal(runHook("approval-gates.mjs", { tool_name: "Read", tool_input: { file_path: "x" } }).decision, "allow"));
});
