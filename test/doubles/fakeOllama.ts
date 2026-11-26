import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A fake Ollama: a real HTTP server on a free port of this computer, so the code under test runs its real
// fetch and timeout logic. Tests choose what each path answers with respond(path, handler).
export type FakeOllamaHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface FakeOllamaRequest {
    method: string;
    path: string;
}

export interface FakeOllama {
    // base URL to put in OLLAMA_BASE_URL, without a trailing slash
    url: string;
    // every request received, in order
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

// Closes the connection without answering, like a server that crashes mid-request.
export const dropConnection: FakeOllamaHandler = (req) => {
    req.socket.destroy();
};

export const startFakeOllama = async (): Promise<FakeOllama> => {
    const handlers = new Map<string, FakeOllamaHandler>();
    const requests: FakeOllamaRequest[] = [];

    const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://fake-ollama.invalid").pathname;
        requests.push({ method: req.method ?? "GET", path });

        const handler = handlers.get(path);

        if (!handler) {
            res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
            return;
        }

        handler(req, res);
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
