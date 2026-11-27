import { readIntegerSetting } from "./env.config.js";

// Server-side limits; each one can be overridden in .env (a value outside its range, or not written as plain
// decimal digits, stops the app at startup; it is never shortened to fit). The caps on the values of the settings users
// change live in configuration.config.ts, next to the definitions they belong to.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// how long a login token stays valid: from one second to one day
export const TOKEN_LIFETIME_SECONDS = readIntegerSetting("TOKEN_LIFETIME_SECONDS", 3600, 1, 86400);

// every request a logged-in user makes to the protected routes, per minute; the routes' own limits apply on top.
// Generous for a browser, but it stops one account from taking every database connection with a flood of
// cheap requests.
export const AUTHENTICATED_REQUESTS_PER_MINUTE = readIntegerSetting("AUTHENTICATED_REQUESTS_PER_MINUTE", 120);

export const AUTHENTICATED_REQUEST_WINDOW_MS = MINUTE_MS;

// every request from one client address per minute, public routes and requests with a forged token included. It sits in
// front of everything, so an address that floods the API is answered before its token is checked or the database is
// asked. Generous for a browser (and for several users behind one address); the other limits apply on top.
export const REQUESTS_PER_ADDRESS_PER_MINUTE = readIntegerSetting("REQUESTS_PER_ADDRESS_PER_MINUTE", 300);

export const ADDRESS_REQUEST_WINDOW_MS = MINUTE_MS;

// logins per client address per 15 minutes, successful ones included: each one costs a password hash
export const LOGINS_PER_15_MINUTES = readIntegerSetting("LOGINS_PER_15_MINUTES", 10);

// failed logins per email and client address per 15 minutes: stops guessing one account from one address without
// letting someone else lock the owner out from another address
export const FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES = readIntegerSetting("FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES", 5);

export const LOGIN_WINDOW_MS = 15 * MINUTE_MS;

// password change attempts per user per 15 minutes, wrong ones included: the route checks a password, so it is a way
// to guess one
export const PASSWORD_CHANGES_PER_15_MINUTES = readIntegerSetting("PASSWORD_CHANGES_PER_15_MINUTES", 5);

export const PASSWORD_CHANGE_WINDOW_MS = 15 * MINUTE_MS;

// accounts one admin may create per hour
export const USER_CREATIONS_PER_HOUR = readIntegerSetting("USER_CREATIONS_PER_HOUR", 20);

export const USER_CREATION_WINDOW_MS = HOUR_MS;

// profiles one user may keep: each one is a row the user can fill with settings, so the number is capped
export const MAX_PROFILES_PER_USER = readIntegerSetting("MAX_PROFILES_PER_USER", 20);

// health checks per client address per minute; the endpoint is public
export const HEALTH_CHECKS_PER_MINUTE = readIntegerSetting("HEALTH_CHECKS_PER_MINUTE", 30);

export const HEALTH_WINDOW_MS = MINUTE_MS;

// how long a health report is reused before the database and Ollama are checked again (0: every time, up to five
// minutes: a longer cache would show a stale state)
export const HEALTH_CACHE_SECONDS = readIntegerSetting("HEALTH_CACHE_SECONDS", 10, 0, 300);
