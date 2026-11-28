---
name: layered-express-middleware
description: How to write Express middlewares, including the core set every project has (error, notFound, validateBody, authenticate, currentUser, authorize, databaseReady). Use when creating or editing any v1/middlewares/*.middleware.ts file, or setting up error handling, auth or validation in a new project.
---

# Express middlewares

## 1. Location & naming

- File: `v1/middlewares/<name>.middleware.ts`, camelCase name (`validateBody.middleware.ts`).
- Export: `export const <name>Middleware` (e.g. `authorizeMiddleware`).

## 2. Responsibilities

- Does: cross-cutting concerns that run before controllers — authentication, authorization, validation, file parsing, rate limiting; plus the final `notFound` and `error` handlers.
- Never: business rules or data access specific to one resource (that's a service).

## 3. Templates

Core set, copy into every new project:

- [templates/error.middleware.ts](templates/error.middleware.ts) — the only place that writes error responses; logs with `describeError` (template in `layered-express-service`, goes in `utils/`)
- [templates/notFound.middleware.ts](templates/notFound.middleware.ts)
- [templates/validateBody.middleware.ts](templates/validateBody.middleware.ts)
- [templates/authenticate.middleware.ts](templates/authenticate.middleware.ts) — token only, sets `req.decoded`; needs the files below
  - [templates/auth.config.ts](templates/auth.config.ts) — `TOKEN_ALGORITHM`, `TOKEN_ISSUER`, `TOKEN_AUDIENCE`, the email and password length constants, `getSecretKey()`; goes in `config/`
  - [templates/token.util.ts](templates/token.util.ts) — `signToken`, `verifyToken`; goes in `utils/` (uses `isUuid` from the service skill)
- [templates/currentUser.middleware.ts](templates/currentUser.middleware.ts) — checks the account against the database and sets `req.user`; calls `getActiveUserService` (see `layered-express-service`)
- [templates/authorize.middleware.ts](templates/authorize.middleware.ts) — reads `req.user.role`
- [templates/databaseReady.middleware.ts](templates/databaseReady.middleware.ts) — 503 until the startup check has passed; needs `databaseReadiness.service.ts` and `databaseError.util.ts` from the structure skill
- [templates/securityHeaders.middleware.ts](templates/securityHeaders.middleware.ts) — first `app.use` in `app.ts`

When the project needs request limits:

- [templates/rateLimit.middleware.ts](templates/rateLimit.middleware.ts) — `rateLimitMiddleware({ limit, windowMs, keyBy, onlyFailures, onlySuccesses })` on top of `express-rate-limit`
  - [templates/clientAddress.util.ts](templates/clientAddress.util.ts) — `getClientAddress(req)`, goes in `utils/`
  - [templates/limits.config.ts](templates/limits.config.ts) — the limits and the token lifetime, each read with `readIntegerSetting`; goes in `config/`

## 4. Rules

- Plain middleware: `export const xMiddleware = (req: Request, res: Response, next: NextFunction) => { ... };`, with `import type { Request, Response, NextFunction } from "express";`.
- Configurable middleware is a factory with typed options: `export const xMiddleware = (options: XOptions) => (req: Request, res: Response, next: NextFunction) => { ... };` (e.g. `authorizeMiddleware(["admin"])` takes `roles: string[]`, `validateBodyMiddleware(schema)` takes a Joi `ObjectSchema`).
- Middlewares **never** send error responses themselves: they call `next(new AppError(status, message))`. Only `errorMiddleware` writes error bodies, so every error has the shape `{ message }` (+ `details` for validation).
- On success, either attach data to `req` and call `next()`, or just call `next()`. Agreed `req` properties, declared in `types/express.d.ts`:
  - `req.decoded?: DecodedToken` — set by `authenticateMiddleware`: what the token says (`TokenPayload`: `id`, `tokenVersion`) plus `expiresAt` (milliseconds since 1970). Nothing has checked it against the account yet, so it is never a signed-in user: use it only for the token-level work that runs before the database is asked (the per-user rate-limit key).
  - `req.user?: AuthenticatedUser` — set by `currentUserMiddleware`: `id`, the `role` the database has now and `expiresAt`. This is the signed-in user: `authorizeMiddleware` and `requireUserId(req)` read it (see `layered-express-controller`). All the auth types live in `types/auth.type.ts`; extend them there (and in `verifyToken`) when the token carries more fields.
  - `req.validatedBody?: unknown` — Joi output set by `validateBodyMiddleware`. Controllers cast it to the validator's input type.
  - Introduce new `req.*` properties only with a clear English name, declare them in `types/express.d.ts`, and document them here.
- Async middlewares wrap their body in `try/catch → next(error)`, same as controllers.
- `errorMiddleware` answers library errors that carry a 4xx `status` (malformed JSON from body-parser, a path parameter the router cannot decode) with that status, and shows their message only when the library sets `expose`; otherwise the message is a generic "Invalid request". They are client mistakes: never logged as server errors, never a 500.
- `errorMiddleware` first checks `res.headersSent`: when part of the response is already out (a stream), it calls `next(err)` and lets Express close the connection instead of sending a second response.
- `errorMiddleware` keeps the 4-argument signature `(err: unknown, req: Request, res: Response, next: NextFunction)`, is registered last, logs unexpected errors as `describeError(err)` (name, code and message) and never as the whole object, and never leaks their message (generic 500). A database error carries the failing row, the statement and its parameters, and any of them can hold the text of a document or a secret; `console.error(err)` would write them to the log. It narrows `err` with `instanceof AppError` or a type guard, never with `any`.
- `authenticateMiddleware` reads `Authorization: Bearer <token>` with one pattern (`/^bearer (\S+)$/i`): the scheme name is case-insensitive (RFC 9110), and anything after the token, an empty token or a second space makes the header invalid (401 "Authentication token is missing").
- Required config (e.g. `SECRET_KEY`, read through `getSecretKey()` from `config/auth.config.ts`) is checked before use; if it is missing, call `next(new Error("<NAME> is not set"))` so `errorMiddleware` answers 500. Do not cast it with `as string`.
- `validateBodyMiddleware` validates `req.body ?? {}`: Express 5 leaves `req.body` undefined for a request without a body, and Joi accepts undefined for an object schema.
- Tokens are signed and verified only through `utils/token.util.ts`: `signToken(payload, secret)` in the auth service, `verifyToken(token, secret)` in `authenticateMiddleware`. Both use `TOKEN_ALGORITHM` from `config/auth.config.ts`, so the algorithm is pinned in one place and tokens signed any other way, including `alg: none`, are rejected.
- Tokens carry `sub` (the user id), `ver` (the account's `token_version`), `iss`, `aud`, `iat` and `exp`, and no role. `signToken` sets the issuer and audience from `TOKEN_ISSUER` and `TOKEN_AUDIENCE`, and `verifyToken` requires them, so a token from another service is refused even when it shares the algorithm and the secret. There is no refresh token.
- `verifyToken` returns `DecodedToken | null` and checks the claims at run time (an expiry is present, `sub` is a UUID, `ver` is a non-negative integer) instead of casting them; a token without an expiry would never expire, so it is rejected: a correctly signed token with another shape gets the same 401 as a forged one. `req.decoded` gets only the checked fields, never the other claims of the token.
- `authenticateMiddleware` never asks the database. `currentUserMiddleware` does, once per request, with one query that reads the role, the status and the token version of the account: a missing account, a disabled one or a version that is not current is the same 401 "Invalid or expired authentication token" as a forged token, so the client cannot tell the reasons apart. Revocation works by raising `token_version` (logout, a password change, disabling the account); a role change needs no bump because the role is read on every request. The role is never read from the token.
- The order in `v1.routes.ts` is: public health route (it must work without the database) → `databaseReadyMiddleware` → public routes (login) → `authenticateMiddleware` → the per-user limit → `currentUserMiddleware` → protected routes. The per-user limit sits before the database check on purpose: a flood from one valid token is limited before it costs a query. `authorizeMiddleware` goes on the routes that need a role.
- `databaseReadyMiddleware` answers 503 with `DATABASE_UNAVAILABLE_MESSAGE` until `server.ts` has run its startup check (`setDatabaseReadyService`). `errorMiddleware` also answers 503, not 500, for a database that cannot be reached during a request (`isDatabaseUnreachableError`), without revealing anything about the connection.
- `securityHeadersMiddleware` is the first `app.use`, so every response carries its headers, error responses included: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. They fit an API that only returns private JSON; revisit them before serving HTML or cacheable files.
- Rate limits key client addresses with `getClientAddress(req)` (`utils/clientAddress.util.ts`), which is only the real address when `trust proxy` is set to the proxy in front of the API (see `layered-express-structure`). Rate limits: build each limit with `rateLimitMiddleware({ ... })` in the router, with values read from a config module (never hardcoded). Its handler calls `next(new AppError(429, ...))`, so a 429 has the usual error body. Limits per logged-in user (`keyBy: "user"`, one counter per user whatever their address) go on routes behind authentication; the key is `user:<id>:v<version>`, the version included, because a revoked token still reaches the limit (the account is checked afterwards) and must not use up the counter of the account's current session. A limit that guards a cost the user could spend over and over (a route that calls a model) is keyed by the id alone (`keyBy: "userId"`, key `userId:<id>`): a logout raises the version and a login gives a new token, so with the version in the key the counter would start again and the limit could be used up again at once. The price is that an old token of the account shares its counter, which the account's owner can revoke. Per-address limits (`keyBy: "ip"`) go before the route's `express.json()`, so a blocked address never gets its body read. Limits keyed by email (`keyBy: "emailAndIp"`, one counter per email and address, so nobody can lock another person out) read the raw body and must run after it; the email in the key is normalized like the validator does (NFC, trimmed, lowercased), and an email longer than `MAX_EMAIL_LENGTH` or a value that is not text is left out of the key (the address alone counts it), so a flood of huge emails cannot fill the in-memory counters. `onlyFailures` counts only error responses (failed logins); `onlySuccesses` counts only successful ones, so typos do not use up a limit; a route that is a way to guess or to cost the server (a password change; an account creation, which hashes a password before it answers a duplicate) counts every attempt instead. A project with rate limits also puts a general per-address limit in `app.ts` right after `cors` (before any authentication, so forged tokens and unknown paths cost nothing beyond the 429; `OPTIONS` preflights end in `cors` and are not counted), and one general limit (`keyBy: "user"`, for example 120 per minute) right after `authenticateMiddleware` in `v1.routes.ts`: cheap reads and deletes have no limit of their own, and without it one account could take every database connection; the routes' own limits apply on top. Counters are in memory and reset when the API restarts.

## 5. Checklist

- [ ] Named `<name>Middleware`, factory form when it takes options.
- [ ] Errors go through `next(new AppError(...))`, never `res.status(4xx).json(...)`.
- [ ] Data passed downstream only via `req.decoded`, `req.user`, `req.validatedBody` or a property declared in `types/express.d.ts` and documented here.
- [ ] Roles and account state are read from `req.user` (the database), never from the token.
- [ ] Parameters typed with Express's `Request`, `Response`, `NextFunction`.
