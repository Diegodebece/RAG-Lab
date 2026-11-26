import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { signToken, verifyToken } from "../../src/v1/utils/token.util.js";
import * as authConfig from "../../src/v1/config/auth.config.js";
import { TOKEN_LIFETIME_SECONDS } from "../../src/v1/config/limits.config.js";

const SECRET = "test-secret-only-for-these-tests";
const USER_ID = "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c";

// Tokens are made here with jsonwebtoken, with the issuer and the audience written out: a test that signed with
// signToken would agree with a signToken that wrote the wrong ones.
const VALID_CLAIMS = { sub: USER_ID, ver: 4, iss: "rag-lab", aud: "rag-lab-api" };

const signed = (claims: object, options: jwt.SignOptions = {}, secret = SECRET): string =>
    jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: "1h", ...options });

describe("the authentication settings", () => {
    it("name the issuer and the audience, and the limits on emails and passwords", () => {
        assert.equal(authConfig.TOKEN_ISSUER, "rag-lab");
        assert.equal(authConfig.TOKEN_AUDIENCE, "rag-lab-api");
        assert.equal(authConfig.MAX_EMAIL_LENGTH, 254);
        assert.equal(authConfig.MIN_PASSWORD_LENGTH, 8);
        assert.equal(authConfig.MAX_PASSWORD_LENGTH, 64);
    });
});

describe("signToken", () => {
    const decode = (token: string) => jwt.decode(token, { complete: true }) as jwt.Jwt & { payload: jwt.JwtPayload };

    it("signs with HS256 and exactly these claims: sub, ver, iss, aud, iat and exp", () => {
        const { header, payload } = decode(signToken({ id: USER_ID, tokenVersion: 4 }, SECRET));

        assert.equal(header.alg, "HS256");
        assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss", "sub", "ver"]);
        assert.equal(payload.sub, USER_ID);
        assert.equal(payload.ver, 4);
        assert.equal(payload.iss, "rag-lab");
        assert.equal(payload.aud, "rag-lab-api");
    });

    it("lives for the configured lifetime", () => {
        const { payload } = decode(signToken({ id: USER_ID, tokenVersion: 0 }, SECRET));

        assert.equal((payload.exp ?? 0) - (payload.iat ?? 0), TOKEN_LIFETIME_SECONDS);
    });

    it("carries no role and nothing else the caller passes in: the role is read from the database on every request", () => {
        const token = signToken({ id: USER_ID, tokenVersion: 0, role: "admin", email: "ana@example.com" } as unknown as Parameters<typeof signToken>[0], SECRET);
        const { payload } = decode(token);

        assert.equal("role" in payload, false);
        assert.equal("email" in payload, false);
        assert.equal("id" in payload, false, "the user id is the standard sub claim");
    });
});

describe("verifyToken", () => {
    it("returns the id, the token version and the expiry of a token made by signToken", () => {
        const before = Date.now();
        const decoded = verifyToken(signToken({ id: USER_ID, tokenVersion: 7 }, SECRET), SECRET);

        assert.deepEqual(Object.keys(decoded ?? {}).sort(), ["expiresAt", "id", "tokenVersion"], "no role");
        assert.equal(decoded?.id, USER_ID);
        assert.equal(decoded?.tokenVersion, 7);
        const lifetimeMs = (decoded?.expiresAt ?? 0) - before;
        assert.ok(Math.abs(lifetimeMs - TOKEN_LIFETIME_SECONDS * 1000) < 2000, `expires in ${lifetimeMs} ms`);
    });

    it("accepts a token signed by hand with the same claims, so the check and the claims are not the signer's own", () => {
        const decoded = verifyToken(signed(VALID_CLAIMS), SECRET);

        assert.equal(decoded?.id, USER_ID);
        assert.equal(decoded?.tokenVersion, 4);
    });

    it("accepts a token version of zero", () => {
        assert.equal(verifyToken(signed({ ...VALID_CLAIMS, ver: 0 }), SECRET)?.tokenVersion, 0);
    });

    it("does not pass on a role the token carries, whoever put it there", () => {
        const decoded = verifyToken(signed({ ...VALID_CLAIMS, role: "admin" }), SECRET);

        assert.notEqual(decoded, null);
        assert.equal(decoded !== null && "role" in decoded, false);
    });

    it("returns null for a token without an expiry", () => {
        assert.equal(verifyToken(jwt.sign(VALID_CLAIMS, SECRET, { algorithm: "HS256" }), SECRET), null);
    });

    it("returns null for an expired token", () => {
        assert.equal(verifyToken(signed(VALID_CLAIMS, { expiresIn: -10 }), SECRET), null);
    });

    it("returns null for a token signed with another secret", () => {
        assert.equal(verifyToken(signed(VALID_CLAIMS, {}, "another-secret"), SECRET), null);
    });

    it("returns null for a token with alg none", () => {
        const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ ...VALID_CLAIMS, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;

        assert.equal(verifyToken(unsigned, SECRET), null);
    });

    it("returns null for a token signed with another algorithm, even with the right secret", () => {
        assert.equal(verifyToken(signed(VALID_CLAIMS, { algorithm: "HS384" }), SECRET), null);
        assert.equal(verifyToken(signed(VALID_CLAIMS, { algorithm: "HS512" }), SECRET), null);
    });

    it("returns null for a token with another issuer, or none", () => {
        assert.equal(verifyToken(signed({ ...VALID_CLAIMS, iss: "rag-web" }), SECRET), null, "wrong issuer");
        assert.equal(verifyToken(signed({ ...VALID_CLAIMS, iss: "RAG-LAB" }), SECRET), null, "the issuer is compared exactly");
        assert.equal(verifyToken(signed({ sub: USER_ID, ver: 4, aud: "rag-lab-api" }), SECRET), null, "no issuer");
    });

    it("returns null for a token with another audience, or none", () => {
        assert.equal(verifyToken(signed({ ...VALID_CLAIMS, aud: "rag-web-api" }), SECRET), null, "wrong audience");
        assert.equal(verifyToken(signed({ ...VALID_CLAIMS, aud: ["rag-web-api"] }), SECRET), null, "wrong audience in a list");
        assert.equal(verifyToken(signed({ sub: USER_ID, ver: 4, iss: "rag-lab" }), SECRET), null, "no audience");
    });

    // The tokens are signed with the right secret, algorithm, issuer, audience and an expiry: the only thing wrong
    // with them is the version, so it is the version check that has to refuse them.
    it("returns null for a token whose version is missing, negative, fractional or not a number", () => {
        const withoutVersion = { sub: USER_ID, iss: "rag-lab", aud: "rag-lab-api" };

        assert.equal(verifyToken(signed(withoutVersion), SECRET), null, "missing");

        for (const ver of [-1, 1.5, "0", "4", null, true, [4], { value: 4 }]) {
            assert.equal(verifyToken(signed({ ...VALID_CLAIMS, ver }), SECRET), null, JSON.stringify(ver));
        }
    });

    it("returns null for a token whose subject is missing or not a UUID", () => {
        const { sub: _removed, ...withoutSubject } = VALID_CLAIMS;

        assert.equal(verifyToken(signed(withoutSubject), SECRET), null, "no subject");

        for (const sub of ["not-a-uuid", "' OR 1=1 --", "", 42, null, [USER_ID]]) {
            assert.equal(verifyToken(signed({ ...VALID_CLAIMS, sub }), SECRET), null, JSON.stringify(sub));
        }
    });

    it("returns null for a token that carries a payload that is not an object", () => {
        assert.equal(verifyToken(jwt.sign("user", SECRET, { algorithm: "HS256" }), SECRET), null);
    });

    // layer 1 signed { id, role } with no issuer and no audience; accounts did not exist then, so none of those
    // tokens may open anything now
    it("returns null for a token of the earlier design, { id, role } with the same secret", () => {
        assert.equal(verifyToken(signed({ id: USER_ID, role: "admin" }), SECRET), null);
        assert.equal(verifyToken(signed({ id: USER_ID, role: "user", iss: "rag-lab", aud: "rag-lab-api" }), SECRET), null, "even with the new issuer and audience");
    });

    // RAG Web signs { id, role } with the same kind of secret and no issuer or audience: a token from there must not
    // open this API even if the two deployments were configured with one SECRET_KEY by mistake
    it("returns null for a RAG Web token signed with the same secret", () => {
        const ragWebToken = jwt.sign({ id: USER_ID, role: "admin" }, SECRET, { algorithm: "HS256", expiresIn: 3600 });

        assert.equal(verifyToken(ragWebToken, SECRET), null);
    });

    it("returns null for text that is not a token", () => {
        for (const text of ["", "not-a-token", "a.b.c", "Bearer abc"]) {
            assert.equal(verifyToken(text, SECRET), null, text);
        }
    });
});
