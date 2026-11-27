// The text that goes in the log for an error: its name, its code (a PostgreSQL error has one) and its message, never the
// whole object. A database error also carries the failing row, the statement and its parameters, and any of them can hold
// the text of a document. A value that is not an error is written as its type, since nothing is known about what it holds.
export const describeError = (error: unknown): string => {
    if (!(error instanceof Error)) {
        return `A value that is not an error was thrown (${typeof error})`;
    }

    const code = "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? ` [${error.code}]` : "";

    return `${error.name}${code}: ${error.message}`;
};
