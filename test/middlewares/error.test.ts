import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { errorMiddleware } from "../../src/v1/middlewares/error.middleware.js";
import { notFoundMiddleware } from "../../src/v1/middlewares/notFound.middleware.js";
import { AppError } from "../../src/v1/utils/appError.util.js";

// an app whose /fail route passes the given error to next(), like a controller's catch block
const buildApp = (error?: unknown) => {
    const app = express();
    app.use(express.json());
    app.get("/fail", (req, res, next) => next(error));
    app.post("/echo", (req, res) => res.json(req.body));
    app.use(notFoundMiddleware);
    app.use(errorMiddleware);
    return app;
};

describe("errorMiddleware", () => {
    it("answers an AppError with its status and message", async () => {
        const response = await request(buildApp(new AppError(409, "Email already registered"))).get("/fail");

        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { message: "Email already registered" });
    });

    it("includes the details of a validation error", async () => {
        const response = await request(buildApp(new AppError(400, "Validation error", ["Email is required"]))).get("/fail");

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: "Validation error", details: ["Email is required"] });
    });

    it("answers malformed JSON with a 400 instead of a 500", async () => {
        const response = await request(buildApp()).post("/echo").set("Content-Type", "application/json").send("{bad");

        assert.equal(response.status, 400);
        assert.deepEqual(Object.keys(response.body), ["message"]);
    });

    it("answers a library error with a 4xx status as a client error, with a generic message when it is not marked safe", async (t) => {
        const logged = t.mock.method(console, "error", () => {});
        // what the router passes on when it cannot decode a percent-encoded path parameter
        const decodeError = Object.assign(new URIError("URI malformed: /internal/path"), { status: 400 });

        const response = await request(buildApp(decodeError)).get("/fail");

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { message: "Invalid request" });
        assert.equal(logged.mock.callCount(), 0, "a client mistake is not logged as a server error");
    });

    it("answers unexpected errors with a generic 500 that does not leak their message", async (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const response = await request(buildApp(new Error("password authentication failed for user rag"))).get("/fail");

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" });
        assert.equal(consoleError.mock.callCount(), 1);
    });

    // A PostgreSQL error carries the failing row (detail), the statement (query), its parameters and the place it came from
    // (where): any of them can hold the text of a document. The log gets what says what went wrong, and nothing else.
    it("logs an unexpected error by its name, code and message only: the fields a database error carries (detail, where, query, parameters) are not written", async (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const databaseError = Object.assign(new Error("duplicate key value violates unique constraint"), {
            name: "DatabaseError",
            code: "23505",
            detail: "Key (text)=(DETAIL-MARKER invented document text) already exists.",
            where: "WHERE-MARKER invented document text",
            query: "INSERT INTO documents (text) VALUES ('QUERY-MARKER invented document text')",
            parameters: ["PARAMETERS-MARKER invented document text"],
            constraint: "documents_user_id_content_hash_unique"
        });

        const response = await request(buildApp(databaseError)).get("/fail");

        assert.equal(response.status, 500);
        assert.equal(consoleError.mock.callCount(), 1, "it is logged once");

        const written = consoleError.mock.calls[0].arguments.map((argument) => (typeof argument === "string" ? argument : inspect(argument, { depth: 6 }))).join(" ");

        for (const marker of ["DETAIL-MARKER", "WHERE-MARKER", "QUERY-MARKER", "PARAMETERS-MARKER"]) {
            assert.ok(!written.includes(marker), `${marker} reached the log: ${written}`);
        }

        assert.ok(written.includes("DatabaseError"), "the name is logged");
        assert.ok(written.includes("23505"), "the code is logged");
        assert.ok(written.includes("duplicate key value violates unique constraint"), "the message is logged");
    });

    it("logs an unexpected error that has no code by its name and message", async (t) => {
        const consoleError = t.mock.method(console, "error", () => {});
        const failure = Object.assign(new TypeError("Cannot read properties of undefined"), { detail: "DETAIL-MARKER invented document text" });

        await request(buildApp(failure)).get("/fail");

        const written = consoleError.mock.calls[0].arguments.map((argument) => (typeof argument === "string" ? argument : inspect(argument, { depth: 6 }))).join(" ");

        assert.ok(!written.includes("DETAIL-MARKER"), `the detail reached the log: ${written}`);
        assert.ok(written.includes("TypeError"));
        assert.ok(written.includes("Cannot read properties of undefined"));
    });

    it("also handles values that are not errors", async (t) => {
        t.mock.method(console, "error", () => {});
        const response = await request(buildApp("something odd")).get("/fail");

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: "Internal server error" });
    });
});

describe("errorMiddleware after the response has started", () => {
    it("hands the error to Express instead of trying to send a second response", () => {
        const error = new AppError(400, "Too late for a status");
        const forwarded: unknown[] = [];
        // a response whose headers are already out: any attempt to send another status must not happen
        const response = {
            headersSent: true,
            status: () => {
                throw new Error("status() must not be called after the headers were sent");
            }
        };

        errorMiddleware(error, {} as Request, response as unknown as Response, (value?: unknown) => {
            forwarded.push(value);
        });

        assert.deepEqual(forwarded, [error]);
    });
});

describe("notFoundMiddleware", () => {
    it("answers unknown routes with a 404", async () => {
        const response = await request(buildApp()).get("/nowhere");

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "Route not found" });
    });
});
