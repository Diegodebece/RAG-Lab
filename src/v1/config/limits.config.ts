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

// profiles one user may keep, from 1 to 1000: each one is a row the user can fill with settings, so the number is capped
// at both ends
export const MAX_PROFILES_PER_USER = readIntegerSetting("MAX_PROFILES_PER_USER", 20, 1, 1000);

// Documents and indexes (layer 4). Each setting has a top as well as a bottom: it caps what one user, or the whole server,
// may consume, and a cap of a billion would be no cap at all.

// documents one user may keep; none is deleted automatically, the user deletes one to upload another
export const MAX_DOCUMENTS_PER_USER = readIntegerSetting("MAX_DOCUMENTS_PER_USER", 3, 1, 1000);

// the longest text of one document, in characters (UTF-16 code units, the length of a JavaScript string)
export const MAX_DOCUMENT_CHARACTERS = readIntegerSetting("MAX_DOCUMENT_CHARACTERS", 1_000_000, 1, 5_000_000);

// document uploads per user per minute
export const UPLOAD_REQUESTS_PER_MINUTE = readIntegerSetting("UPLOAD_REQUESTS_PER_MINUTE", 5, 1, 1000);

export const UPLOAD_WINDOW_MS = MINUTE_MS;

// index builds one user may have waiting or running at once
export const MAX_ACTIVE_INDEX_BUILDS_PER_USER = readIntegerSetting("MAX_ACTIVE_INDEX_BUILDS_PER_USER", 1, 1, 100);

// index builds waiting in the queue, every user together; over it the API answers 503
export const MAX_QUEUED_INDEX_BUILDS = readIntegerSetting("MAX_QUEUED_INDEX_BUILDS", 20, 1, 1000);

// index builds one user may have accepted in the last 24 hours (a deleted document does not give its builds back)
export const MAX_INDEX_BUILDS_PER_DAY = readIntegerSetting("MAX_INDEX_BUILDS_PER_DAY", 6, 1, 1000);

// index builds accepted from every user together in the last 24 hours
export const MAX_INDEX_BUILDS_PER_DAY_TOTAL = readIntegerSetting("MAX_INDEX_BUILDS_PER_DAY_TOTAL", 100, 1, 10_000);

// The body limit of the upload route, in bytes: a text of the longest length takes up to 3 bytes a character in UTF-8 (the
// emoji, which takes 4 bytes, is two characters of the count), and the body also holds the filename and the JSON around
// the text: 16 kB is the room for those. It follows MAX_DOCUMENT_CHARACTERS and is not a setting of its own.
export const DOCUMENT_BODY_LIMIT = 3 * MAX_DOCUMENT_CHARACTERS + 16 * 1024;

// Questions (layer 5, the first route that calls a model while a request waits; layer 6 reuses the same limits). Each setting has a
// top as well as a bottom, like the ones above.

// questions per user per minute; counted before the body is read, and separate from the upload and index counters
export const QUESTIONS_PER_MINUTE = readIntegerSetting("QUESTIONS_PER_MINUTE", 10, 1, 1000);

export const QUESTION_WINDOW_MS = MINUTE_MS;

// questions one user may have answered in the last 24 hours, counted from the runs table
export const MAX_QUESTIONS_PER_DAY = readIntegerSetting("MAX_QUESTIONS_PER_DAY", 30, 1, 100_000);

// how long one question may take in all, waiting for the model's turn included. Cloudflare cuts a response at 100 seconds,
// so the top is 90.
export const MAX_QUESTION_SECONDS = readIntegerSetting("MAX_QUESTION_SECONDS", 60, 1, 90);

// questions waiting for the model's turn, every user together; over it the API answers 503. The indexing batches have their own cap.
export const MAX_WAITING_QUESTIONS = readIntegerSetting("MAX_WAITING_QUESTIONS", 20, 1, 1000);

// the longest question, in characters (RAG Web's MAX_QUESTION_CHARS)
export const QUESTION_MAX_CHARACTERS = 1000;

// health checks per client address per minute; the endpoint is public
export const HEALTH_CHECKS_PER_MINUTE = readIntegerSetting("HEALTH_CHECKS_PER_MINUTE", 30);

export const HEALTH_WINDOW_MS = MINUTE_MS;

// how long a health report is reused before the database and Ollama are checked again (0: every time, up to five
// minutes: a longer cache would show a stale state)
export const HEALTH_CACHE_SECONDS = readIntegerSetting("HEALTH_CACHE_SECONDS", 10, 0, 300);
