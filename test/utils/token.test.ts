import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { signToken, verifyToken } from "../../src/v1/utils/token.util.js";
import { TOKEN_LIFETIME_SECONDS } from "../../src/v1/config/limits.config.js";
import type { TokenPayload } from "../../src/v1/types/auth.type.js";

const SECRET = "test-secret-only-for-these-tests";
const payload: TokenPayload = { id: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c", role: "admin" };

describe("signToken", () => {
    it("signs only the id and the role, with HS256 and the configured lifetime", () => {
        const token = signToken({ ...payload, email: "ana@example.com" } as TokenPayload, SECRET);
        const { header, payload: claims } = jwt.decode(token, { complete: true }) as jwt.Jwt & { payload: jwt.JwtPayload };

        assert.equal(header.alg, "HS256");
        assert.deepEqual(Object.keys(claims).sort(), ["exp", "iat", "id", "role"]);
        assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), TOKEN_LIFETIME_SECONDS);
    });
});

describe("verifyToken", () => {
    it("returns the payload of a token made by signToken, with its expiry", () => {
        const before = Date.now();
        const decoded = verifyToken(signToken(payload, SECRET), SECRET);

        assert.deepEqual({ id: decoded?.id, role: decoded?.role }, payload);
        const lifetimeMs = (decoded?.expiresAt ?? 0) - before;
        assert.ok(Math.abs(lifetimeMs - TOKEN_LIFETIME_SECONDS * 1000) < 2000, `expires in ${lifetimeMs} ms`);
    });

    it("returns null for a token without an expiry", () => {
        assert.equal(verifyToken(jwt.sign(payload, SECRET), SECRET), null);
    });

    it("returns null for a token signed with another secret", () => {
        assert.equal(verifyToken(signToken(payload, "another-secret"), SECRET), null);
    });

    // The tokens carry an expiry and a valid signature, so the only thing wrong with them is the payload: it is
    // the id and role validation that has to refuse them, not the missing-expiry check.
    it("returns null for a correctly signed, unexpired token with an unexpected payload", () => {
        const signed = (claims: object): string => jwt.sign(claims, SECRET, { algorithm: "HS256", expiresIn: "1h" });

        assert.notEqual(verifyToken(signed({ id: payload.id, role: "user" }), SECRET), null, "the same token with a valid payload is accepted");

        assert.equal(verifyToken(signed({ id: "not-a-uuid", role: "user" }), SECRET), null, "id that is not a UUID");
        assert.equal(verifyToken(signed({ id: payload.id, role: "root" }), SECRET), null, "unknown role");
        assert.equal(verifyToken(signed({ id: payload.id }), SECRET), null, "no role");
        assert.equal(verifyToken(signed({ role: "user" }), SECRET), null, "no id");
    });
});
