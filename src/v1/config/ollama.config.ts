// Where Ollama listens: localhost during development, host.docker.internal once the API runs in Docker.
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// The models the API needs installed to be fully healthy: the router and the embedding model. The answer
// models become profile settings (checked against caps) in a later layer, so they are not listed here.
export const REQUIRED_MODELS = ["qwen3.5:4b", "qwen3-embedding:0.6b"];
