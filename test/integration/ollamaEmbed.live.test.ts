import { describe, it } from "node:test";
import assert from "node:assert/strict";

// An integration test: it needs the real Ollama with the embedding model installed, and is skipped unless
// RAG_LAB_LIVE_OLLAMA_URL names it (for example http://localhost:11434). Nothing else runs it, and it never runs by
// default: the unit and route tests use test/doubles/fakeOllama.ts. The texts are invented.
const LIVE_URL = process.env.RAG_LAB_LIVE_OLLAMA_URL;
const MODEL = "qwen3-embedding:0.6b";

const TEXTS = [
    "The lighthouse keeper counted the ships that passed in the night.",
    "A recipe for lentil soup needs onions, garlic and a little cumin.",
    "The committee postponed the vote until the budget was published.",
    "Moss grows thickest on the north side of the old stone wall.",
    "She repaired the clock with a screwdriver borrowed from her neighbour.",
    "Heavy rain closed the mountain pass for the third time this winter.",
    "The orchestra tuned to the oboe before the second movement began.",
    "A small boat drifted past the pier with its lantern still lit.",
    "The library keeps its oldest maps in a drawer lined with cedar.",
    "Wind turbines turned slowly above the empty salt marsh."
];

describe("the real embedding endpoint", { skip: LIVE_URL ? false : "set RAG_LAB_LIVE_OLLAMA_URL to run the tests that need a live model" }, () => {
    // the base URL is read when the service loads, so it is set before the service is imported
    const load = async () => {
        process.env.OLLAMA_BASE_URL = LIVE_URL;
        return import("../../src/v1/services/ollama.service.js");
    };

    it("returns vectors of 1024 dimensions and the token count Ollama reports", { timeout: 120_000 }, async () => {
        const { embedTextsService } = await load();

        const result = await embedTextsService(MODEL, [TEXTS[0]], { timeoutMs: 100_000 });

        assert.equal(result.embeddings.length, 1);
        assert.equal(result.embeddings[0].length, 1024);
        assert.ok(result.embeddings[0].some((value) => value !== 0));
        assert.ok(Number.isSafeInteger(result.promptTokens) && result.promptTokens > 0, `prompt_eval_count was ${result.promptTokens}`);
    });

    it("counts a batch of two texts as the sum of the two single calls", { timeout: 120_000 }, async () => {
        const { embedTextsService } = await load();

        const first = await embedTextsService(MODEL, [TEXTS[0]], { timeoutMs: 100_000 });
        const second = await embedTextsService(MODEL, [TEXTS[1]], { timeoutMs: 100_000 });
        const both = await embedTextsService(MODEL, [TEXTS[0], TEXTS[1]], { timeoutMs: 100_000 });

        assert.equal(both.promptTokens, first.promptTokens + second.promptTokens);
    });

    // Not an assertion: a batch of 10 and ten single calls may give slightly different vectors (padding, batching on the GPU).
    // The largest difference is printed, so the owner can see how much the batch size matters.
    it("reports the largest difference between a batch of 10 and 10 single calls", { timeout: 300_000 }, async () => {
        const { embedTextsService } = await load();

        const batch = await embedTextsService(MODEL, TEXTS, { timeoutMs: 100_000 });
        let largest = 0;

        for (const [position, text] of TEXTS.entries()) {
            const single = await embedTextsService(MODEL, [text], { timeoutMs: 100_000 });

            for (let dimension = 0; dimension < 1024; dimension++) {
                largest = Math.max(largest, Math.abs(batch.embeddings[position][dimension] - single.embeddings[0][dimension]));
            }
        }

        console.log(`largest difference between a batch of 10 and 10 single calls: ${largest}`);
        assert.equal(batch.embeddings.length, 10);
    });
});
