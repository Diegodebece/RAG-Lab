import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requireTokenExpiry, requireUserId } from "../../src/v1/utils/requireUserId.util.js";
import { AppError } from "../../src/v1/utils/appError.util.js";

describe("requireUserId", () => {
    it("returns the id of the logged-in user", () => {
        assert.equal(requireUserId({ decoded: { id: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c", role: "user", expiresAt: 0 } }), "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c");
    });

    it("returns when the token expires, or a 401 AppError without a logged-in user", () => {
        assert.equal(requireTokenExpiry({ decoded: { id: "3f2b8c1e-9a4d-4e7f-b2c1-8d5e6f7a9b0c", role: "user", expiresAt: 1234 } }), 1234);
        assert.throws(() => requireTokenExpiry({}), (error: unknown) => error instanceof AppError && error.status === 401);
    });

    it("throws a 401 AppError when the request was not authenticated", () => {
        assert.throws(() => requireUserId({}), (error: unknown) => error instanceof AppError && error.status === 401);
    });
});
