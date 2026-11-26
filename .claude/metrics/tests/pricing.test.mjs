import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { loadPrices, priceCall } from "../lib/pricing.mjs";
import { METRICS_DIR, call, testPrices } from "./helpers.mjs";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

describe("priceCall", () => {
    test("prices each kind of token at its own rate", () => {
        // 10 input x 4 + 100 output x 20 + 1000 1h writes x 8 + 10000 reads x 0.2, per million
        const priced = priceCall(call(), testPrices());
        close(priced.cost, (40 + 2000 + 8000 + 2000) / 1e6);
        assert.equal(priced.complete, true);
        assert.equal(priced.card, "standard");
    });

    test("5-minute and 1-hour cache writes cost differently", () => {
        const fiveMinutes = priceCall(call({ cacheWrite5m: 1000, cacheWrite1h: 0 }), testPrices()).cost;
        const oneHour = priceCall(call({ cacheWrite5m: 0, cacheWrite1h: 1000 }), testPrices()).cost;
        close(oneHour - fiveMinutes, (8 - 5) * 1000 / 1e6);
    });

    test("thinking tokens are part of the output and are not charged again", () => {
        const withThinking = priceCall(call({ thinking: 90 }), testPrices()).cost;
        const without = priceCall(call({ thinking: 0 }), testPrices()).cost;
        close(withThinking, without);
    });

    test("Haiku uses the long-prompt rates above 100K prompt tokens", () => {
        const base = { model: "claude-haiku-5-5", input: 0, output: 1000, cacheWrite5m: 0, cacheWrite1h: 0 };
        const atLimit = priceCall(call({ ...base, cacheRead: 100000 }), testPrices());
        const above = priceCall(call({ ...base, cacheRead: 100001 }), testPrices());
        assert.equal(atLimit.card, "standard");
        assert.equal(above.card, "longPrompt");
        close(above.cost, (100001 * 0.05 + 1000 * 2.5) / 1e6);
    });

    test("an unknown model has no cost and marks the price incomplete", () => {
        const priced = priceCall(call({ model: "claude-new-9" }), testPrices());
        assert.equal(priced.cost, null);
        assert.equal(priced.complete, false);
        assert.match(priced.notes.join(" "), /claude-new-9/);
    });

    test("fast mode uses its own rates, and a rate it lacks leaves the price incomplete", () => {
        const outputOnly = priceCall(call({ speed: "fast", input: 0, cacheWrite1h: 0, cacheRead: 0 }), testPrices());
        assert.equal(outputOnly.card, "fast");
        close(outputOnly.cost, 100 * 40 / 1e6);
        assert.equal(outputOnly.complete, true);

        const withCache = priceCall(call({ speed: "fast" }), testPrices());
        assert.equal(withCache.complete, false);
        assert.match(withCache.notes.join(" "), /cacheRead/);

        const sonnetFast = priceCall(call({ model: "claude-sonnet-5-5", speed: "fast" }), testPrices());
        assert.equal(sonnetFast.cost, null);
        assert.equal(sonnetFast.complete, false);
    });

    test("web searches and fetches are not priced, so the price is incomplete", () => {
        const priced = priceCall(call({ webSearch: 1 }), testPrices());
        close(priced.cost, (40 + 2000 + 8000 + 2000) / 1e6);
        assert.equal(priced.complete, false);
        assert.match(priced.notes.join(" "), /web/);
    });
});

describe("prices.json", () => {
    test("says where its prices come from and prices every model the agents use", () => {
        const prices = loadPrices(path.join(METRICS_DIR, "prices.json"));
        assert.equal(prices.unit, "USD per million tokens");
        assert.ok(prices.source.length > 0);
        assert.match(prices.pricesAsOf, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(prices.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
        for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
            const rates = prices.models[model].standard;
            for (const key of ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"]) {
                assert.ok(typeof rates[key] === "number" && rates[key] > 0, `${model} ${key}`);
            }
        }
    });

    test("refuses a price table with a negative or missing rate", () => {
        assert.throws(() => loadPrices(null, { ...testPrices(), models: { m: { standard: { input: -1 } } } }), /m standard input/);
        assert.throws(() => loadPrices(null, { ...testPrices(), models: { m: {} } }), /m has no standard rates/);
    });
});
