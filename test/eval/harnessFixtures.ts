import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fakeTokenCount, padVector } from "../doubles/fakeOllama.js";
import type { FakeOllamaHandler } from "../doubles/fakeOllama.js";

// What the tests of the retrieval harness share: an invented document with four sections, an invented evaluation set over it, a model
// server double that gives each text a vector by the keywords it holds, and a recording HTTP server around the app. Nothing here is a
// real document or question: every text is made up for the tests, and lives in os.tmpdir() once written.

const KEYWORDS = ["alpha", "bravo", "charlie", "delta"] as const;
const NOUNS: Record<(typeof KEYWORDS)[number], string> = { alpha: "station", bravo: "lighthouse", charlie: "harbour", delta: "mill" };
const TAILS = [
    "keeps a copper lantern burning", "stores spare nets in a red shed", "paints its shutters every spring", "sounds a fog horn twice an hour",
    "grows mint in clay pots", "hangs a brass bell by the door", "sells salted fish on market days", "guards a ledger of old visitors",
    "smells of cinnamon and smoke"
];

// the n-th sentence of a section: 'The alpha station keeps a copper lantern burning.'
export const sentence = (keyword: (typeof KEYWORDS)[number], position: number): string =>
    `The ${keyword} ${NOUNS[keyword]} ${TAILS[(position + KEYWORDS.indexOf(keyword)) % TAILS.length]}.`;

const section = (keyword: (typeof KEYWORDS)[number]): string => TAILS.map((_, position) => sentence(keyword, position)).join(" ");

// four sections of about 500 characters, one blank line between them (the server's cleaning keeps line breaks, the chunker collapses them)
export const DOCUMENT_TEXT = KEYWORDS.map(section).join("\n\n");

export const DOCUMENT_NAME = "guide";

export interface InventedCase {
    id: string;
    indexPath: string;
    question: string;
    answerable: boolean;
    // the passages of the evidence: the quote, then the additional ones
    passages: string[];
}

// 'q-alpha' has one passage, 'q-bravo' has two (one in the bravo section and one in the charlie section), 'q-none' has none
export const CASES: InventedCase[] = [
    { id: "q-alpha", indexPath: `data/eval-1000/${DOCUMENT_NAME}.json`, question: "What does the alpha station do for its visitors?", answerable: true, passages: [sentence("alpha", 3)] },
    { id: "q-bravo", indexPath: `data/eval-1000/${DOCUMENT_NAME}.json`, question: "What does the bravo lighthouse keep, and where does the charlie harbour keep it?", answerable: true, passages: [sentence("bravo", 1), sentence("charlie", 5)] },
    { id: "q-none", indexPath: `data/eval-1000/${DOCUMENT_NAME}.json`, question: "Who painted the moon last winter?", answerable: false, passages: [] }
];

// the set as it is written in the file: the shape of the real ones, with the fields the harness does not use
export const setFileOf = (cases: InventedCase[]): object => ({
    version: 1,
    description: "An invented set for the tests.",
    cases: cases.map((item) => (item.answerable
        ? {
            id: item.id,
            indexPath: item.indexPath,
            question: item.question,
            expectedAnswer: "An invented answer.",
            mustInclude: [["invented"]],
            mustNotInclude: [],
            evidence: { quote: item.passages[0], section: "1", page: 1, ...(item.passages.length > 1 ? { additional: item.passages.slice(1).map((quote) => ({ quote, page: 2 })) } : {}) }
        }
        : { id: item.id, indexPath: item.indexPath, question: item.question, mustInclude: [], mustNotInclude: ["x"], unanswerable: true }))
});

// writes <data>/eval/sets/<setName>.json and <data>/eval/documents/<name>.txt for each document
export const writeDataFolder = async (dataDirectory: string, setName: string, cases: InventedCase[], documents: Record<string, string> = { [DOCUMENT_NAME]: DOCUMENT_TEXT }): Promise<string> => {
    await mkdir(path.join(dataDirectory, "eval", "sets"), { recursive: true });
    await mkdir(path.join(dataDirectory, "eval", "documents"), { recursive: true });

    const setFile = path.join(dataDirectory, "eval", "sets", `${setName}.json`);
    await writeFile(setFile, JSON.stringify(setFileOf(cases), null, 2), "utf8");

    for (const [name, text] of Object.entries(documents)) {
        await writeFile(path.join(dataDirectory, "eval", "documents", `${name}.txt`), text, "utf8");
    }

    return setFile;
};

// the vector of a text: one axis for each keyword it holds, and a fifth axis for a text that holds none (so no vector is ever zero)
export const keywordVector = (text: string): number[] => {
    const lower = text.toLowerCase();
    const flags = KEYWORDS.map((keyword) => (lower.includes(keyword) ? 1 : 0));

    return [...flags, flags.some((flag) => flag === 1) ? 0 : 1];
};

export const keywordEmbeddings: FakeOllamaHandler = (_req, res, body) => {
    const input = typeof body === "object" && body !== null && "input" in body && Array.isArray(body.input) ? (body.input as string[]) : [];

    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        embeddings: input.map((text) => padVector(keywordVector(text))),
        prompt_eval_count: input.reduce((sum, text) => sum + fakeTokenCount(text), 0)
    }));
};

export const INSTALLED_MODELS = [{ name: "qwen3-embedding:0.6b", digest: "digest-of-the-embedding-model" }, { name: "qwen3.5:4b", digest: "digest-of-the-small-model" }];

export interface RecordedRequest {
    method: string;
    url: string;
}

export interface RecordingServer {
    url: string;
    // every request the server received, in order
    requests: RecordedRequest[];
    // the bearer tokens it was given
    tokens: Set<string>;
    // when set, the content hash in the answer to an upload is replaced by another of the same length: a server that disagrees with the harness
    tamperWithUploads: boolean;
    close: () => Promise<void>;
}

// A real HTTP server around the app, on a free port of this computer, that records what it is asked.
export const startRecordingServer = async (app: RequestListener): Promise<RecordingServer> => {
    const requests: RecordedRequest[] = [];
    const tokens = new Set<string>();
    const recording: RecordingServer = {
        url: "",
        requests,
        tokens,
        tamperWithUploads: false,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        })
    };

    const server: Server = createServer((req, res) => {
        requests.push({ method: req.method ?? "", url: req.url ?? "" });

        const authorization = req.headers.authorization;

        if (authorization?.startsWith("Bearer ")) {
            tokens.add(authorization.slice("Bearer ".length));
        }

        if (recording.tamperWithUploads && req.method === "POST" && req.url === "/v1/documents") {
            const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;

            res.end = ((chunk?: unknown, ...rest: unknown[]) => {
                if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
                    return originalEnd(chunk.toString("utf8").replace(/"contentHash":"[0-9a-f]{64}"/, `"contentHash":"${"0".repeat(64)}"`), ...rest);
                }

                return originalEnd(chunk, ...rest);
            }) as typeof res.end;
        }

        app(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    recording.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    return recording;
};
