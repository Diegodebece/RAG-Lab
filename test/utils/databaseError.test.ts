import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDatabaseUnreachableError } from "../../src/v1/utils/databaseError.util.js";

// the shape pg gives a database error: an Error with the SQLSTATE (or the system error name) in code
const withCode = (code: string, message = "an error"): Error => Object.assign(new Error(message), { code });

describe("isDatabaseUnreachableError: PostgreSQL going away while a request is in progress", () => {
    // Each one is what a request gets when PostgreSQL restarts or drops the connection under it: the client is told
    // to try again (503), not that the server broke (500).
    const goingAway: [string, string][] = [
        ["57P01", "admin_shutdown: terminating connection due to administrator command"],
        ["57P02", "crash_shutdown: terminating connection because of crash of another server process"],
        ["08000", "connection_exception"],
        ["08003", "connection_does_not_exist"],
        ["08006", "connection_failure"]
    ];

    for (const [code, meaning] of goingAway) {
        it(`recognizes ${code} (${meaning})`, () => {
            assert.equal(isDatabaseUnreachableError(withCode(code, meaning)), true);
        });
    }
});

// What was already recognized, and what must stay a server error or a refusal: widening the check to the codes above
// must not turn it into one that accepts every database error.
describe("isDatabaseUnreachableError: what it already did and must keep doing", () => {
    it("recognizes the connection errors and the startup state it recognized before", () => {
        for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "57P03"]) {
            assert.equal(isDatabaseUnreachableError(withCode(code)), true, code);
        }
    });

    it("recognizes the errors pg raises without a code, by their message", () => {
        for (const message of ["timeout exceeded when trying to connect", "timeout expired", "Query read timeout", "Connection terminated unexpectedly"]) {
            assert.equal(isDatabaseUnreachableError(new Error(message)), true, message);
        }
    });

    it("does not recognize a database that answered and said no, or an error of the query itself", () => {
        for (const code of ["28P01", "28000", "3D000", "42501", "42P01", "23505", "23514", "22P02", "40001", "40P01", "57014", "08P01"]) {
            assert.equal(isDatabaseUnreachableError(withCode(code)), false, code);
        }
    });

    it("does not recognize errors that are not database errors, or values that are not errors", () => {
        assert.equal(isDatabaseUnreachableError(new Error("something else")), false);
        assert.equal(isDatabaseUnreachableError("57P01"), false);
        assert.equal(isDatabaseUnreachableError(null), false);
        assert.equal(isDatabaseUnreachableError(undefined), false);
    });
});
