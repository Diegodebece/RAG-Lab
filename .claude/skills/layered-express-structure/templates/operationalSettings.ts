// The settings of the app that a developer changes in their own .env (or in their shell) to run it their way:
// the address and port, the proxies trusted, the browser origins, the limits and the model server. The tests
// need the same values on every computer, so test/setup.ts sets each one to the app's own default, and the
// child processes the tests start get the same values.
//
// They are set to values, not removed: the app loads .env too (dotenv/config), and a variable that is missing
// from the environment would be filled in again from the developer's .env.
// Keep this list equal to the optional settings of .env.example, with the defaults of config/*.config.ts.
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
    // a closed port: a test that forgets to start the fake Ollama gets "connection refused" instead of reaching
    // the real models on this computer
    OLLAMA_BASE_URL: "http://127.0.0.1:1"
};
