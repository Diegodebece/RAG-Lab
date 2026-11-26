// Where Ollama listens: localhost during development, host.docker.internal once the API runs in Docker.
// A trailing slash is accepted and dropped, so a request path never starts with a doubled slash. The value is
// checked at startup by getStartupConfigProblems (env.config.ts).
export const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");

// The models the API needs installed to be fully healthy: the router and the embedding model. The answer
// models become profile settings (checked against caps) in a later layer, so they are not listed here.
export const REQUIRED_MODELS = ["qwen3.5:4b", "qwen3-embedding:0.6b"];
