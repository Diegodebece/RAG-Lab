// SQLSTATE and system error codes that mean "the database cannot be reached right now" and may get better by
// themselves: the connection was refused, the host is unknown or unreachable, or PostgreSQL is still starting up.
const UNREACHABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    // PostgreSQL: cannot_connect_now (the database system is starting up)
    "57P03"
]);

// pg reports these without a code: the pool gave up waiting for a connection, the connection attempt timed out, a
// connection that was open stopped answering, or the server closed the connection while it was starting.
const UNREACHABLE_MESSAGE = /timeout exceeded when trying to connect|timeout expired|Query read timeout|Connection terminated/i;

// True when the error means the database cannot be reached (as opposed to a database that answered and said no, such
// as a wrong password 28P01 or a missing database 3D000, which will not get better by themselves).
export const isDatabaseUnreachableError = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    if ("code" in error && typeof error.code === "string" && UNREACHABLE_CODES.has(error.code)) {
        return true;
    }

    // a host with several addresses fails with an AggregateError that holds one error per address
    if (error instanceof AggregateError && error.errors.length > 0) {
        return error.errors.every((inner) => isDatabaseUnreachableError(inner));
    }

    return error instanceof Error && UNREACHABLE_MESSAGE.test(error.message);
};
