// API-equivalent cost of a model call, from the price table in prices.json. It is what the same tokens would cost
// on the Claude API; a subscription plan bills differently. A price that cannot be computed is never guessed: the
// call is marked incomplete and the reason is kept.

import fs from "node:fs";

const RATE_KEYS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"];
const TOKEN_FIELDS = { input: "input", output: "output", cacheWrite5m: "cacheWrite5m", cacheWrite1h: "cacheWrite1h", cacheRead: "cacheRead" };

const checkRates = (model, card, rates, { complete }) => {
    for (const [key, value] of Object.entries(rates)) {
        if (key === "above") {
            continue;
        }
        if (!RATE_KEYS.includes(key) || typeof value !== "number" || !(value >= 0)) {
            throw new Error(`Invalid price: ${model} ${card} ${key}`);
        }
    }
    if (complete) {
        for (const key of RATE_KEYS) {
            if (typeof rates[key] !== "number") {
                throw new Error(`Invalid price: ${model} ${card} ${key} is missing`);
            }
        }
    }
};

// Reads and checks the price table (or checks `table` when given).
export const loadPrices = (filePath, table = JSON.parse(fs.readFileSync(filePath, "utf8"))) => {
    for (const [model, cards] of Object.entries(table.models ?? {})) {
        if (!cards.standard) {
            throw new Error(`Invalid price: ${model} has no standard rates`);
        }
        checkRates(model, "standard", cards.standard, { complete: true });
        for (const [card, rates] of Object.entries(cards)) {
            if (card !== "standard") {
                checkRates(model, card, rates, { complete: false });
            }
        }
        if (cards.longPrompt && !(Number.isInteger(cards.longPrompt.above) && cards.longPrompt.above > 0)) {
            throw new Error(`Invalid price: ${model} longPrompt needs "above", a token count`);
        }
    }
    return table;
};

const promptTokens = (call) => call.input + call.cacheRead + call.cacheWrite5m + call.cacheWrite1h;

// { cost (USD, or null), complete, card, notes }.
export const priceCall = (call, prices) => {
    const cards = prices.models[call.model];
    if (!cards) {
        return { cost: null, complete: false, card: null, notes: [`no price for model ${call.model}`] };
    }
    let card = "standard";
    if (call.speed === "fast") {
        card = "fast";
    } else if (cards.longPrompt && promptTokens(call) > cards.longPrompt.above) {
        card = "longPrompt";
    }
    const rates = cards[card];
    if (!rates) {
        return { cost: null, complete: false, card, notes: [`no ${card} price for model ${call.model}`] };
    }

    const notes = [];
    let cost = 0;
    for (const [key, field] of Object.entries(TOKEN_FIELDS)) {
        const tokens = call[field];
        if (tokens === 0) {
            continue;
        }
        if (typeof rates[key] !== "number") {
            notes.push(`no ${card} ${key} price for model ${call.model}`);
            continue;
        }
        cost += tokens * rates[key] / 1e6;
    }
    if (call.webSearch > 0 || call.webFetch > 0) {
        notes.push("web searches and fetches are not priced");
    }
    return { cost, complete: notes.length === 0, card, notes };
};
