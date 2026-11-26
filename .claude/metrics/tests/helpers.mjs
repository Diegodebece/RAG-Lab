// Builders for synthetic Claude Code transcripts. The tests never read real transcripts: those are private.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const METRICS_DIR = path.resolve(import.meta.dirname, "..");

export const makeTempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `rag-lab-metrics-${prefix}-`));

// The usage block of one model call, as Claude Code writes it.
export const usage = (overrides = {}) => ({
    input_tokens: 10,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 10000,
    output_tokens: 100,
    output_tokens_details: { thinking_tokens: 40 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
    speed: "standard",
    ...overrides
});

// The rows of one assistant message: Claude Code writes one row per content block, all with the same usage.
export const assistant = ({
    id, at, model = "claude-opus-5-5", sessionId = "session-1", cwd = "C:\\Repo", gitBranch = "main", u = usage(),
    agentId, attributionAgent, blocks = 1, content, extra = {}
}) => Array.from({ length: blocks }, (_, index) => ({
    type: "assistant",
    uuid: `${id}-row-${index}`,
    timestamp: at,
    sessionId,
    cwd,
    gitBranch,
    isSidechain: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
    ...(attributionAgent ? { attributionAgent } : {}),
    ...extra,
    message: {
        id,
        model,
        role: "assistant",
        content: content ?? [{ type: "text", text: "private message text" }],
        usage: u
    }
}));

// The two parent-transcript rows that launch an agent: the Agent tool call and its result naming the agentId.
export const agentLaunch = ({ toolUseId, agentId, subagentType, description, at, sessionId = "session-1" }) => [
    ...assistant({
        id: `msg-launch-${toolUseId}`,
        at,
        sessionId,
        content: [{
            type: "tool_use",
            id: toolUseId,
            name: "Agent",
            input: { subagent_type: subagentType, description, prompt: "private prompt" }
        }]
    }),
    {
        type: "user",
        timestamp: at,
        sessionId,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "private result" }] },
        toolUseResult: { agentId, description, prompt: "private prompt", status: "completed" }
    }
];

export const costState = (sessionId, totalCostUSD) => ({ type: "cost-state", sessionId, totalCostUSD, modelUsage: {} });

// Writes { "relative/path.jsonl": [row, ...] } (rows may be objects or raw strings) and other files below `root`.
export const writeTranscripts = (root, files) => {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const text = Array.isArray(content)
            ? content.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n"
            : typeof content === "string" ? content : JSON.stringify(content);
        fs.writeFileSync(target, text);
    }
};

// A price table with round numbers, so expected costs are easy to check by hand.
export const testPrices = () => ({
    unit: "USD per million tokens",
    source: "test",
    pricesAsOf: "2026-11-03",
    checkedOn: "2026-11-26",
    models: {
        "claude-opus-5-5": {
            standard: { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
            fast: { input: 8, output: 40 }
        },
        "claude-sonnet-5-5": {
            standard: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 }
        },
        "claude-haiku-5-5": {
            standard: { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
            longPrompt: { above: 100000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 }
        }
    }
});

// A call as readCalls returns it, for tests that start after reading.
export const call = (overrides = {}) => ({
    id: "msg-1",
    timestamp: "2026-11-26T10:00:00.000Z",
    sessionId: "session-1",
    sessions: ["session-1"],
    agentId: null,
    role: "orchestrator",
    agentDescription: null,
    model: "claude-opus-5-5",
    speed: "standard",
    input: 10,
    output: 100,
    thinking: 40,
    cacheWrite5m: 0,
    cacheWrite1h: 1000,
    cacheRead: 10000,
    webSearch: 0,
    webFetch: 0,
    cwd: ".",
    gitBranch: "main",
    ...overrides
});
