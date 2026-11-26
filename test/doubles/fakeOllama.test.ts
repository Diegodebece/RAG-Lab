import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropConnection, httpError, jsonBody, malformedBody, modelList, neverAnswer, startFakeOllama } from "./fakeOllama.js";

// The double itself: every other test that uses it trusts these behaviors.
const fake = await startFakeOllama();

after(() => fake.close());

describe("fake Ollama", () => {
    it("answers with the model list and records the request", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", modelList(["a:1", "b:2"]));

        const response = await fetch(`${fake.url}/api/tags`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { models: [{ name: "a:1" }, { name: "b:2" }] });
        assert.deepEqual(fake.requests.at(-1), { method: "GET", path: "/api/tags" });
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

    it("can drop the connection", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", dropConnection);

        await assert.rejects(fetch(`${fake.url}/api/tags`));
    });

    it("can stay silent, and the caller's timeout ends the wait", { timeout: 5000 }, async () => {
        fake.respond("/api/tags", neverAnswer);

        await assert.rejects(fetch(`${fake.url}/api/tags`, { signal: AbortSignal.timeout(200) }), { name: "TimeoutError" });
    });
});
