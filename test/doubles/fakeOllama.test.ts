import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cutResponse, dropConnection, embeddings, fakeTokenCount, fakeVectorFor, holdRequest, httpError, jsonBody, malformedBody, modelList, neverAnswer, redirectTo, startFakeOllama, waitForRequests } from "./fakeOllama.js";

// The double itself: every other test that uses it trusts these behaviors.
const fake = await startFakeOllama();

after(() => fake.close());

const embed = (body: unknown): Promise<Response> =>
    fetch(`${fake.url}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });

describe("fake Ollama", () => {
    it("answers with the model list and records the request", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList(["a:1", "b:2"]));

        const response = await fetch(`${fake.url}/api/tags`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { models: [{ name: "a:1" }, { name: "b:2" }] });
        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "/api/tags", body: null });
    });

    it("answers a path nobody set up with a 404", { timeout: 5000 }, async () => {
        const response = await fetch(`${fake.url}/api/unknown`);

        assert.equal(response.status, 404);
    });

    it("can answer with an error status, a body of another shape, or a body that is not JSON", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", httpError(500));
        assert.equal((await fetch(`${fake.url}/api/tags`)).status, 500);

        fake.respond("/api/tags", jsonBody({ models: "x" }));
        assert.deepEqual(await (await fetch(`${fake.url}/api/tags`)).json(), { models: "x" });

        fake.respond("/api/tags", malformedBody);
        const response = await fetch(`${fake.url}/api/tags`);
        assert.equal(response.status, 200);
        await assert.rejects(response.json());
    });

    it("records the path exactly as received, so a doubled slash shows", { timeout: 5000 }, async () => {
        await fetch(`${fake.url}//api/tags?x=1`);

        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "//api/tags", body: null });
    });

    it("records the body of a request: the JSON it carried, the text when it is not JSON, null when there is none", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", jsonBody({}));

        await embed({ model: "m:1", input: ["a", "b"], truncate: false });
        assert.deepEqual(fake.requests.at(-1), { method: "POST", path: "/api/embed", body: { model: "m:1", input: ["a", "b"], truncate: false } });

        await fetch(`${fake.url}/api/embed`, { method: "POST", body: "plain words" });
        assert.deepEqual(fake.requests.at(-1), { method: "POST", path: "/api/embed", body: "plain words" });

        await fetch(`${fake.url}/api/embed`, { method: "POST" });
        assert.deepEqual(fake.requests.at(-1), { method: "POST", path: "/api/embed", body: null });
    });

    it("can redirect, without following it for the caller", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", redirectTo("http://127.0.0.1:1/elsewhere", 307));

        const response = await fetch(`${fake.url}/api/tags`, { redirect: "manual" });

        assert.equal(response.status, 307);
        assert.equal(response.headers.get("location"), "http://127.0.0.1:1/elsewhere");
    });

    it("can drop the connection", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", dropConnection);

        await assert.rejects(fetch(`${fake.url}/api/tags`));
    });

    it("can cut an answer in the middle of its body: the status arrives, and reading the body fails", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", cutResponse);

        const response = await fetch(`${fake.url}/api/tags`, { signal: AbortSignal.timeout(4000) });

        assert.equal(response.status, 200);
        await assert.rejects(response.json(), (error: unknown) => error instanceof TypeError, "a read that ends early, not text that is not JSON");
    });

    it("can stay silent, and the caller's timeout ends the wait", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", neverAnswer);

        await assert.rejects(fetch(`${fake.url}/api/tags`, { signal: AbortSignal.timeout(200) }), { name: "TimeoutError" });
    });
});

describe("fake Ollama: the embed endpoint", () => {
    it("embeddings() answers one 1024-dimension vector per input, in order, never all zero, with prompt_eval_count", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        const response = await embed({ model: "m:1", input: ["first text", "second text here", "third"], truncate: false });
        const answer = await response.json() as { embeddings: number[][]; prompt_eval_count: number };

        assert.equal(response.status, 200);
        assert.equal(answer.embeddings.length, 3);

        for (const vector of answer.embeddings) {
            assert.equal(vector.length, 1024);
            assert.ok(vector.every((value) => Number.isFinite(value)));
            assert.ok(vector.some((value) => value !== 0), "never all zero");
        }

        assert.deepEqual(answer.embeddings[0], fakeVectorFor("first text"));
        assert.deepEqual(answer.embeddings[1], fakeVectorFor("second text here"));
        assert.notDeepEqual(answer.embeddings[0], answer.embeddings[1], "different texts, different vectors");
        assert.equal(answer.prompt_eval_count, fakeTokenCount("first text") + fakeTokenCount("second text here") + fakeTokenCount("third"));
    });

    it("embeddings() gives the same vector for the same text on every call", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        const first = await (await embed({ model: "m:1", input: ["same"] })).json() as { embeddings: number[][] };
        const second = await (await embed({ model: "m:1", input: ["same"] })).json() as { embeddings: number[][] };

        assert.deepEqual(first.embeddings, second.embeddings);
    });

    it("embeddings() can answer with the wrong dimensions, a zero vector or no token count, and can run code before it answers", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings({ dimensions: 3 }));
        assert.equal(((await (await embed({ model: "m:1", input: ["a"] })).json()) as { embeddings: number[][] }).embeddings[0].length, 3);

        fake.respond("/api/embed", embeddings({ zeroVector: true }));
        assert.ok(((await (await embed({ model: "m:1", input: ["a"] })).json()) as { embeddings: number[][] }).embeddings[0].every((value) => value === 0));

        fake.respond("/api/embed", embeddings({ omitTokenCount: true }));
        assert.equal("prompt_eval_count" in (await (await embed({ model: "m:1", input: ["a"] })).json() as object), false);

        let seen: string[] = [];
        fake.respond("/api/embed", embeddings({ beforeAnswer: (input) => { seen = input; } }));
        await embed({ model: "m:1", input: ["x", "y"] });
        assert.deepEqual(seen, ["x", "y"]);
    });

    it("embeddings() can put a chosen number first in every vector", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings({ firstValue: 1e39 }));

        const answer = await (await embed({ model: "m:1", input: ["a", "b"] })).json() as { embeddings: number[][] };

        assert.deepEqual(answer.embeddings.map((vector) => vector[0]), [1e39, 1e39]);
        assert.deepEqual(answer.embeddings[0].slice(1), fakeVectorFor("a").slice(1), "the rest of the vector is the usual one");
    });

    it("embeddings() answers 400 when the body has no list of inputs", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());

        assert.equal((await embed({ model: "m:1" })).status, 400);
    });

    it("holdRequest() tells when a request arrived and when the caller hung up", { timeout: 5000 }, async () => {
        const held = holdRequest();
        fake.respond("/api/embed", held.handler);
        const controller = new AbortController();

        const pending = fetch(`${fake.url}/api/embed`, { method: "POST", body: "{}", signal: controller.signal });
        pending.catch(() => {});
        await held.arrived;
        controller.abort();

        await held.closed;
        await assert.rejects(pending);
    });

    it("waitForRequests() waits for the count and fails, instead of waiting for ever, when it does not come", { timeout: 5000 }, async () => {
        fake.respond("/api/embed", embeddings());
        const before = fake.requests.filter((request) => request.path === "/api/embed").length;
        await embed({ model: "m:1", input: ["a"] });

        await waitForRequests(fake, "/api/embed", before + 1, 500);
        await assert.rejects(waitForRequests(fake, "/api/embed", before + 2, 200), /did not receive/);
    });
});
