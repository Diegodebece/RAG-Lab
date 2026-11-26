import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropConnection, httpError, jsonBody, malformedBody, modelList, neverAnswer, startFakeOllama } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// The fake answers on a free port of this computer; the base URL is read when the service loads, so it is set first.
const fake = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { listInstalledModelsService } = await import("../../src/v1/services/ollama.service.js");
const { AppError } = await import("../../src/v1/utils/appError.util.js");
const { ModelUnavailableError } = await import("../../src/v1/utils/modelUnavailableError.util.js");

after(() => fake.close());

// Failures that are not the client's fault and not "Ollama is down": a plain Error, which errorMiddleware answers with a 500.
const isPlainError = (error: unknown): boolean => error instanceof Error && !(error instanceof AppError);

describe("listInstalledModelsService", () => {
    it("returns the names of the installed models", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList(["qwen3.5:4b", "qwen3-embedding:0.6b", "other-model:latest"]));

        const names = await listInstalledModelsService({ timeoutMs: 2000 });

        assert.deepEqual(names, ["qwen3.5:4b", "qwen3-embedding:0.6b", "other-model:latest"]);
        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "/api/tags" });
    });

    it("returns an empty list when no model is installed", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList([]));

        assert.deepEqual(await listInstalledModelsService({ timeoutMs: 2000 }), []);
    });

    it("throws ModelUnavailableError when the connection drops", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", dropConnection);

        await assert.rejects(
            listInstalledModelsService({ timeoutMs: 2000 }),
            (error: unknown) => error instanceof ModelUnavailableError
        );
    });

    it("throws a 504 AppError when Ollama never answers", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", neverAnswer);

        await assert.rejects(
            listInstalledModelsService({ timeoutMs: 200 }),
            (error: unknown) => error instanceof AppError
                && !(error instanceof ModelUnavailableError)
                && error.status === 504
                && error.message === "The model server did not answer in time"
        );
    });

    it("throws a plain Error, not an AppError, when Ollama answers with an error status", { timeout: 5000 }, async () => {
        for (const status of [500, 404]) {
            fake.respond("/api/tags", httpError(status));

            await assert.rejects(listInstalledModelsService({ timeoutMs: 2000 }), isPlainError, `status ${status}`);
        }
    });

    it("throws a plain Error, not an AppError, when the answer has an unexpected shape", { timeout: 5000 }, async () => {
        const answers: Record<string, FakeOllamaHandler> = {
            "models is not a list": jsonBody({ models: "x" }),
            "a model name is not a string": jsonBody({ models: [{ name: 1 }] }),
            "the body is not JSON": malformedBody
        };

        for (const [label, handler] of Object.entries(answers)) {
            fake.respond("/api/tags", handler);

            await assert.rejects(listInstalledModelsService({ timeoutMs: 2000 }), isPlainError, label);
        }
    });
});
