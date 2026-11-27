import { readIntegerSetting } from "./env.config.js";

// Where Ollama listens:localhost during development, host.docker.internal once the API runs in Docker.
// A trailing slash is accepted and dropped, so a request path never starts with a doubled slash. The value is
// checked at startup by getStartupConfigProblems (env.config.ts).
export const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");

// How long the API waits for one answer of Ollama before it gives up, from one second to ten minutes. A loaded model can
// take a while to answer the first time, so the default is two minutes.
export const OLLAMA_TIMEOUT_MS = readIntegerSetting("OLLAMA_TIMEOUT_MS", 120_000, 1000, 600_000);

// The models the API needs installed to be fully healthy: the router and the embedding model. The models a profile may
// choose are limited by the caps in configuration.config.ts, and the answer models are added there when they exist.
export const REQUIRED_MODELS = ["qwen3.5:4b", "qwen3-embedding:0.6b"];
