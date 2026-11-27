import { afterEach, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiClient } from "../../src/eval/apiClient.js";

// The harness talks to the API like any client, with an account of its own, over HTTP. The client logs in once and again on a 401, waits
// out a per-minute limit (and gives up on a daily one), retries a busy or timed-out server a few times, and refuses to send a password
// over plain http to a machine that is not this one.
//
// The contract this file gives the implementation (src/eval/apiClient.ts):
//   createApiClient({ baseUrl, email, password, sleep? }): { send(request): Promise<ApiResponse> }
//     throws at once (it sends nothing) for a baseUrl that is not http(s), or is http to a host that is not loopback (127.0.0.1, localhost, ::1)
//     send({ method, path, body? }): the first call logs in (POST /v1/auth/login with { email, password }; the token is the top-level
//       `token` of the answer) and every call sends `Authorization: Bearer <token>` and the JSON body
//       resolves with { status, body, attempts }: body is the JSON of the answer (null when it has none), attempts counts the requests
//       sent for this call, the login not included
//       401: logs in again, once, and sends the request again; a second 401 is returned as it is
//       429 with an entry of the RateLimit header that has r=0: sleeps that entry's t seconds (sleep(ms)) and sends it again
//       any other 429 (the daily limit): rejects with an Error whose message has the server's own message; nothing is sent again
//       503 or 504: sends it again, at most 3 more times, and then returns the 503 or 504 as it is
//       any other status is returned at once
//     a rejection never has the password or the token in its message
//   sleep is an injected function, so the tests do not wait

const PASSWORD = "invented-password-Zq83xk";
const EMAIL = "harness@example.com";

interface Call {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
    body: unknown;
}

interface Reply {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
}

// a small HTTP server that records what it receives and answers as the test says
const servers: Server[] = [];

const startFakeApi = async (answer: (call: Call, number: number) => Reply) => {
    const calls: Call[] = [];
    const server = createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on("data", (chunk: Buffer) => parts.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(parts).toString("utf8");
            const call: Call = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: raw === "" ? null : JSON.parse(raw) };
            calls.push(call);
            const reply = answer(call, calls.length);
            res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers }).end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
    }
});

after(() => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        server.close();
    }
});

const isLogin = (call: Call): boolean => call.path === "/v1/auth/login";

// answers a login with a new token each time, and every other request with the reply the test chose for it
const withLogin = (reply: (call: Call, number: number) => Reply) => {
    let logins = 0;

    return (call: Call, number: number): Reply => {
        if (isLogin(call)) {
            logins += 1;
            return { status: 200, body: { success: true, message: "Logged in successfully", data: {}, token: `token-${logins}` } };
        }

        return reply(call, number);
    };
};

const makeClient = (url: string, sleeps: number[] = []) =>
    createApiClient({ baseUrl: url, email: EMAIL, password: PASSWORD, sleep: async (milliseconds) => { sleeps.push(milliseconds); } });

const requestsTo = (calls: Call[], path: string): Call[] => calls.filter((call) => call.path === path);

describe("the API client: logging in", () => {
    it("logs in with the email and the password on the first call, once, and sends the token as a bearer token with every call", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin(() => ({ status: 200, body: { success: true, data: [] } })));
        const client = makeClient(api.url);

        const first = await client.send({ method: "GET", path: "/v1/documents" });
        const second = await client.send({ method: "GET", path: "/v1/configuration" });

        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { success: true, data: [] });
        assert.equal(first.attempts, 1);
        assert.equal(second.status, 200);
        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 1, "one login for two calls");
        assert.deepEqual(requestsTo(api.calls, "/v1/auth/login")[0].body, { email: EMAIL, password: PASSWORD });
        assert.equal(requestsTo(api.calls, "/v1/auth/login")[0].method, "POST");
        assert.deepEqual(api.calls.filter((call) => !isLogin(call)).map((call) => call.headers.authorization), ["Bearer token-1", "Bearer token-1"]);
    });

    it("sends the body as JSON, and gives back the JSON of the answer, whatever the status", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin((call) => ({ status: 400, body: { message: "Validation error", details: ["x"], echo: call.body } })));
        const client = makeClient(api.url);

        const response = await client.send({ method: "POST", path: "/v1/documents/abc/search", body: { question: "A question?", overrides: { topK: 30 } } });

        const sent = api.calls.find((call) => call.path === "/v1/documents/abc/search");
        assert.equal(sent?.headers["content-type"], "application/json");
        assert.deepEqual(sent?.body, { question: "A question?", overrides: { topK: 30 } });
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: "Validation error", details: ["x"], echo: { question: "A question?", overrides: { topK: 30 } } });
        assert.equal(response.attempts, 1, "a 400 is not tried again");
    });

    it("answers with a body of null when the answer has none", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin(() => ({ status: 503 })));
        const client = makeClient(api.url);

        assert.equal((await client.send({ method: "GET", path: "/v1/health" })).body, null);
    });

    it("logs in again, once, when a request is answered with 401, and sends the request again with the new token", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin((call) => (call.headers.authorization === "Bearer token-1" ? { status: 401, body: { message: "Invalid or expired authentication token" } } : { status: 200, body: { ok: true } })));
        const client = makeClient(api.url);

        const response = await client.send({ method: "GET", path: "/v1/documents" });

        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { ok: true });
        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 2);
        assert.deepEqual(requestsTo(api.calls, "/v1/documents").map((call) => call.headers.authorization), ["Bearer token-1", "Bearer token-2"]);

        await client.send({ method: "GET", path: "/v1/documents" });
        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 2, "the new token is kept: no login for the next call");
    });

    it("returns a second 401 as it is, and does not log in a third time", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin(() => ({ status: 401, body: { message: "Invalid or expired authentication token" } })));
        const client = makeClient(api.url);

        const response = await client.send({ method: "GET", path: "/v1/documents" });

        assert.equal(response.status, 401);
        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 2, "the first login and the one after the first 401");
        assert.equal(requestsTo(api.calls, "/v1/documents").length, 2);
    });

    it("rejects when the login is refused, without trying again and without the password in the message", { timeout: 15_000 }, async () => {
        const api = await startFakeApi((call) => (isLogin(call) ? { status: 401, body: { message: "Invalid email or password" } } : { status: 200 }));
        const client = makeClient(api.url);

        await assert.rejects(client.send({ method: "GET", path: "/v1/documents" }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes(PASSWORD), error.message);
            return true;
        });

        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 1);
        assert.equal(requestsTo(api.calls, "/v1/documents").length, 0);
    });
});

describe("the API client: the per-minute limit", () => {
    // what express-rate-limit writes (draft 8): one entry for each limiter the request went through, the one that refused it with r=0
    const RATE_LIMITED = { "RateLimit": "\"default\"; r=290; t=60, \"default\"; r=110; t=33, \"default\"; r=0; t=2" };

    it("waits the t seconds of the entry that has r=0, and sends the request again", { timeout: 15_000 }, async () => {
        const sleeps: number[] = [];
        const api = await startFakeApi(withLogin((_call, number) => (number <= 2 ? { status: 429, headers: RATE_LIMITED, body: { message: "Too many requests, please try again later" } } : { status: 200, body: { ok: true } })));
        const client = makeClient(api.url, sleeps);

        const response = await client.send({ method: "GET", path: "/v1/documents" });

        assert.equal(response.status, 200);
        assert.equal(response.attempts, 2);
        assert.equal(sleeps.length, 1);
        assert.ok(sleeps[0] >= 2000 && sleeps[0] <= 5000, `waited ${sleeps[0]} ms for a t of 2 seconds, and not the 60 of another entry`);
        assert.equal(requestsTo(api.calls, "/v1/documents").length, 2);
        assert.equal(requestsTo(api.calls, "/v1/auth/login").length, 1, "waiting is not logging in again");
    });

    it("reads an entry written with no space after the semicolons too", { timeout: 15_000 }, async () => {
        const sleeps: number[] = [];
        const api = await startFakeApi(withLogin((_call, number) => (number <= 2 ? { status: 429, headers: { "RateLimit": "\"default\";r=0;t=3" } } : { status: 200, body: {} })));

        await makeClient(api.url, sleeps).send({ method: "GET", path: "/v1/documents" });

        assert.ok(sleeps[0] >= 3000 && sleeps[0] <= 6000, `waited ${sleeps[0]} ms`);
    });
});

describe("the API client: the daily limit", () => {
    const DAILY = "You have reached the daily limit of questions, please try again later";

    it("rejects with the server's own message when a 429 has no entry with r=0, and sends nothing again", { timeout: 15_000 }, async () => {
        const sleeps: number[] = [];
        const api = await startFakeApi(withLogin(() => ({ status: 429, headers: { "RateLimit": "\"default\"; r=100; t=60, \"default\"; r=7; t=60" }, body: { message: DAILY } })));
        const client = makeClient(api.url, sleeps);

        await assert.rejects(client.send({ method: "POST", path: "/v1/documents/abc/search", body: { question: "Q?" } }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(DAILY), error.message);
            assert.ok(!error.message.includes(PASSWORD));
            return true;
        });

        assert.deepEqual(sleeps, [], "it did not wait");
        assert.equal(requestsTo(api.calls, "/v1/documents/abc/search").length, 1, "it did not try again");
    });

    it("treats a 429 with no RateLimit header at all the same way", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin(() => ({ status: 429, body: { message: DAILY } })));

        await assert.rejects(makeClient(api.url).send({ method: "GET", path: "/v1/documents" }), (error: unknown) => error instanceof Error && error.message.includes(DAILY));
    });
});

describe("the API client: a server that is busy or too slow", () => {
    for (const status of [503, 504]) {
        it(`sends a request that was answered with ${status} again, at most three more times, and then returns the ${status}`, { timeout: 15_000 }, async () => {
            const sleeps: number[] = [];
            const api = await startFakeApi(withLogin(() => ({ status, body: { message: "The server is busy, please try again in a few minutes" } })));
            const client = makeClient(api.url, sleeps);

            const response = await client.send({ method: "POST", path: "/v1/documents/abc/search", body: { question: "Q?" } });

            assert.equal(response.status, status);
            assert.equal(response.attempts, 4, "the request and three more");
            assert.equal(requestsTo(api.calls, "/v1/documents/abc/search").length, 4);
            assert.equal(sleeps.length, 3, "it waited between the tries");
        });
    }

    it("stops trying when the server answers: two 503 and then a 200 is a 200 after three requests", { timeout: 15_000 }, async () => {
        const api = await startFakeApi(withLogin((_call, number) => (number <= 3 ? { status: 503, body: {} } : { status: 200, body: { ok: true } })));

        const response = await makeClient(api.url).send({ method: "GET", path: "/v1/documents" });

        assert.equal(response.status, 200);
        assert.equal(response.attempts, 3);
    });

    it("does not try again a status that is not 503 or 504: 400, 404, 409 and 500 come back at once", { timeout: 15_000 }, async () => {
        for (const status of [400, 404, 409, 500]) {
            const api = await startFakeApi(withLogin(() => ({ status, body: { message: "no" } })));

            const response = await makeClient(api.url).send({ method: "GET", path: "/v1/documents" });

            assert.equal(response.status, status);
            assert.equal(response.attempts, 1, String(status));
            assert.equal(requestsTo(api.calls, "/v1/documents").length, 1, String(status));
        }
    });
});

describe("the API client: where it will send the password", () => {
    it("refuses plain http to a host that is not this computer, before it sends anything, naming https and never showing the password", () => {
        for (const baseUrl of ["http://example.test:3000", "http://192.168.0.5:3000", "http://10.0.0.1", "http://api.internal", "http://127.0.0.1.example.test:3000"]) {
            assert.throws(
                () => createApiClient({ baseUrl, email: EMAIL, password: PASSWORD }),
                (error: unknown) => error instanceof Error && /https/i.test(error.message) && !error.message.includes(PASSWORD),
                baseUrl
            );
        }
    });

    it("accepts plain http to a loopback host: 127.0.0.1, localhost and ::1, with or without a port", () => {
        for (const baseUrl of ["http://127.0.0.1:3000", "http://127.0.0.1", "http://localhost:3000", "http://localhost", "http://[::1]:3000"]) {
            assert.doesNotThrow(() => createApiClient({ baseUrl, email: EMAIL, password: PASSWORD }), baseUrl);
        }
    });

    it("accepts https to any host", () => {
        for (const baseUrl of ["https://api.example.test", "https://rag-lab.example.test:8443/", "https://192.168.0.5"]) {
            assert.doesNotThrow(() => createApiClient({ baseUrl, email: EMAIL, password: PASSWORD }), baseUrl);
        }
    });

    it("refuses an address that is not http or https, and one that is not an address", () => {
        for (const baseUrl of ["ftp://127.0.0.1", "file:///tmp/x", "127.0.0.1:3000", "not a url", ""]) {
            assert.throws(() => createApiClient({ baseUrl, email: EMAIL, password: PASSWORD }), Error, baseUrl);
        }
    });

    it("never prints the password or the token: a whole run with a login, a 401, a 429 that waits and a failure writes nothing to the console with either", { timeout: 20_000 }, async (t) => {
        const spies = (["log", "error", "warn", "info", "debug"] as const).map((name) => t.mock.method(console, name, () => {}));
        const api = await startFakeApi(withLogin((call, number) => {
            if (number === 2) {
                return { status: 401, body: { message: "Invalid or expired authentication token" } };
            }

            if (number === 4) {
                return { status: 429, headers: { "RateLimit": "\"default\"; r=0; t=1" }, body: { message: "Too many requests, please try again later" } };
            }

            return call.path === "/v1/documents" ? { status: 200, body: {} } : { status: 503, body: {} };
        }));
        const client = makeClient(api.url);

        await client.send({ method: "GET", path: "/v1/documents" });
        await client.send({ method: "GET", path: "/v1/documents" });
        await client.send({ method: "GET", path: "/v1/health" });

        const printed = spies.flatMap((spy) => spy.mock.calls.map((call) => call.arguments.map((argument) => String(argument)).join(" "))).join("\n");

        assert.ok(!printed.includes(PASSWORD), "the password");
        assert.ok(!/token-\d/.test(printed), "a token");
    });

    it("rejects, without the password in the message, when the server cannot be reached", { timeout: 15_000 }, async () => {
        const client = createApiClient({ baseUrl: "http://127.0.0.1:1", email: EMAIL, password: PASSWORD, sleep: async () => {} });

        await assert.rejects(client.send({ method: "GET", path: "/v1/documents" }), (error: unknown) => error instanceof Error && !error.message.includes(PASSWORD));
    });
});
