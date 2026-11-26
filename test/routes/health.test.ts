import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { httpError, jsonBody, modelList, neverAnswer, startFakeOllama } from "../doubles/fakeOllama.js";

// these tests change the dependencies' state between requests, so every request checks again
process.env.HEALTH_CACHE_SECONDS = "0";

// A fake Ollama, so these tests do not depend on the real one running on this computer.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");

after(async () => {
    await fake.close();
    await pool.end();
});

const BOTH_MODELS = ["qwen3.5:4b", "qwen3-embedding:0.6b"];

const getHealth = () => request(app).get("/v1/health");

describe("GET /v1/health", () => {
    it("reports ok when the database and Ollama with both models answer", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", modelList(BOTH_MODELS));
        const response = await getHealth();

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, { status: "ok", database: "up", ollama: "up" });
    });

    it("reports degraded when a required model is not installed", { timeout: 10_000 }, async () => {
        for (const installed of [["qwen3.5:4b"], ["qwen3-embedding:0.6b"], []]) {
            fake.respond("/api/tags", modelList(installed));
            const response = await getHealth();

            assert.equal(response.status, 200, installed.join(", "));
            assert.deepEqual(response.body.data, { status: "degraded", database: "up", ollama: "down" }, installed.join(", "));
        }
    });

    it("matches model names exactly: qwen3.5:latest is not qwen3.5:4b", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", modelList(["qwen3.5:latest", "qwen3-embedding:0.6b"]));
        const response = await getHealth();

        assert.deepEqual(response.body.data, { status: "degraded", database: "up", ollama: "down" });
    });

    it("reports degraded when Ollama answers with an error", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", httpError(500));
        const response = await getHealth();

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, { status: "degraded", database: "up", ollama: "down" });
    });

    it("reports degraded when Ollama answers with an unexpected shape", { timeout: 10_000 }, async () => {
        for (const body of [{ models: "x" }, { models: [{ name: 1 }] }, { unrelated: true }]) {
            fake.respond("/api/tags", jsonBody(body));
            const response = await getHealth();

            assert.equal(response.status, 200, JSON.stringify(body));
            assert.deepEqual(response.body.data, { status: "degraded", database: "up", ollama: "down" }, JSON.stringify(body));
        }
    });

    it("reports degraded, without hanging, when Ollama does not answer in time", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", neverAnswer);
        const started = Date.now();

        const response = await getHealth();

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.data, { status: "degraded", database: "up", ollama: "down" });
        assert.ok(Date.now() - started < 5000, "the check gave up after its own timeout");
    });

    it("is public and reveals nothing beyond the three states", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", modelList(BOTH_MODELS));
        const response = await getHealth();

        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(response.body.data).sort(), ["database", "ollama", "status"]);
        assert.equal(response.headers["x-powered-by"], undefined);
    });
});
