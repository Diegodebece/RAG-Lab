import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A fake Ollama: a real HTTP server on a free port of this computer, so the code under test runs its real
// fetch and timeout logic. Tests choose what each path answers with respond(path, handler).
//
// A handler receives the request, the response and the body the request carried (already read: the JSON it holds, the
// text when it is not JSON, null when there was none), so it can answer according to what it was sent.
export type FakeOllamaHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

export interface FakeOllamaRequest {
    method: string;
    path: string;
    // the JSON the request carried; its text when that is not JSON; null when the request had no body
    body: unknown;
}

export interface FakeOllama {
    // base URL to put in OLLAMA_BASE_URL, without a trailing slash
    url: string;
    // every request received, in order, recorded before its handler runs
    requests: FakeOllamaRequest[];
    // replaces what a path answers with; paths without a handler answer 404
    respond: (path: string, handler: FakeOllamaHandler) => void;
    // stops the server and closes every connection, also the ones a handler left open
    close: () => Promise<void>;
}

// Ready: the models Ollama reports as installed (GET /api/tags).
export const modelList = (names: string[]): FakeOllamaHandler => (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: names.map((name) => ({ name })) }));
};

// An HTTP 200 with the given JSON value as its body, for answers of an unexpected shape.
export const jsonBody = (body: unknown): FakeOllamaHandler => (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
};

// An error status with an empty body, such as a 500 while the models load.
export const httpError = (status = 500): FakeOllamaHandler => (req, res) => {
    res.writeHead(status).end();
};

// An HTTP 200 whose body is not JSON.
export const malformedBody: FakeOllamaHandler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end("<html>not json</html>");
};

// Accepts the request and never answers, like a model server that hangs.
export const neverAnswer: FakeOllamaHandler = () => {};

// A redirect to another address, like a model server behind a proxy that moved.
export const redirectTo = (location: string, status = 302): FakeOllamaHandler => (req, res) => {
    res.writeHead(status, { Location: location }).end();
};

// Closes the connection without answering, like a server that crashes mid-request.
export const dropConnection: FakeOllamaHandler = (req) => {
    req.socket.destroy();
};

export interface HeldRequest {
    handler: FakeOllamaHandler;
    // resolves when a request reaches the handler
    arrived: Promise<void>;
    // resolves when the caller hangs up (an aborted fetch, a closed socket) before the double has answered
    closed: Promise<void>;
}

// Accepts the request, never answers, and tells the test when the request arrived and when the caller gave up on it:
// the way to see that an abort really reaches the model server.
export const holdRequest = (): HeldRequest => {
    let markArrived: () => void = () => {};
    let markClosed: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
        markArrived = resolve;
    });
    const closed = new Promise<void>((resolve) => {
        markClosed = resolve;
    });

    return {
        handler: (req, res) => {
            markArrived();
            res.on("close", markClosed);
        },
        arrived,
        closed
    };
};

// What the double calls the embedding of a text: always 1024 numbers (or the dimensions asked for), none of them zero
// unless the test asks for a zero vector, and the same numbers for the same text.
export const EMBEDDING_DIMENSIONS = 1024;

export const fakeVectorFor = (text: string, dimensions = EMBEDDING_DIMENSIONS): number[] => {
    const seed = [...text].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0);
    return Array.from({ length: dimensions }, (_, index) => ((seed + index) % 97) / 97 + 0.01);
};

// The token count the double reports for one text: a quarter of its length, at least 1. A request reports the sum.
export const fakeTokenCount = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export interface EmbeddingsOptions {
    // vectors of this length instead of 1024
    dimensions?: number;
    // every number of every vector is 0
    zeroVector?: boolean;
    // the answer has no prompt_eval_count
    omitTokenCount?: boolean;
    // runs after the request arrived and before the answer is sent, for a test that changes the database in the middle of a batch
    beforeAnswer?: (input: string[]) => Promise<void> | void;
}

// The embed endpoint (POST /api/embed): one deterministic vector per input and a prompt_eval_count that is the sum of
// fakeTokenCount of the inputs.
export const embeddings = (options: EmbeddingsOptions = {}): FakeOllamaHandler => (req, res, body) => {
    const input = typeof body === "object" && body !== null && "input" in body && Array.isArray(body.input) ? (body.input as string[]) : null;

    if (input === null) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "input must be a list of texts" }));
        return;
    }

    const model = typeof body === "object" && body !== null && "model" in body ? body.model : undefined;

    void (async () => {
        await options.beforeAnswer?.(input);

        const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
        const vectors = input.map((text) => (options.zeroVector ? new Array<number>(dimensions).fill(0) : fakeVectorFor(text, dimensions)));
        const answer: Record<string, unknown> = { model, embeddings: vectors };

        if (!options.omitTokenCount) {
            answer.prompt_eval_count = input.reduce((sum, text) => sum + fakeTokenCount(text), 0);
        }

        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
    })();
};

// Waits until the double has received this many requests to the path (or more), failing instead of waiting for ever.
export const waitForRequests = async (fake: FakeOllama, path: string, count: number, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (fake.requests.filter((request) => request.path === path).length < count) {
        if (Date.now() > deadline) {
            throw new Error(`the fake Ollama did not receive ${count} request(s) to ${path} within ${timeoutMs} ms; it got ${fake.requests.length} in all`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

const parseBody = (raw: string): unknown => {
    if (raw === "") {
        return null;
    }

    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
};

export const startFakeOllama = async (): Promise<FakeOllama> => {
    const handlers = new Map<string, FakeOllamaHandler>();
    const requests: FakeOllamaRequest[] = [];

    const server = createServer((req, res) => {
        // the path exactly as received, without the query string: new URL() would read "//api/tags" as a host
        const path = (req.url ?? "/").split("?")[0];
        const parts: Buffer[] = [];

        req.on("data", (chunk: Buffer) => parts.push(chunk));
        req.on("error", () => {});
        req.on("end", () => {
            const body = parseBody(Buffer.concat(parts).toString("utf8"));
            requests.push({ method: req.method ?? "GET", path, body });

            const handler = handlers.get(path);

            if (!handler) {
                res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
                return;
            }

            handler(req, res, body);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        respond: (path, handler) => {
            handlers.set(path, handler);
        },
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
            // a handler that never answers keeps its connection open, and close() would wait for it
            server.closeAllConnections();
        })
    };
};
