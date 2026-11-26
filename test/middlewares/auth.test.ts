import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { authenticateMiddleware } from "../../src/v1/middlewares/authenticate.middleware.js";
import { authorizeMiddleware } from "../../src/v1/middlewares/authorize.middleware.js";
import { errorMiddleware } from "../../src/v1/middlewares/error.middleware.js";

// No database here: authenticateMiddleware only reads the token, and authorizeMiddleware only reads what the
// current user middleware put in req.user (test/middlewares/currentUser.test.ts covers that one against a database).
const SECRET = "test-secret-only-for-these-tests";
const USER_ID = "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c";

// the claims of a valid token, with the issuer and the audience written out
const claims = { sub: USER_ID, ver: 3, iss: "rag-lab", aud: "rag-lab-api" };

const sign = (payload: object = claims, options: jwt.SignOptions = {}, secret = SECRET): string =>
    jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "1h", ...options });

// a token with "alg": "none" and no signature, the classic forged token
const unsignedToken = (): string => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none", typ: "JWT" })}.${encode({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
};

// Stands in for currentUserMiddleware: the test says who the current user is, with a header, and the role is the
// header's, whatever the token says.
const asCurrentUser = (req: Request, res: Response, next: NextFunction): void => {
    const role = req.header("X-Test-Role");

    if (role === "user" || role === "admin") {
        req.user = { id: USER_ID, role, expiresAt: Date.now() + 60_000 };
    }

    next();
};

const buildApp = () => {
    const app = express();
    app.get("/me", authenticateMiddleware, (req, res) => res.json({ decoded: req.decoded }));
    app.get("/admin", authenticateMiddleware, asCurrentUser, authorizeMiddleware(["admin"]), (req, res) => res.json({ ok: true }));
    app.get("/anyone", authenticateMiddleware, asCurrentUser, authorizeMiddleware(["user", "admin"]), (req, res) => res.json({ ok: true }));
    // authenticated, but nothing loaded the current user
    app.get("/admin-without-current-user", authenticateMiddleware, authorizeMiddleware(["admin"]), (req, res) => res.json({ ok: true }));
    app.get("/admin-without-login", authorizeMiddleware(["admin"]), (req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    return app;
};

const getWithToken = (path: string, token: string) => request(buildApp()).get(path).set("Authorization", `Bearer ${token}`);

const withSecret = (): void => {
    let previousSecret: string | undefined;

    beforeEach(() => {
        previousSecret = process.env.SECRET_KEY;
        process.env.SECRET_KEY = SECRET;
    });

    afterEach(() => {
        if (previousSecret === undefined) {
            delete process.env.SECRET_KEY;
        } else {
            process.env.SECRET_KEY = previousSecret;
        }
    });
};

describe("authenticateMiddleware", () => {
    withSecret();

    it("puts the token's user id, token version and expiry in req.decoded, and nothing else", async () => {
        const token = sign();
        const { exp } = jwt.decode(token) as jwt.JwtPayload;

        const response = await getWithToken("/me", token);

        assert.equal(response.status, 200);
        assert.deepEqual(response.body.decoded, { id: USER_ID, tokenVersion: 3, expiresAt: (exp ?? 0) * 1000 });
    });

    it("does not pass on a role or any other claim the token carries", async () => {
        const response = await getWithToken("/me", sign({ ...claims, role: "admin", extra: "claim" }));

        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(response.body.decoded).sort(), ["expiresAt", "id", "tokenVersion"]);
    });

    it("rejects a request without a token", async () => {
        const response = await request(buildApp()).get("/me");

        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { message: "Authentication token is missing" });
    });

    it("rejects a header that does not use the Bearer scheme", async () => {
        for (const header of [`Basic ${sign()}`, "Basic abc", `Token ${sign()}`, sign()]) {
            const response = await request(buildApp()).get("/me").set("Authorization", header);

            assert.equal(response.status, 401, header);
        }
    });

    it("accepts the Bearer scheme in any capitalization", async () => {
        for (const scheme of ["bearer", "BEARER", "bEaReR"]) {
            const response = await request(buildApp()).get("/me").set("Authorization", `${scheme} ${sign()}`);

            assert.equal(response.status, 200, scheme);
            assert.equal(response.body.decoded.id, USER_ID, scheme);
        }
    });

    it("rejects a header with anything after the token", async () => {
        for (const extra of ["junk", "Bearer", sign()]) {
            const response = await request(buildApp()).get("/me").set("Authorization", `Bearer ${sign()} ${extra}`);

            assert.equal(response.status, 401, extra);
        }
    });

    it("rejects an empty token, also when the extra space hides a valid-looking one behind it", async () => {
        // two spaces: the token between them is empty
        for (const header of [`Bearer  ${sign()}`, "Bearer  x", "Bearer", "Bearer  "]) {
            const response = await request(buildApp()).get("/me").set("Authorization", header);

            assert.equal(response.status, 401, JSON.stringify(header));
        }
    });

    it("rejects malformed, expired, foreign and unsigned tokens with the same message", async () => {
        const tokens = {
            malformed: "not-a-token",
            expired: sign(claims, { expiresIn: -10 }),
            "signed with another secret": sign(claims, {}, "another-secret"),
            unsigned: unsignedToken(),
            "signed with another algorithm": sign(claims, { algorithm: "HS512" })
        };

        for (const [label, token] of Object.entries(tokens)) {
            const response = await getWithToken("/me", token);

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, { message: "Invalid or expired authentication token" }, label);
        }
    });

    it("rejects a correctly signed token with another issuer or another audience", async () => {
        // the same claims with this API's issuer and audience are accepted, so only those two differ below
        assert.equal((await getWithToken("/me", sign())).status, 200);

        const tokens = {
            "another issuer": sign({ ...claims, iss: "rag-web" }),
            "no issuer": sign({ sub: USER_ID, ver: 3, aud: "rag-lab-api" }),
            "another audience": sign({ ...claims, aud: "rag-web-api" }),
            "no audience": sign({ sub: USER_ID, ver: 3, iss: "rag-lab" })
        };

        for (const [label, token] of Object.entries(tokens)) {
            const response = await getWithToken("/me", token);

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, { message: "Invalid or expired authentication token" }, label);
        }
    });

    it("rejects a correctly signed token whose payload does not have the expected shape", async () => {
        const payloads = {
            "no subject": { ver: 3, iss: "rag-lab", aud: "rag-lab-api" },
            "subject that is not a UUID": { ...claims, sub: "' OR 1=1 --" },
            "numeric subject": { ...claims, sub: 42 },
            "no version": { sub: USER_ID, iss: "rag-lab", aud: "rag-lab-api" },
            "negative version": { ...claims, ver: -1 },
            "fractional version": { ...claims, ver: 0.5 },
            "version as text": { ...claims, ver: "3" },
            // what layer 1 signed: it never meant a user, and it must not open anything now
            "a token of the earlier design": { id: USER_ID, role: "admin", iss: "rag-lab", aud: "rag-lab-api" },
            "a token of the earlier design, without issuer or audience": { id: USER_ID, role: "admin" }
        };

        for (const [label, body] of Object.entries(payloads)) {
            const response = await getWithToken("/me", sign(body));

            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, { message: "Invalid or expired authentication token" }, label);
        }

        // a payload that is a plain string instead of an object
        assert.equal((await getWithToken("/me", jwt.sign("user", SECRET))).status, 401, "string payload");

        // a token signed without an expiry would never expire
        assert.equal((await getWithToken("/me", jwt.sign(claims, SECRET))).status, 401, "no expiry");
    });

    it("answers 500 when SECRET_KEY is not configured", async (t) => {
        t.mock.method(console, "error", () => {});
        delete process.env.SECRET_KEY;

        const response = await getWithToken("/me", sign());

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" });
    });

    // It reads the token and nothing else: the checks that need the database come later, after the per-user limit,
    // so a flood of requests with valid tokens costs no query before the limit has counted them.
    it("is synchronous: it hands the request on before it returns, without waiting for anything", () => {
        const req = { headers: { authorization: `Bearer ${sign()}` } } as unknown as Request;
        let called = false;

        const returned: unknown = authenticateMiddleware(req, {} as Response, () => {
            called = true;
        });

        assert.equal(called, true, "next() was called before the middleware returned");
        assert.ok(!(returned instanceof Promise), "it does not return a promise");
    });
});

describe("authorizeMiddleware", () => {
    withSecret();

    it("lets a current user with an allowed role through", async () => {
        const response = await getWithToken("/admin", sign()).set("X-Test-Role", "admin");

        assert.equal(response.status, 200);
    });

    it("lets any of several allowed roles through", async () => {
        for (const role of ["user", "admin"]) {
            const response = await getWithToken("/anyone", sign()).set("X-Test-Role", role);

            assert.equal(response.status, 200, role);
        }
    });

    it("rejects a current user without the role with a 403", async () => {
        const response = await getWithToken("/admin", sign()).set("X-Test-Role", "user");

        assert.equal(response.status, 403);
        assert.deepEqual(response.body, { message: "You do not have permission to perform this action" });
    });

    // The role in a token is not read at all: it can be forged only with the secret, but it can also be old. The
    // database's role (req.user) is the only one that counts.
    it("rejects a user whose role is user in the database even when the token says admin", async () => {
        const response = await getWithToken("/admin", sign({ ...claims, role: "admin" })).set("X-Test-Role", "user");

        assert.equal(response.status, 403);
    });

    it("lets an admin in the database through even when the token says user", async () => {
        const response = await getWithToken("/admin", sign({ ...claims, role: "user" })).set("X-Test-Role", "admin");

        assert.equal(response.status, 200);
    });

    it("rejects a valid token with a 401 when no current user was loaded, whatever the token says about the role", async () => {
        // the same token passes when a current user has been loaded, so what is missing below is only that
        assert.equal((await getWithToken("/admin", sign({ ...claims, role: "admin" })).set("X-Test-Role", "admin")).status, 200);

        const response = await getWithToken("/admin-without-current-user", sign({ ...claims, role: "admin" }));

        assert.equal(response.status, 401);
    });

    it("rejects a request that was never authenticated with a 401", async () => {
        const response = await request(buildApp()).get("/admin-without-login");

        assert.equal(response.status, 401);
    });
});
