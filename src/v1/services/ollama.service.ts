import { OLLAMA_BASE_URL } from "../config/ollama.config.js";
import { AppError } from "../utils/appError.util.js";
import { ModelUnavailableError } from "../utils/modelUnavailableError.util.js";

// The wrapper every Ollama call goes through: nothing else in the API calls fetch with the model server's address.

interface RequestOptions {
    // gives up after this long
    timeoutMs: number;
}

const isModelList = (value: unknown): value is { models: { name: string }[] } =>
    typeof value === "object" && value !== null
    && "models" in value && Array.isArray(value.models)
    && value.models.every((model: unknown) => typeof model === "object" && model !== null && "name" in model && typeof model.name === "string");

// Sends one GET request to Ollama and returns its JSON body. Expected failures are AppErrors with messages that
// are safe to show: ModelUnavailableError (503) when Ollama cannot be reached (the caller may retry later),
// 504 when it does not answer in time. A non-OK answer is a plain Error: it means a model or version
// mismatch that retrying will not fix.
const getFromOllama = async (path: string, { timeoutMs }: RequestOptions): Promise<unknown> => {
    const timeout = AbortSignal.timeout(timeoutMs);

    try {
        // A redirect is not followed: a model server that redirects is misconfigured or has been taken over, and
        // following it would send the request to an address nobody chose. A 3xx answer is not OK, so it is handled
        // below like any other error answer.
        const response = await fetch(`${OLLAMA_BASE_URL}${path}`, { method: "GET", signal: timeout, redirect: "manual" });

        if (!response.ok) {
            throw new Error(`Ollama answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }

        return await response.json();
    } catch (error) {
        if (timeout.aborted) {
            throw new AppError(504, "The model server did not answer in time");
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
    const body = await getFromOllama("/api/tags", options);

    if (!isModelList(body)) {
        throw new Error("Ollama must return a list of models, each with a name");
    }

    return body.models.map((model) => model.name);
};
