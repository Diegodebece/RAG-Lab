import { readIntegerSetting } from "./env.config.js";

// Server-side limits; each one can be overridden in .env (a value that is not a positive integer stops the app
// at startup). The caps on the settings users change (layer 3) will live here too.

const MINUTE_MS = 60 * 1000;

// how long a login token stays valid
export const TOKEN_LIFETIME_SECONDS = readIntegerSetting("TOKEN_LIFETIME_SECONDS", 3600);

// every request a logged-in user makes to the protected routes, per minute; the routes' own limits apply on top.
// Generous for a browser, but it stops one account from taking every database connection with a flood of
// cheap requests.
export const AUTHENTICATED_REQUESTS_PER_MINUTE = readIntegerSetting("AUTHENTICATED_REQUESTS_PER_MINUTE", 120);

export const AUTHENTICATED_REQUEST_WINDOW_MS = MINUTE_MS;

// health checks per client address per minute; the endpoint is public
export const HEALTH_CHECKS_PER_MINUTE = readIntegerSetting("HEALTH_CHECKS_PER_MINUTE", 30);

export const HEALTH_WINDOW_MS = MINUTE_MS;

// how long a health report is reused before the database and Ollama are checked again (0: every time)
export const HEALTH_CACHE_SECONDS = readIntegerSetting("HEALTH_CACHE_SECONDS", 10, 0);
