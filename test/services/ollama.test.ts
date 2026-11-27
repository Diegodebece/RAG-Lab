import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cutResponse, dropConnection, httpError, jsonBody, malformedBody, modelList, neverAnswer, redirectTo, startFakeOllama } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// The fake answers on a free port of this computer; the base URL is read when the service loads, so it is set first.
const fake = await startFakeOllama();
// a second server, where the first one sends redirects: it must never receive a request
const redirectTarget = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { listInstalledModelsService, listInstalledModelDigestsService } = await import("../../src/v1/services/ollama.service.js");
const { AppError } = await import("../../src/v1/utils/appError.util.js");
const { ModelUnavailableError } = await import("../../src/v1/utils/modelUnavailableError.util.js");
const { MalformedModelAnswerError } = await import("../../src/v1/utils/malformedModelAnswerError.util.js");

after(async () => {
    await fake.close();
    await redirectTarget.close();
});

// Failures that are not the client's fault and not "Ollama is down": a plain Error, which errorMiddleware answers with a 500.
const isPlainError = (error: unknown): boolean => error instanceof Error && !(error instanceof AppError);

// The digest of each installed model (decision D2 of layer 5): the evaluation harness records them at the start and the end of a
// sweep, to see whether a model was pulled again in the middle of it. The health and indexing callers keep using the names only.
describe("listInstalledModelDigestsService", () => {
    it("returns the name and the digest of each installed model, in the order Ollama lists them", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList([{ name: "qwen3.5:4b", digest: "aaa111" }, { name: "qwen3-embedding:0.6b", digest: "bbb222" }]));

        const models = await listInstalledModelDigestsService({ timeoutMs: 2000 });

        assert.deepEqual(models, [{ name: "qwen3.5:4b", digest: "aaa111" }, { name: "qwen3-embedding:0.6b", digest: "bbb222" }]);
        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "/api/tags", body: null });
    });

    it("returns a digest of null, and not a missing one, for a model whose entry has no digest, and for one whose digest is not text", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", jsonBody({ models: [{ name: "no-digest:1" }, { name: "number:1", digest: 5 }, { name: "kept:1", digest: "ccc333" }] }));

        const models = await listInstalledModelDigestsService({ timeoutMs: 2000 });

        assert.deepEqual(models, [
            { name: "no-digest:1", digest: null },
            { name: "number:1", digest: null },
            { name: "kept:1", digest: "ccc333" }
        ]);
        assert.ok(Object.hasOwn(models[0], "digest"), "the key is there, with a null");
    });

    it("returns an empty list when no model is installed", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList([]));

        assert.deepEqual(await listInstalledModelDigestsService({ timeoutMs: 2000 }), []);
    });

    it("throws a plain Error, not an AppError, when the answer is not a list of models with names", { timeout: 5000 }, async () => {
        for (const body of [{ models: "x" }, { models: [{ digest: "abc" }] }, { models: [5] }, { nothing: true }, "text", null]) {
            fake.respond("/api/tags", jsonBody(body));

            await assert.rejects(listInstalledModelDigestsService({ timeoutMs: 2000 }), isPlainError, JSON.stringify(body));
        }
    });

    it("fails like listInstalledModelsService when Ollama cannot be reached or does not answer: ModelUnavailableError for a dropped connection, a 504 for silence, a plain Error for an error status", { timeout: 10_000 }, async () => {
        fake.respond("/api/tags", dropConnection);
        await assert.rejects(listInstalledModelDigestsService({ timeoutMs: 2000 }), (error: unknown) => error instanceof ModelUnavailableError);

        fake.respond("/api/tags", neverAnswer);
        await assert.rejects(listInstalledModelDigestsService({ timeoutMs: 200 }), (error: unknown) => error instanceof AppError && error.status === 504);

        fake.respond("/api/tags", httpError(500));
        await assert.rejects(listInstalledModelDigestsService({ timeoutMs: 2000 }), isPlainError);
    });

    it("does not change what listInstalledModelsService returns for the same answer: the names", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList([{ name: "a:1", digest: "d1" }, "b:2"]));

        assert.deepEqual(await listInstalledModelsService({ timeoutMs: 2000 }), ["a:1", "b:2"]);
    });
});

describe("listInstalledModelsService", () => {
    it("returns the names of the installed models", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList(["qwen3.5:4b", "qwen3-embedding:0.6b", "other-model:latest"]));

        const names = await listInstalledModelsService({ timeoutMs: 2000 });

        assert.deepEqual(names, ["qwen3.5:4b", "qwen3-embedding:0.6b", "other-model:latest"]);
        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "/api/tags", body: null });
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

    // a connection that closes in the middle of the body is the connection failing, as much as one that never opened: it is
    // not an answer that is wrong (MalformedModelAnswerError), and the caller must be able to treat it as "away"
    it("throws ModelUnavailableError, not MalformedModelAnswerError, when the connection closes in the middle of the body", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", cutResponse);

        await assert.rejects(
            listInstalledModelsService({ timeoutMs: 2000 }),
            (error: unknown) => error instanceof ModelUnavailableError && !(error instanceof MalformedModelAnswerError)
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

    // A model server that redirects is misconfigured or has been taken over: following it would send the request
    // to an address nobody chose. The redirect is an error answer like any other, and its target is never asked.
    it("does not follow a redirect: throws a plain Error and the target receives nothing", { timeout: 5000 }, async () => {
        redirectTarget.respond("/api/tags", modelList(["qwen3.5:4b", "qwen3-embedding:0.6b"]));

        for (const status of [301, 302, 303, 307, 308]) {
            fake.respond("/api/tags", redirectTo(`${redirectTarget.url}/api/tags`, status));

            await assert.rejects(listInstalledModelsService({ timeoutMs: 2000 }), isPlainError, `status ${status}`);
            assert.deepEqual(redirectTarget.requests, [], `status ${status}: the redirect target was asked`);
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

    it("throws MalformedModelAnswerError, and not ModelUnavailableError, when the whole body arrives and is not JSON", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", malformedBody);

        await assert.rejects(
            listInstalledModelsService({ timeoutMs: 2000 }),
            (error: unknown) => error instanceof MalformedModelAnswerError && !(error instanceof ModelUnavailableError)
        );
    });
});
