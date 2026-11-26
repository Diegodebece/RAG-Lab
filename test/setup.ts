// Loaded with --import before every test file: points the app's pool at the test database, gives the app's
// operational settings the same values on every computer, and keeps the tests away from the real model server.
import "dotenv/config";
import { OPERATIONAL_DEFAULTS } from "./operationalSettings.js";

// The app runs as the API role (rag_lab_api), which can read and write the tables but cannot change the schema; the
// migrations and the tests' own setup (DDL, TRUNCATE, seeding) run as the owner. Each URL has its own variable, so
// the tests exercise the app with the rights it has in production.
//
// A missing source variable removes its target rather than leaving it pointing at the development database, so the
// app fails with "DATABASE_URL is not set" (and the migration script with "MIGRATION_DATABASE_URL is not set")
// instead of emptying real data.
const copyOrDelete = (source: string, target: string): void => {
    const value = process.env[source];

    if (value) {
        process.env[target] = value;
    } else {
        delete process.env[target];
    }
};

copyOrDelete("RAG_LAB_TEST_API_DATABASE_URL", "DATABASE_URL");
copyOrDelete("RAG_LAB_TEST_DATABASE_URL", "MIGRATION_DATABASE_URL");

// The developer's .env (loaded above) and shell may hold their own HOST, PORT, TRUSTED_PROXIES, limits and
// model server address. A test that reads one of them passes on one computer and fails on another, so each is
// set to the app's default here, before any app module loads. They are set to a value rather than deleted
// because the app loads .env itself: a deleted variable would be filled in from the file again. Among them,
// OLLAMA_BASE_URL is a closed port: a test that forgets to start the fake Ollama gets "connection refused"
// instead of reaching the real models on this computer. Tests that need an answer point OLLAMA_BASE_URL at
// test/doubles/fakeOllama.ts.
Object.assign(process.env, OPERATIONAL_DEFAULTS);
