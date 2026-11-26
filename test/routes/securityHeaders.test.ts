import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.SECRET_KEY = "test-secret-only-for-these-tests-0123456789";
// a low limit, so the 429 is easy to reach
process.env.HEALTH_CHECKS_PER_MINUTE = "3";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");

const expectedHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY"
};

const assertSecurityHeaders = (headers: Record<string, string>, label: string) => {
    for (const [name, value] of Object.entries(expectedHeaders)) {
        assert.equal(headers[name], value, `${label}: ${name}`);
    }
};

after(() => pool.end());

describe("security headers", () => {
    it("are sent on successful responses", { timeout: 10_000 }, async () => {
        const response = await request(app).get("/v1/health").set("X-Forwarded-For", "203.0.113.10");

        assert.equal(response.status, 200);
        assertSecurityHeaders(response.headers, "200");
    });

    it("are sent on error responses", { timeout: 10_000 }, async () => {
        // the health route allows 3 checks per address and minute: the fourth from one address is a 429
        for (let attempt = 0; attempt < 3; attempt++) {
            assert.equal((await request(app).get("/v1/health").set("X-Forwarded-For", "203.0.113.20")).status, 200);
        }

        const responses = {
            "401 without a token": { expected: 401, response: await request(app).get("/v1/nothing-here") },
            "404 outside /v1": { expected: 404, response: await request(app).get("/nothing-here") },
            "429 over the limit": { expected: 429, response: await request(app).get("/v1/health").set("X-Forwarded-For", "203.0.113.20") }
        };

        for (const [label, { expected, response }] of Object.entries(responses)) {
            assert.equal(response.status, expected, label);
            assertSecurityHeaders(response.headers, label);
        }
    });
});
