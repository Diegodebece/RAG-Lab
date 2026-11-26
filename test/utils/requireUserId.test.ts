import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireTokenExpiry, requireUserId } from "../../src/v1/utils/requireUserId.util.js";
import { AppError } from "../../src/v1/utils/appError.util.js";

const USER_ID = "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c";

// Both helpers read req.user, the current user that currentUserMiddleware loads from the database. req.decoded is
// only what the token said, and it has no role: a request that is only authenticated has not been checked against
// the account yet, so it counts as not logged in.
describe("requireUserId", () => {
    it("returns the id of the current user", () => {
        assert.equal(requireUserId({ user: { id: USER_ID, role: "user", expiresAt: 0 } }), USER_ID);
    });

    it("throws a 401 AppError when the request has no current user", () => {
        assert.throws(() => requireUserId({}), (error: unknown) => error instanceof AppError && error.status === 401);
    });

    it("does not take a token that currentUserMiddleware has not checked for the current user", () => {
        assert.throws(
            () => requireUserId({ decoded: { id: USER_ID, tokenVersion: 0, expiresAt: 0 } } as unknown as Parameters<typeof requireUserId>[0]),
            (error: unknown) => error instanceof AppError && error.status === 401
        );
    });
});

describe("requireTokenExpiry", () => {
    it("returns when the current user's token expires", () => {
        assert.equal(requireTokenExpiry({ user: { id: USER_ID, role: "user", expiresAt: 1234 } }), 1234);
    });

    it("throws a 401 AppError when the request has no current user", () => {
        assert.throws(() => requireTokenExpiry({}), (error: unknown) => error instanceof AppError && error.status === 401);
    });

    it("does not take a token that currentUserMiddleware has not checked for the current user", () => {
        assert.throws(
            () => requireTokenExpiry({ decoded: { id: USER_ID, tokenVersion: 0, expiresAt: 99 } } as unknown as Parameters<typeof requireTokenExpiry>[0]),
            (error: unknown) => error instanceof AppError && error.status === 401
        );
    });
});
