import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// The real app with its default proxy setting: the tests connect from this computer, as cloudflared does,
// and X-Forwarded-For carries the address Cloudflare saw. A low limit, so the counters are easy to reach.
process.env.HEALTH_CHECKS_PER_MINUTE = "2";
// the app's default; set rather than deleted, because the app would load a value from the developer's .env
process.env.TRUSTED_PROXIES = "loopback";

const { app } = await import("../../src/app.js");
const { pool } = await import("../../src/v1/config/db.config.js");

after(() => pool.end());

// a health check as seen through the tunnel: the client's address is in X-Forwarded-For
const checkFrom = (forwardedFor: string) => request(app).get("/v1/health").set("X-Forwarded-For", forwardedFor);

describe("client addresses behind the tunnel", () => {
    it("counts each forwarded address separately", { timeout: 10_000 }, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.equal((await checkFrom("203.0.113.66")).status, 200);
        }

        assert.equal((await checkFrom("203.0.113.66")).status, 429, "the address over its limit is blocked");
        assert.equal((await checkFrom("198.51.100.7")).status, 200, "another address, from the same proxy, is not");
    });

    it("ignores the addresses a client writes into the header itself", { timeout: 10_000 }, async () => {
        // Cloudflare appends the real address at the end; anything before it was written by the client
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.equal((await checkFrom("198.51.100.99, 203.0.113.77")).status, 200);
        }

        assert.equal((await checkFrom("198.51.100.42, 203.0.113.77")).status, 429, "a new fake address does not reset the counter");
        assert.equal((await checkFrom("198.51.100.99")).status, 200, "the address the client pretended to have is not blocked");
    });
});
