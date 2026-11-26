import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelList, startFakeOllama } from "../doubles/fakeOllama.js";

// OLLAMA_BASE_URL is read when the service loads, so this case has a file (and a process) of its own: the
// address of the fake, written with a trailing slash as people often do.
const fake = await startFakeOllama();
fake.respond("/api/tags", modelList(["qwen3.5:4b"]));
process.env.OLLAMA_BASE_URL = `${fake.url}/`;

const { listInstalledModelsService } = await import("../../src/v1/services/ollama.service.js");

after(() => fake.close());

describe("OLLAMA_BASE_URL with a trailing slash", () => {
    it("asks for /api/tags, not //api/tags", { timeout: 5000 }, async () => {
        // a failure is looked at through the requests the fake received, which say what was asked
        let names: string[] | undefined;

        try {
            names = await listInstalledModelsService({ timeoutMs: 2000 });
        } catch {
            names = undefined;
        }

        assert.deepEqual(fake.requests, [{ method: "GET", path: "/api/tags" }]);
        assert.deepEqual(names, ["qwen3.5:4b"]);
    });
});
