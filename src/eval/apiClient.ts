import { describeError } from "../v1/utils/describeError.util.js";

// The harness talks to the API like any other client, with an account of its own, over HTTP. This client logs in once (and again, once,
// when a request is answered with 401), waits out a per-minute limit, gives up on a daily one, tries a busy or slow server a few more
// times, and never sends the password over plain http to a machine that is not this one. It prints nothing: the password and the token
// are never in a message, a log line or an error.

export interface ApiRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
}

export interface ApiResponse {
    status: number;
    // the JSON of the answer, or null when it has none
    body: unknown;
    // the requests sent for this call (the login not included)
    attempts: number;
}

export interface ApiClientOptions {
    baseUrl: string;
    email: string;
    password: string;
    // waits this many milliseconds; injected so the tests do not wait
    sleep?: (milliseconds: number) => Promise<void>;
    // gives up on one request after this long (default two minutes, longer than the server's own limit for a question)
    requestTimeoutMs?: number;
}

export interface ApiClient {
    send: (request: ApiRequest) => Promise<ApiResponse>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// how long to wait before each of the three more tries of a 503 (a 504 is returned at once, with no retry)
const BUSY_RETRY_DELAYS_MS = [2000, 5000, 10_000];

// the most times a request waits out a per-minute limit before it gives up
const MAX_RATE_LIMIT_WAITS = 20;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// the base address, or a throw (that never shows the address, which could hold a password) for one that is not http or https, has
// credentials in it, or is plain http to a host that is not this computer
const parseBaseUrl = (baseUrl: string): string => {
    let url: URL;

    try {
        url = new URL(baseUrl);
    } catch {
        throw new Error("The API address is not a valid URL");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("The API address must be an http or https URL");
    }

    if (url.username !== "" || url.password !== "") {
        throw new Error("The API address must not have credentials in it");
    }

    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error("Plain http is refused for a host that is not this computer, because the password would cross the network in the clear: use https");
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

// the message the server wrote in an error body, or an empty text
const messageOf = (body: unknown): string =>
    typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : "";

// The seconds a 429 says to wait: the largest t of the entries of the RateLimit header that have r=0 (the limiters that refused the
// request), or null when no entry has r=0. A limit that is not reset in seconds (the daily one counts the database) never has one.
const secondsToWait = (header: string | null): number | null => {
    if (header === null) {
        return null;
    }

    let longest: number | null = null;

    for (const entry of header.split(",")) {
        const remaining = /\br=(\d+)/.exec(entry);
        const reset = /\bt=(\d+)/.exec(entry);

        if (remaining !== null && reset !== null && Number(remaining[1]) === 0) {
            longest = Math.max(longest ?? 0, Number(reset[1]));
        }
    }

    return longest;
};

export const createApiClient = (options: ApiClientOptions): ApiClient => {
    const base = parseBaseUrl(options.baseUrl);
    const sleep = options.sleep ?? defaultSleep;
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let token: string | undefined;

    // one request, without any of the retrying: its status, its headers and its JSON
    const sendOnce = async (method: string, path: string, body: unknown, authorized: boolean): Promise<{ status: number; headers: Headers; body: unknown }> => {
        let response: Response;

        try {
            // a redirect is not followed: the password and the token must go to the address that was given and to no other
            response = await fetch(`${base}${path}`, {
                method,
                redirect: "manual",
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                    ...(authorized && token !== undefined ? { Authorization: `Bearer ${token}` } : {})
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        } catch (error) {
            // only the kind of failure: the request holds the password or the token
            throw new Error(`The API did not answer: ${describeError(error)}`);
        }

        const text = await response.text();
        let parsed: unknown = null;

        if (text !== "") {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
        }

        return { status: response.status, headers: response.headers, body: parsed };
    };

    const login = async (): Promise<void> => {
        const response = await sendOnce("POST", "/v1/auth/login", { email: options.email, password: options.password }, false);
        const given = typeof response.body === "object" && response.body !== null && "token" in response.body ? response.body.token : undefined;

        if (response.status !== 200 || typeof given !== "string") {
            const reason = messageOf(response.body);
            throw new Error(`The login was refused (HTTP ${response.status}${reason === "" ? "" : `: ${reason}`})`);
        }

        token = given;
    };

    const send = async (request: ApiRequest): Promise<ApiResponse> => {
        if (token === undefined) {
            await login();
        }

        let attempts = 0;
        let loggedInAgain = false;
        let rateLimitWaits = 0;
        let busyRetries = 0;

        for (;;) {
            attempts += 1;
            const response = await sendOnce(request.method, request.path, request.body, true);

            if (response.status === 401 && !loggedInAgain) {
                loggedInAgain = true;
                await login();
                continue;
            }

            if (response.status === 429) {
                const seconds = secondsToWait(response.headers.get("ratelimit"));

                if (seconds === null) {
                    // not a limit that resets in seconds: the day's, which waiting does not help
                    throw new Error(`The API refused the request (HTTP 429): ${messageOf(response.body)}`);
                }

                if (rateLimitWaits >= MAX_RATE_LIMIT_WAITS) {
                    throw new Error("The API kept refusing the request because of its per-minute limit");
                }

                rateLimitWaits += 1;
                await sleep(Math.max(seconds, 1) * 1000 + 500);
                continue;
            }

            // a 504 is not tried again: the server says the question took all the time it had, and asking again would spend another
            // question of the day on the same slow model
            if (response.status === 503 && busyRetries < BUSY_RETRY_DELAYS_MS.length) {
                await sleep(BUSY_RETRY_DELAYS_MS[busyRetries]);
                busyRetries += 1;
                continue;
            }

            return { status: response.status, body: response.body, attempts };
        }
    };

    return { send };
};
