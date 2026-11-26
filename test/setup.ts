// Loaded with --import before every test file: points the app's pool at the test database and keeps the
// tests away from the real model server.
import "dotenv/config";

// Without RAG_LAB_TEST_DATABASE_URL, DATABASE_URL is removed rather than left pointing at the development
// database, so db.config.ts fails with "DATABASE_URL is not set" instead of emptying real data.
if (process.env.RAG_LAB_TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.RAG_LAB_TEST_DATABASE_URL;
} else {
    delete process.env.DATABASE_URL;
}

// A closed port: a test that forgets to start the fake Ollama gets "connection refused" instead of reaching the
// real models on this computer. Tests that need an answer point OLLAMA_BASE_URL at test/doubles/fakeOllama.ts.
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
