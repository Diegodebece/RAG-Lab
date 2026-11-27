import { EMBEDDING_DIMENSIONS, FLOAT4_MAX } from "../config/indexing.config.js";
import { OLLAMA_BASE_URL } from "../config/ollama.config.js";
import { MalformedModelAnswerError } from "../utils/malformedModelAnswerError.util.js";
import { ModelTimeoutError } from "../utils/modelTimeoutError.util.js";
import { ModelUnavailableError } from "../utils/modelUnavailableError.util.js";
import { RequestCancelledError } from "../utils/requestCancelledError.util.js";

// The wrapper every Ollama call goes through: nothing else in the API calls fetch with the model server's address.

interface RequestOptions {
    // gives up after this long
    timeoutMs: number;
    // the caller gives up when this signal aborts (the request is dropped, and the model server stops working on it)
    signal?: AbortSignal;
}

interface EmbedResult {
    // one vector per input text, in the order of the inputs
    embeddings: number[][];
    // the tokens Ollama counted in the inputs (prompt_eval_count)
    promptTokens: number;
}

interface OllamaRequest {
    method: "GET" | "POST";
    path: string;
    // sent as JSON; a GET has none
    body?: unknown;
}

const isModelList = (value: unknown): value is { models: { name: string }[] } =>
    typeof value === "object" && value !== null
    && "models" in value && Array.isArray(value.models)
    && value.models.every((model: unknown) => typeof model === "object" && model !== null && "name" in model && typeof model.name === "string");

// Sends one request to Ollama and returns its JSON body. Expected failures are errors with messages that are safe to
// show: RequestCancelledError when the caller's signal aborted (also one that was aborted before the call, which sends
// nothing), ModelUnavailableError (503) when Ollama cannot be reached or its answer is cut in the middle of the body (the
// caller may retry later), ModelTimeoutError (504) when it does not answer in time. A non-OK answer is a plain Error: it
// means a model or version mismatch that retrying will not fix, and a body that arrives whole and is not JSON is a
// MalformedModelAnswerError, which is a plain Error too.
const requestOllama = async ({ method, path, body }: OllamaRequest, { timeoutMs, signal }: RequestOptions): Promise<unknown> => {
    if (signal?.aborted) {
        throw new RequestCancelledError();
    }

    const timeout = AbortSignal.timeout(timeoutMs);

    try {
        // A redirect is not followed: a model server that redirects is misconfigured or has been taken over, and
        // following it would send the request to an address nobody chose. A 3xx answer is not OK, so it is handled
        // below like any other error answer.
        const response = await fetch(`${OLLAMA_BASE_URL}${path}`, {
            method,
            signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
            redirect: "manual",
            ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        });

        if (!response.ok) {
            // the text of an error answer is shown only for a GET: the answer to a POST may quote what was sent
            const detail = method === "GET" ? `: ${(await response.text()).slice(0, 200)}` : "";
            throw new Error(`Ollama answered HTTP ${response.status}${detail}`);
        }

        try {
            return await response.json();
        } catch (error) {
            // a read cut short by the timeout or the caller is handled below
            if (signal?.aborted || timeout.aborted) {
                throw error;
            }

            // only a body that arrived whole and is not JSON is an answer that is wrong; a body that could not be read to
            // its end (the connection closed in the middle) is the connection failing, like one that never opened
            if (error instanceof SyntaxError) {
                throw new MalformedModelAnswerError("Ollama answered with a body that is not JSON");
            }

            throw new ModelUnavailableError();
        }
    } catch (error) {
        if (signal?.aborted) {
            throw new RequestCancelledError();
        }

        if (timeout.aborted) {
            throw new ModelTimeoutError();
        }

        // fetch rejects with a TypeError when the connection fails; anything else is not a connection problem
        if (error instanceof TypeError) {
            throw new ModelUnavailableError();
        }

        throw error;
    }
};

// The names of the models installed in Ollama (GET /api/tags), exactly as Ollama writes them, tag included
// ("qwen3.5:4b"). An answer of another shape is a plain Error, for the same reason as a non-OK one.
export const listInstalledModelsService = async (options: RequestOptions): Promise<string[]> => {
    const body = await requestOllama({ method: "GET", path: "/api/tags" }, options);

    if (!isModelList(body)) {
        throw new Error("Ollama must return a list of models, each with a name");
    }

    return body.models.map((model) => model.name);
};

const isVector = (value: unknown): value is number[] =>
    Array.isArray(value)
    && value.length === EMBEDDING_DIMENSIONS
    // pgvector stores float4: a number beyond its range (Infinity included) would be refused by the database, which is the
    // model's fault and not the database's
    && value.every((item: unknown) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= FLOAT4_MAX)
    // a vector of zeros has no direction: cosine similarity with it is undefined, and it means the model failed
    && value.some((item: number) => item !== 0);

// Embeds texts (POST /api/embed), with the whole text of each input: truncate is false, so an input longer than the
// model's window is an error answer and never a silently shortened vector. Returns one vector of 1024 numbers per text,
// in order, and the token count Ollama reported, so the caller can store it. An answer that does not have exactly that
// shape is a MalformedModelAnswerError.
export const embedTextsService = async (model: string, texts: string[], options: RequestOptions): Promise<EmbedResult> => {
    const body = await requestOllama({ method: "POST", path: "/api/embed", body: { model, input: texts, truncate: false } }, options);

    if (typeof body !== "object" || body === null || !("embeddings" in body) || !Array.isArray(body.embeddings)) {
        throw new MalformedModelAnswerError("Ollama must return a list of embeddings");
    }

    if (body.embeddings.length !== texts.length) {
        throw new MalformedModelAnswerError(`Ollama returned ${body.embeddings.length} embeddings for ${texts.length} texts`);
    }

    const vectors: unknown[] = body.embeddings;

    if (!vectors.every(isVector)) {
        throw new MalformedModelAnswerError(`Ollama must return vectors of ${EMBEDDING_DIMENSIONS} numbers, none of them all zeros`);
    }

    const promptTokens = "prompt_eval_count" in body ? body.prompt_eval_count : undefined;

    if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0) {
        throw new MalformedModelAnswerError("Ollama must return the number of tokens it embedded");
    }

    return { embeddings: vectors, promptTokens };
};
