import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitEvent, subscribeToEvents } from "../../src/v1/services/events.service.js";

// A listener that throws must not stop the other listeners, and what the log says about it is the name, the code and the message of
// the error and never the whole object: a listener that fails on a database error carries the failing row in the error's details,
// and a row can hold the text of a document. This is one of the two tests (with the one of server.ts) where the log is the
// behavior under test, and so what console.error was called with is what the test looks at.

const event = { type: "ready", indexId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" } as const;

describe("emitEvent", () => {
    it("logs a failing listener with one text made of its name and message, and never the error object or its details", (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const secret = "<secret text of a document>";
        const unsubscribe = subscribeToEvents(() => {
            throw Object.assign(new Error("listener broke"), { detail: secret, row: { text: secret } });
        });

        try {
            emitEvent(event);
        } finally {
            unsubscribe();
        }

        assert.equal(consoleError.mock.callCount(), 1, "one line in the log for the one failure");

        const logged = consoleError.mock.calls[0].arguments;
        assert.equal(logged.length, 1, "one argument: a second one would be the error object, which prints whole");
        assert.equal(typeof logged[0], "string");
        assert.ok((logged[0] as string).includes("Error: listener broke"), `the log says ${JSON.stringify(logged[0])}`);
        assert.ok((logged[0] as string).startsWith("An event listener failed"), "and says what failed");
        assert.ok(!(logged[0] as string).includes(secret), "the details of the error are not in the log");
        assert.ok(!(logged[0] as string).includes("row"), "nor the other properties of the error");
    });

    it("writes the code of an error that has one, the way describeError does", (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const unsubscribe = subscribeToEvents(() => {
            throw Object.assign(new Error("permission denied"), { code: "42501" });
        });

        try {
            emitEvent(event);
        } finally {
            unsubscribe();
        }

        assert.ok((consoleError.mock.calls[0].arguments[0] as string).includes("[42501]"));
    });

    it("still gives the event to the other listeners, in the order they subscribed, when one of them throws", (t) => {
        t.mock.method(console, "error", () => {});
        const received: string[] = [];
        const unsubscribers = [
            subscribeToEvents(() => { received.push("first"); }),
            subscribeToEvents(() => { throw new Error("listener broke"); }),
            subscribeToEvents(() => { received.push("third"); })
        ];

        try {
            emitEvent(event);
        } finally {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
        }

        assert.deepEqual(received, ["first", "third"]);
    });

    it("logs nothing when every listener works", (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const unsubscribe = subscribeToEvents(() => {});

        try {
            emitEvent(event);
        } finally {
            unsubscribe();
        }

        assert.equal(consoleError.mock.callCount(), 0);
    });
});
