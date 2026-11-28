// The settings of the app that a developer changes in their own .env (or in their shell) to run it their way:
// the address and port, the proxies trusted, the browser origins, the limits and the model server. The tests
// need the same values on every computer, so test/setup.ts sets each one to the app's own default, and the
// child processes the tests start get the same values (see childEnvironment.ts).
//
// They are set to values, not removed: the app loads .env too (dotenv/config), and a variable that is missing
// from the environment would be filled in again from the developer's .env.
export const OPERATIONAL_DEFAULTS: Record<string, string> = {
    HOST: "127.0.0.1",
    PORT: "3000",
    TRUSTED_PROXIES: "loopback",
    // empty: any origin, as in development
    CORS_ORIGINS: "",
    HEALTH_CACHE_SECONDS: "10",
    HEALTH_CHECKS_PER_MINUTE: "30",
    AUTHENTICATED_REQUESTS_PER_MINUTE: "120",
    TOKEN_LIFETIME_SECONDS: "3600",
    // the floor under every request of one address, then the limits of the account routes
    REQUESTS_PER_ADDRESS_PER_MINUTE: "300",
    LOGINS_PER_15_MINUTES: "10",
    FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES: "5",
    PASSWORD_CHANGES_PER_15_MINUTES: "5",
    USER_CREATIONS_PER_HOUR: "20",
    // profiles one user may keep (layer 3)
    MAX_PROFILES_PER_USER: "20",
    // documents and indexes (layer 4): what one user may keep and build, what the whole server may queue and build
    // per day, the size of a document and how often one user may upload
    MAX_DOCUMENTS_PER_USER: "3",
    MAX_DOCUMENT_CHARACTERS: "1000000",
    UPLOAD_REQUESTS_PER_MINUTE: "5",
    MAX_ACTIVE_INDEX_BUILDS_PER_USER: "1",
    MAX_QUEUED_INDEX_BUILDS: "20",
    MAX_INDEX_BUILDS_PER_DAY: "6",
    MAX_INDEX_BUILDS_PER_DAY_TOTAL: "100",
    // questions (layer 5): asked per user per minute and per day, the seconds one may take (waiting for the model's turn
    // included) and how many may wait for the turn at once
    QUESTIONS_PER_MINUTE: "10",
    MAX_QUESTIONS_PER_DAY: "30",
    MAX_QUESTION_SECONDS: "60",
    MAX_WAITING_QUESTIONS: "20",
    // how long one request to the model server may take before the API gives up on it
    OLLAMA_TIMEOUT_MS: "120000",
    // a closed port: a test that forgets to start the fake Ollama gets "connection refused" instead of reaching
    // the real models on this computer
    OLLAMA_BASE_URL: "http://127.0.0.1:1"
};
