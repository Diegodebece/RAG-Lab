import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { rateLimitMiddleware } from "../../src/v1/middlewares/rateLimit.middleware.js";
import { errorMiddleware } from "../../src/v1/middlewares/error.middleware.js";

const MINUTE = 60_000;

// every test builds its own app, so counters never carry over between tests
const buildIpLimitedApp = (limit: number) => {
    const app = express();
    app.post("/register", rateLimitMiddleware({ limit, windowMs: MINUTE, keyBy: "ip" }), (req, res) => {
        res.status(201).json({ ok: true });
    });
    app.use(errorMiddleware);
    return app;
};

// a fake login: the right password succeeds, anything else is a 401
const buildFailedLoginApp = (limit: number) => {
    const app = express();
    app.use(express.json());
    app.post("/login", rateLimitMiddleware({ limit, windowMs: MINUTE, keyBy: "emailAndIp", onlyFailures: true }), (req, res) => {
        res.status(req.body.password === "right" ? 200 : 401).json({});
    });
    app.use(errorMiddleware);
    return app;
};

describe("failed-login limit and account lockout", () => {
    // Two clients behind a proxy on this computer, with the same trust proxy setting as the real app
    // (test/routes/clientAddress.test.ts checks the real app itself).
    const buildTwoClientApp = () => {
        const app = express();
        app.set("trust proxy", "loopback");
        app.use(express.json());
        app.post("/login", rateLimitMiddleware({ limit: 2, windowMs: MINUTE, keyBy: "emailAndIp", onlyFailures: true }), (req, res) => {
            res.status(req.body.password === "right" ? 200 : 401).json({});
        });
        app.use(errorMiddleware);
        return app;
    };

    it("does not let an attacker lock the owner out of their account", async () => {
        const app = request(buildTwoClientApp());

        for (let attempt = 0; attempt < 3; attempt++) {
            await app.post("/login").set("X-Forwarded-For", "203.0.113.66").send({ email: "victim@example.com", password: "guess" });
        }

        const owner = await app.post("/login").set("X-Forwarded-For", "198.51.100.7").send({ email: "victim@example.com", password: "right" });
        assert.equal(owner.status, 200);
    });

    it("still stops the attacker from guessing that account from their own address", async () => {
        const app = request(buildTwoClientApp());
        const guess = () => app.post("/login").set("X-Forwarded-For", "203.0.113.66").send({ email: "victim@example.com", password: "guess" });

        assert.equal((await guess()).status, 401);
        assert.equal((await guess()).status, 401);
        assert.equal((await guess()).status, 429);

        // the counter is that account's, not the address's: another account from the same address is not locked
        const other = await app.post("/login").set("X-Forwarded-For", "203.0.113.66").send({ email: "other@example.com", password: "guess" });
        assert.equal(other.status, 401);
    });

    // The counter belongs to the email and the address together: a count per address alone would also lock the
    // attacker's other accounts, and the owner of any account who shares their address (a household, an office).
    it("keeps a separate counter for each email from the same address", async () => {
        const app = request(buildTwoClientApp());
        const attempt = (email: string, password: string) =>
            app.post("/login").set("X-Forwarded-For", "203.0.113.66").send({ email, password });

        await attempt("victim@example.com", "guess");
        await attempt("victim@example.com", "guess");
        assert.equal((await attempt("victim@example.com", "guess")).status, 429, "the guessed account is locked for this address");

        assert.equal((await attempt("someone-else@example.com", "guess")).status, 401, "another account from this address has its own counter");
        assert.equal((await attempt("someone-else@example.com", "right")).status, 200, "and its owner can still log in from here");
    });
});

describe("rateLimitMiddleware", () => {
    it("answers 429 with the usual error body once a client passes the limit", async () => {
        const agent = request(buildIpLimitedApp(2));

        assert.equal((await agent.post("/register")).status, 201);
        assert.equal((await agent.post("/register")).status, 201);

        const blocked = await agent.post("/register");
        assert.equal(blocked.status, 429);
        assert.deepEqual(blocked.body, { message: "Too many requests, please try again later" });
    });

    it("tells the client its limit in standard headers", async () => {
        const response = await request(buildIpLimitedApp(3)).post("/register");

        assert.ok(response.headers["ratelimit-policy"]);
        assert.ok(response.headers["ratelimit"]);
    });

    it("counts only failed attempts when onlyFailures is set", async () => {
        const app = request(buildFailedLoginApp(2));

        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await app.post("/login").send({ email: "ana@example.com", password: "right" })).status, 200);
        }

        assert.equal((await app.post("/login").send({ email: "ana@example.com", password: "wrong" })).status, 401);
        assert.equal((await app.post("/login").send({ email: "ana@example.com", password: "wrong" })).status, 401);
        assert.equal((await app.post("/login").send({ email: "ana@example.com", password: "wrong" })).status, 429);
    });

    it("counts both Unicode spellings of an accented email together", async () => {
        const app = request(buildFailedLoginApp(2));
        const precomposed = `jos${String.fromCodePoint(0xe9)}@example.com`;
        const decomposed = `jose${String.fromCodePoint(0x301)}@example.com`;

        await app.post("/login").send({ email: precomposed, password: "wrong" });
        await app.post("/login").send({ email: decomposed, password: "wrong" });

        assert.equal((await app.post("/login").send({ email: precomposed, password: "wrong" })).status, 429);
    });

    it("counts the same email with any capitalization together, and other emails apart", async () => {
        const app = request(buildFailedLoginApp(2));

        await app.post("/login").send({ email: "ana@example.com", password: "wrong" });
        await app.post("/login").send({ email: "  ANA@Example.com ", password: "wrong" });

        assert.equal((await app.post("/login").send({ email: "Ana@example.com", password: "wrong" })).status, 429);
        assert.equal((await app.post("/login").send({ email: "bob@example.com", password: "wrong" })).status, 401);
    });
});

// The email is part of the key, and the key is held in memory: an email of 90,000 characters in each request would
// fill it with one entry of that size per request. Past the longest email there can be (254), the email stops being
// part of the key, so the address alone counts those requests, and the counters stay small.
describe("the email in the key of the failed-login limit", () => {
    const buildApp = () => {
        const app = express();
        app.set("trust proxy", "loopback");
        app.use(express.json({ limit: "1mb" }));
        app.post("/login", rateLimitMiddleware({ limit: 2, windowMs: MINUTE, keyBy: "emailAndIp", onlyFailures: true }), (req, res) => {
            res.status(401).json({});
        });
        app.use(errorMiddleware);
        return app;
    };

    // an address of exactly this many characters (what comes after the name is 12 characters)
    const emailOfLength = (length: number, filler: string): string => `${filler.repeat(length - 12)}@example.com`;

    const attempt = (app: ReturnType<typeof request>, email: string) =>
        app.post("/login").set("X-Forwarded-For", "203.0.113.66").send({ email, password: "wrong" });

    it("makes emails longer than 254 characters from one address share the address's counter", async () => {
        const app = request(buildApp());

        assert.equal((await attempt(app, emailOfLength(300, "a"))).status, 401);
        assert.equal((await attempt(app, emailOfLength(400, "b"))).status, 401);
        assert.equal((await attempt(app, emailOfLength(500, "c"))).status, 429, "a third, different long email is counted with the others");
    });

    it("takes the length after trimming: an email of 255 characters is long, with or without spaces around it", async () => {
        const app = request(buildApp());

        assert.equal((await attempt(app, `  ${emailOfLength(255, "a")}  `)).status, 401);
        assert.equal((await attempt(app, emailOfLength(255, "b"))).status, 401);
        assert.equal((await attempt(app, `${emailOfLength(255, "c")}   `)).status, 429);
    });

    it("keeps an email of exactly 254 characters on a counter of its own", async () => {
        const app = request(buildApp());

        assert.equal((await attempt(app, emailOfLength(254, "a"))).status, 401);
        assert.equal((await attempt(app, emailOfLength(254, "a"))).status, 401);
        assert.equal((await attempt(app, emailOfLength(254, "a"))).status, 429, "the same email is counted together");
        assert.equal((await attempt(app, emailOfLength(254, "b"))).status, 401, "another email of 254 characters has its own counter");
    });

    it("keeps an email that is padded with spaces to more than 254 characters, but fits once trimmed, on its own counter", async () => {
        const app = request(buildApp());
        const email = emailOfLength(254, "a");

        assert.equal((await attempt(app, `     ${email}     `)).status, 401);
        assert.equal((await attempt(app, email)).status, 401);
        assert.equal((await attempt(app, `${email} `)).status, 429, "all three spellings are one counter");
        assert.equal((await attempt(app, emailOfLength(254, "b"))).status, 401, "and it is not the address's counter");
    });

    it("keeps long emails away from the counter of a normal email from the same address", async () => {
        const app = request(buildApp());

        await attempt(app, emailOfLength(300, "a"));
        await attempt(app, emailOfLength(301, "a"));

        assert.equal((await attempt(app, "ana@example.com")).status, 401, "a normal email still has its own counter");
    });

    // keyed by the address alone, as before: a value that is not text cannot be an email
    it("counts a request whose email is not text on the address's counter", async () => {
        const app = request(buildApp());

        assert.equal((await attempt(app, ["a@example.com"] as unknown as string)).status, 401);
        assert.equal((await attempt(app, { $gt: "" } as unknown as string)).status, 401);
        assert.equal((await attempt(app, "" as string)).status, 429);
    });
});

describe("per-user limit", () => {
    // stands in for authenticateMiddleware: the test says who is logged in with a header. The limit runs before the
    // database is asked about the account, so it knows the token's user id and nothing else.
    const buildUserLimitedApp = (limit: number) => {
        const app = express();
        app.set("trust proxy", "loopback");
        app.use((req, res, next) => {
            const userId = req.header("X-Test-User");

            if (userId) {
                req.decoded = { id: userId, tokenVersion: 0, expiresAt: Date.now() + 60_000 };
            }

            next();
        });
        app.post("/ask", rateLimitMiddleware({ limit, windowMs: MINUTE, keyBy: "user" }), (req, res) => {
            res.status(200).json({ ok: true });
        });
        app.use(errorMiddleware);
        return app;
    };

    it("counts each user separately, whatever address they use", async () => {
        const app = request(buildUserLimitedApp(2));
        const ask = (userId: string, address: string) => app.post("/ask").set("X-Test-User", userId).set("X-Forwarded-For", address);

        assert.equal((await ask("ana", "203.0.113.1")).status, 200);
        assert.equal((await ask("ana", "203.0.113.2")).status, 200);
        assert.equal((await ask("ana", "203.0.113.3")).status, 429, "a new address does not reset the user's counter");
        assert.equal((await ask("bob", "203.0.113.1")).status, 200, "another user from the same address has their own counter");
    });

    it("falls back to the address when nobody is logged in", async () => {
        const app = request(buildUserLimitedApp(1));

        assert.equal((await app.post("/ask")).status, 200);
        assert.equal((await app.post("/ask")).status, 429);
    });
});
