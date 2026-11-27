import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropConnection, embeddings, fakeTokenCount, fakeVectorFor, holdRequest, httpError, jsonBody, malformedBody, neverAnswer, redirectTo, startFakeOllama } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// The fake answers on a free port of this computer; the base URL is read when the service loads, so it is set first.
const fake = await startFakeOllama();
// a second server, where the first one sends redirects: it must never receive a request
const redirectTarget = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fake.url;

const { embedTextsService } = await import("../../src/v1/services/ollama.service.js");
const { AppError } = await import("../../src/v1/utils/appError.util.js");
const { ModelUnavailableError } = await import("../../src/v1/utils/modelUnavailableError.util.js");
const { RequestCancelledError } = await import("../../src/v1/utils/requestCancelledError.util.js");

after(async () => {
    await fake.close();
    await redirectTarget.close();
});

const MODEL = "qwen3-embedding:0.6b";

// Failures that are not the client's fault and not "Ollama is down": a plain Error, which errorMiddleware answers with a 500.
const isPlainError = (error: unknown): boolean => error instanceof Error && !(error instanceof AppError);

const embedRequests = () => fake.requests.filter((request) => request.path === "/api/embed");

// an answer with the right shape for n inputs, for a test to damage one part of
const goodAnswer = (inputs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: MODEL,
    embeddings: Array.from({ length: inputs }, (_, index) => fakeVectorFor(`text ${index}`)),
    prompt_eval_count: 7,
    ...overrides
});

describe("embedTextsService: the request", () => {
    it("sends POST /api/embed with exactly the model, the inputs and truncate: false", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        await embedTextsService(MODEL, ["first text", "second text"], { timeoutMs: 2000 });

        assert.deepEqual(embedRequests().at(-1), { method: "POST", path: "/api/embed", body: { model: MODEL, input: ["first text", "second text"], truncate: false } });
    });

    it("sends the model the caller names, whatever it is", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        await embedTextsService("another-model:7b", ["text"], { timeoutMs: 2000 });

        assert.equal((embedRequests().at(-1)?.body as { model: string }).model, "another-model:7b");
    });
});

describe("embedTextsService: the answer", () => {
    it("returns the vectors in the order of the inputs, and promptTokens from prompt_eval_count", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", jsonBody(goodAnswer(3, { prompt_eval_count: 42 })));

        const result = await embedTextsService(MODEL, ["a", "b", "c"], { timeoutMs: 2000 });

        assert.deepEqual(result.embeddings, [fakeVectorFor("text 0"), fakeVectorFor("text 1"), fakeVectorFor("text 2")]);
        assert.equal(result.promptTokens, 42);
        assert.deepEqual(Object.keys(result).sort(), ["embeddings", "promptTokens"]);
    });

    it("returns what the double computes for each text, and the sum of the token counts", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        const result = await embedTextsService(MODEL, ["one short text", "a second and somewhat longer text"], { timeoutMs: 2000 });

        assert.deepEqual(result.embeddings, [fakeVectorFor("one short text"), fakeVectorFor("a second and somewhat longer text")]);
        assert.equal(result.promptTokens, fakeTokenCount("one short text") + fakeTokenCount("a second and somewhat longer text"));
    });

    it("accepts a token count of 0", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", jsonBody(goodAnswer(1, { prompt_eval_count: 0 })));

        assert.equal((await embedTextsService(MODEL, ["a"], { timeoutMs: 2000 })).promptTokens, 0);
    });
});

describe("embedTextsService: when Ollama cannot be used", () => {
    it("throws ModelUnavailableError when the connection drops", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", dropConnection);

        await assert.rejects(embedTextsService(MODEL, ["a"], { timeoutMs: 2000 }), (error: unknown) => error instanceof ModelUnavailableError);
    });

    it("throws a 504 AppError when Ollama does not answer within the time given (200 ms here)", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", neverAnswer);

        await assert.rejects(
            embedTextsService(MODEL, ["a"], { timeoutMs: 200 }),
            (error: unknown) => error instanceof AppError
                && !(error instanceof ModelUnavailableError)
                && !(error instanceof RequestCancelledError)
                && error.status === 504
                && error.message === "The model server did not answer in time"
        );
    });

    it("throws a plain Error, not an AppError, when Ollama answers an error status (400 and 500)", { timeout: 5000 }, async () => {
        for (const status of [400, 500]) {
            fake.respond("/api/embed", httpError(status));

            await assert.rejects(embedTextsService(MODEL, ["a"], { timeoutMs: 2000 }), isPlainError, `status ${status}`);
        }
    });

    // A model server that redirects is misconfigured or has been taken over: following it would send the texts of a
    // document to an address nobody chose. The redirect is an error answer like any other, and its target is never asked.
    it("does not follow a redirect: throws a plain Error and the target receives nothing", { timeout: 5000 }, async () => {
        redirectTarget.respond("/api/embed", embeddings());

        for (const status of [301, 302, 303, 307, 308]) {
            fake.respond("/api/embed", redirectTo(`${redirectTarget.url}/api/embed`, status));

            await assert.rejects(embedTextsService(MODEL, ["a secret document"], { timeoutMs: 2000 }), isPlainError, `status ${status}`);
            assert.deepEqual(redirectTarget.requests, [], `status ${status}: the redirect target was asked`);
        }
    });
});

describe("embedTextsService: an answer that is not what the API needs", () => {
    const damaged: Record<string, FakeOllamaHandler> = {
        "fewer vectors than inputs": jsonBody(goodAnswer(1)),
        "more vectors than inputs": jsonBody(goodAnswer(3)),
        "no vectors at all": jsonBody(goodAnswer(2, { embeddings: [] })),
        "vectors of 3 dimensions": jsonBody(goodAnswer(2, { embeddings: [[1, 2, 3], [1, 2, 3]] })),
        "a vector of 1023 numbers": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), fakeVectorFor("b", 1023)] })),
        "a vector of 1025 numbers": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), fakeVectorFor("b", 1025)] })),
        "a text where a number should be": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), [...fakeVectorFor("b").slice(0, 1023), "0.5"]] })),
        "a null where a number should be": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), [...fakeVectorFor("b").slice(0, 1023), null]] })),
        "a vector that is not a list": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), "not a vector"] })),
        "an all-zero vector": jsonBody(goodAnswer(2, { embeddings: [fakeVectorFor("a"), new Array<number>(1024).fill(0)] })),
        "no prompt_eval_count": jsonBody((() => { const { prompt_eval_count: _unused, ...rest } = goodAnswer(2); return rest; })()),
        "a negative prompt_eval_count": jsonBody(goodAnswer(2, { prompt_eval_count: -1 })),
        "a fractional prompt_eval_count": jsonBody(goodAnswer(2, { prompt_eval_count: 2.5 })),
        "a prompt_eval_count written as text": jsonBody(goodAnswer(2, { prompt_eval_count: "7" })),
        "a prompt_eval_count that is null": jsonBody(goodAnswer(2, { prompt_eval_count: null })),
        "embeddings that are not a list": jsonBody(goodAnswer(2, { embeddings: "x" })),
        "no embeddings key": jsonBody({ model: MODEL, prompt_eval_count: 7 }),
        "an answer that is not an object": jsonBody([1, 2, 3]),
        "a body that is not JSON": malformedBody
    };

    for (const [label, handler] of Object.entries(damaged)) {
        it(`throws a plain Error, not an AppError, for ${label}`, { timeout: 5000 }, async () => {
            fake.respond("/api/embed", handler);

            await assert.rejects(embedTextsService(MODEL, ["a", "b"], { timeoutMs: 2000 }), isPlainError);
        });
    }

    it("takes the very answer the double gives for the same two texts, so the cases above are refused for what is wrong with them", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        const result = await embedTextsService(MODEL, ["a", "b"], { timeoutMs: 2000 });

        assert.equal(result.embeddings.length, 2);
    });
});

describe("embedTextsService: a caller that gives up", () => {
    it("throws RequestCancelledError, and not the 504 of the timeout, when the caller's signal aborts in the middle of the request", { timeout: 8000 }, async () => {
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);
        const controller = new AbortController();

        // a timeout much longer than the test: only the abort can end this call
        const pending = embedTextsService(MODEL, ["a"], { timeoutMs: 60_000, signal: controller.signal });
        pending.catch(() => {});
        await held.arrived;
        controller.abort();

        await assert.rejects(pending, (error: unknown) => error instanceof RequestCancelledError);
        await Promise.race([held.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the request was still open at the double")), 3000))]);
    });

    it("throws RequestCancelledError and sends nothing when the signal was aborted before the call", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());
        const before = embedRequests().length;
        const controller = new AbortController();
        controller.abort();

        await assert.rejects(embedTextsService(MODEL, ["a"], { timeoutMs: 2000, signal: controller.signal }), (error: unknown) => error instanceof RequestCancelledError);

        assert.equal(embedRequests().length, before, "no request reached Ollama");
    });

    it("still gives the 504 when only the timeout fires and a signal was given that never aborts", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", neverAnswer);
        const controller = new AbortController();

        await assert.rejects(
            embedTextsService(MODEL, ["a"], { timeoutMs: 200, signal: controller.signal }),
            (error: unknown) => error instanceof AppError && error.status === 504 && !(error instanceof RequestCancelledError)
        );
    });
});
