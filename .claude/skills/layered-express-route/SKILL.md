---
name: layered-express-route
description: How to write Express routers. Use when creating or editing any v1/routes/*.routes.ts file, adding an endpoint, choosing HTTP methods/paths, or mounting a router in v1.routes.ts.
---

# Express routes

## 1. Location & naming

- File: `v1/routes/<entities>.routes.ts` (e.g. `products.routes.ts`).
- Export: `export const <entities>Router` (e.g. `productsRouter`).
- URL paths: plural, lowercase, kebab-case English nouns (`/products`, `/watchlist-items`). Mounted in `v1/v1.routes.ts`.

## 2. Responsibilities

- Does: map HTTP method + path → middlewares → one controller function.
- Never: inline handlers, business logic, `try/catch`, or direct service calls.

## 3. Template

[templates/products.routes.ts](templates/products.routes.ts)

[templates/documents.routes.ts](templates/documents.routes.ts) — an upload route (limiter before a body limit derived from the longest text) that mounts a nested router; [templates/documentIndexes.routes.ts](templates/documentIndexes.routes.ts) — the nested router (`mergeParams`) with its own per-user limiter on the route that starts background work

## 4. Rules

- Create the router with `express.Router({ mergeParams: true })`.
- Standard CRUD mapping:

  | Method & path | Controller | Status |
  |---|---|---|
  | `GET /` | `get<Entities>` | 200 |
  | `GET /:id` | `get<Entity>ById` | 200 |
  | `POST /` | `create<Entity>` | 201 |
  | `PATCH /:id` | `update<Entity>` | 200 |
  | `DELETE /:id` | `delete<Entity>` | 200 |

  Use `PATCH` for updates, not `PUT`.
- Middleware order on a route is always: rate limits keyed by address → `authorizeMiddleware([...])` → rate limits keyed by user → `express.json()` → rate limits that read the body → `validateBodyMiddleware(schema)` → controller. A limit keyed by user that guards an admin action goes after `authorizeMiddleware`, so a user who is told 403 uses up nothing of an admin's attempts; one that guards a route that checks or hashes a password counts every attempt (no `onlyFailures`), before the body is read.
- There is no global body parser: every route that reads a body adds `express.json()` itself, right before the first middleware that reads `req.body`. Use `express.json({ limit: "2mb" })` (or what the route needs) only where the 100 KB default is too small, and a smaller limit where the body is small by nature: a profile of eleven values is read with `express.json({ limit: CONFIGURATION_BODY_LIMIT })` (16 kB, a constant in `config/`), so a bigger body is a 413 `request entity too large` before it is parsed. The limit sits on the routes that take the small body, not in `app.ts`. Requests rejected earlier (no token, no role, address over its limit) never get their body read.
- A route that costs the model server real time (an upload that queues indexing, a request that starts a build) puts a per-user limit in front of `express.json()`, so every attempt counts, the refused ones and the ones that find the work already done too, and a client cannot make the server read a large body for nothing. Each such route has its own limiter instance, so its counter is separate (uploading does not use up the builds, and the other way round); two routes may take their value from the same setting. Reads and deletes are not counted there: the general per-user limit covers them.
- The body limit follows from what the body may hold. An upload's body is a text of at most `MAX_DOCUMENT_CHARACTERS` characters, 3 bytes each in UTF-8 and room for the JSON around it: a constant derived in `config/limits.config.ts` (`3 * MAX_DOCUMENT_CHARACTERS + 16 * 1024`), not a setting of its own, so it moves with the character cap. A body of two small settings uses the small limit of the configuration routes.
- A child resource (the indexes of a document) is a nested router in its own file, exported as `<entities>Router`, mounted by the parent router with `parentRouter.use("/:id/indexes", childRouter)`, and created with `express.Router({ mergeParams: true })` so it sees the parent's `:id`. Its controllers declare the params they read, `Request<{ id: string; indexId: string }>`. Mount the nested router after the parent's own routes. The services check that the parent belongs to the caller before they touch the child, and a parent that is not the caller's is the same 404 as one that does not exist.
- A route that starts background work answers 202 (see `layered-express-controller`).
- Every `POST` and `PATCH` with a body uses `express.json()` and `validateBodyMiddleware`: `create<Entity>Schema` for POST, `update<Entity>Schema` for PATCH.
- Authentication is applied once in `v1.routes.ts`. Do **not** add `authenticateMiddleware` or `currentUserMiddleware` again inside a router mounted in the protected section. When the project has rate limits, a general per-user limit follows `authenticateMiddleware` there and precedes `currentUserMiddleware` (see `layered-express-middleware`), so every protected route is limited even without a limit of its own.
- An action that must be refused to a token that has already been revoked (logout) goes in a router mounted in the protected section, after `currentUserMiddleware`, so the revoked token is a 401 and the action does not run again (`authProtectedRouter` for `POST /auth/logout`, next to the public `authRouter` for login, both mounted on `/auth`).
- Declare static paths (`/me`, `/trending`) **before** parameterized ones (`/:id`).
- Line order in the file: list, by id, create, update, delete, then custom actions.
- Custom actions are sub-resources/verbs under the item: `PATCH /:id/role`, `GET /me`.
- Mounting: add the import and `v1Router.use("/<entities>", <entities>Router)` in the public section (before `authenticateMiddleware`) only if the endpoints need no login; otherwise in the protected section.

## 5. Checklist

- [ ] Router exported as a named `<entities>Router`.
- [ ] Each route ends in exactly one controller function.
- [ ] Bodies on POST/PATCH are parsed by the route's own `express.json()` and validated with the right schema.
- [ ] Static paths come before `/:id`.
- [ ] Router mounted in `v1.routes.ts` in the correct section.
