---
name: layered-express-service
description: How to write the service (business logic) layer of an Express API. Use when creating or editing any v1/services/*.service.ts file, adding business rules, existence/uniqueness/ownership checks, or calling external APIs.
---

# Express services

## 1. Location & naming

- File: `v1/services/<entities>.service.ts` (e.g. `products.service.ts`).
- Functions: the controller name + `Service` suffix: `getProductsService`, `getProductByIdService`, `createProductService`, `updateProductService`, `deleteProductService`.
- Wrappers around external APIs get their own file named after the provider: `ollama.service.ts`.

## 2. Responsibilities

- Does: business rules, existence/uniqueness/ownership checks, data access, calls to external APIs, shaping the returned data.
- Never: touch `req`, `res` or `next`; send responses; read `process.env` for request-specific data.

## 3. Template

- [templates/products.service.ts](templates/products.service.ts) — CRUD with PostgreSQL through `pg`
- [templates/dbErrors.util.ts](templates/dbErrors.util.ts) — `isUniqueViolation`, goes in `utils/`
- [templates/uuid.util.ts](templates/uuid.util.ts) — `isUuid`, goes in `utils/`
- [templates/modelUnavailableError.util.ts](templates/modelUnavailableError.util.ts) — example of an `AppError` subclass that callers recognize by type, goes in `utils/`
- [templates/password.util.ts](templates/password.util.ts) — `hashPassword`, `verifyPassword`, `needsRehash`, `isUsableHash` (scrypt from `node:crypto`), goes in `utils/`

The template assumes PostgreSQL with `pg` and the `pool` / `withTransaction` from `config/db.config.ts`, which connect as the low-privilege API role (see `layered-express-structure`): a service can read and change rows and nothing else, so a query that needs a new table or column waits for its migration. A project with another data layer keeps the same rules and swaps the queries.

## 4. Rules

- Signature: `export const name = async (...plainArgs): Promise<ReturnType> => { ... };`. Arguments are plain, typed values (`id: string`, `data: CreateProductInput`, `userId: string`, `page: unknown`, `limit: unknown`), never `req`. Ids are UUID strings.
- Always annotate the return type: the entity type from `types/<entities>.type.ts` (`Promise<Product>`, `Promise<Product[]>`), a purpose-built shape when you return a subset of fields, or `Promise<void>` when nothing is returned (e.g. delete).
- `data` arguments use the input types exported by the validator (`CreateProductInput`, `UpdateProductInput`), imported with `import type`.
- Argument order: `userId` (when ownership matters) → `id` → `data` → `page, limit`.
- Signal every expected failure with `throw new AppError(status, message)`:

  | Situation | Status |
  |---|---|
  | invalid input that passed Joi (business rule broken) | 400 |
  | role not allowed for this action | 403 |
  | resource not found, or it belongs to another user | 404 |
  | duplicate / state conflict (including a quota already used up) | 409 |
  | temporarily unavailable: a queue is full or a dependency is down | 503 |
  | a dependency did not answer in time | 504 |

  Messages are short English sentences: "Product not found".
- When a caller must react to one specific failure (for example, background work retrying later when a dependency is down), throw an `AppError` subclass in `utils/<name>Error.util.ts` (e.g. `ModelUnavailableError`, 503) and check it with `instanceof`. Never branch on `error.status === 503`: another 503 would trigger the same reaction.
- One reason to change per service file. For example, background work is split into its event observer (`events.service.ts`), the work for one job (`indexing.service.ts`) and the scheduling of the queue (`jobQueue.service.ts`), instead of one file doing all three.
- Never throw `Error` with a `.status`, never use status `200` in an `AppError`, and use `5xx` only for the 503/504 cases above: any other 5xx is an unexpected error that must bubble up to `errorMiddleware`'s generic 500. Do not catch errors just to rethrow them; let unexpected errors bubble up.
- `getById`, `update` and `delete` always 404 when the resource does not exist.
- `update` re-checks uniqueness only for the fields being changed, excluding the current record.
- Ids from the URL are checked with `isUuid(id)` (`utils/uuid.util.ts`) before querying; a malformed id gets the same 404 as an unknown one, instead of PostgreSQL's `22P02` error becoming a 500.
- Ownership: when a resource belongs to a user, receive `userId` and filter by it in the query itself (`WHERE id = $1 AND user_id = $2`). A resource of another user gets the same 404 as a missing one, so its existence is not revealed.
- Lists return an empty array when nothing is found, never an error.
- Pagination (inline for now): `page` and `limit` arrive as `unknown` straight from `req.query`; `const pageNumber = Number(page) || 1; const limitNumber = Number(limit) || 5; const offset = (pageNumber - 1) * limitNumber;`
- Never return secrets (password hashes, tokens of other users). Pick the fields to return explicitly, and make the return type exclude them (e.g. `Omit<User, "passwordHash">`).
- A service may call another service; it never imports a controller.

### Data access (PostgreSQL with `pg`)

- Query with `pool.query<Row>(sql, [values])`. Values always go as `$1, $2, ...` parameters, never inside the SQL text: no template literals with user data. Only fixed SQL fragments written in the code (like a column list) may be interpolated.
- List columns explicitly, never `SELECT *` or `RETURNING *`, and rename snake_case to camelCase in SQL: `category_id AS "categoryId"`. Keep the list in one constant per file, e.g. `PRODUCT_COLUMNS`, matching the entity type.
- Use `RETURNING <columns>` to get the created, updated or deleted row in the same query; an empty result means nothing matched, which is the 404 case.
- `pg` returns `bigint` (including `count(*)`) and `numeric` as strings. Cast in SQL (`count(*)::int`, `price::float8`) or convert with `Number(...)`.
- Several writes that must succeed or fail together go inside `withTransaction(async (client) => { ... })`, using `client.query`, not `pool.query`.
- The API's pool has a query timeout (30 s), so a query on a connection that stopped answering fails instead of holding its request; a probe that must be quicker (the health check's `SELECT 1`, 2 s) passes its own `query_timeout` in the query config. Scripts that may run longer (`migrate`) build their own pool with `createPool({ connectionString })` from `config/pool.config.ts`, with the owner's `MIGRATION_DATABASE_URL`, and pass it to `runInTransaction(pool, callback)` or to the service function that takes one (`getMigrationStateService(targetPool)`).
- Never keep a transaction open while calling an external service (a model, another API): finish the transaction first, then make the call. A slow call would hold the connection and its row locks.
- Check uniqueness before inserting, and also translate the database's unique violation (`isUniqueViolation(error)`, code `23505`) into the same `AppError(409)`, since two requests can pass the check at the same time.
- Compare case-insensitive values (emails, names) as `lower(column) = lower($1)`, matching the unique index on `lower(column)`.

- A statement that must apply only if the row is still as it was read (a password change, a rehash at login) carries that as a condition (`WHERE id = $1 AND password_hash = $3`). When it matches no row because another request got there first, throw a 409 with a message that says to try again; never overwrite what the other request wrote.
- A change that depends on the state of more than one row (an admin changes another account, and the actor must still be an admin) runs in one `withTransaction`: lock the rows involved with `SELECT ... FOR UPDATE ... ORDER BY id` (the same order in every call, so two calls cannot wait for each other), re-check the actor's right on the locked row, then make the change. A check made earlier by a middleware can be out of date by the time the change runs.
- A database that cannot be reached is not an `AppError` the service throws: let the driver's error bubble up, and `errorMiddleware` answers 503 (`isDatabaseUnreachableError`).

### Accounts and passwords

- Passwords go through `utils/password.util.ts` only (`hashPassword`, `verifyPassword`, `needsRehash`, `isUsableHash`): scrypt from `node:crypto`, the cost parameters stored with each hash, NFKC normalization before hashing, `timingSafeEqual` to compare. No other hash and no hash code in a service. Hash parameters read from the database outside fixed ranges, or a value of another shape, are a password that does not match, never an error or a huge allocation.
- A hash is never returned, logged or put in a type the API returns: the entity type (`User`) has no hash and no token version, and the row type that has them (`UserRecord`) is used only inside the auth service.
- Login checks an unknown email against a dummy hash (computed on first use, cached), so it takes as long as a wrong password, and runs the dummy hash after a failure against an old or unusable stored hash too, so the response time does not show which accounts have one. The unknown email and the wrong password give the same 401 message. A disabled account is a 403 only after a correct password, so the answer does not reveal which accounts exist or are disabled. A wrong current password in a password change is a 400, not a 401, which a client would take for an expired session. A hash made with other cost parameters is replaced at the next successful login (a rehash).
- Sessions are revoked with a counter on the account (`token_version`), compared with the token's `ver` on every request by `getActiveUserService` (one query: role, status and version; anything wrong is the same 401 as a forged token). Logout, a password change and disabling the account raise it (`token_version = token_version + 1`, in the same statement that makes the change); a password change returns a new token made with the new version. A role change does not raise it, because the role is read from the database on every request.
- A user cannot change their own role or status through the admin route (409); another admin does it. Unique emails are checked first and also translated from the database's unique violation, as above.

### Settings chosen by users

- A setting that users may change (top_k, chunk size, router thresholds, model, max tokens, ...) is data: it lives in a profile row in the database, not in `.env` or a constant. `.env` and `config/` hold only the server's own settings and the **caps**: the allowed values and the maximums for each user setting.
- A service that runs with user settings receives one resolved configuration object (profile plus per-request overrides), checked against the caps in one place before any work starts. A value outside its cap is a 400 `AppError`; it is never clamped silently, so the stored snapshot always matches what ran.
- A user setting never reaches SQL text, a file path or an outgoing request unchecked: a model name or a retrieval mode must be one of the allowed values, never a free string.

### Calls to a model

- Every model call goes through the provider's wrapper (`ollama.service.ts`). It takes an `AbortSignal` and a timeout, validates the shape of the response, and returns the answer together with the provider's token counts (`prompt_eval_count`, `eval_count`, the embed endpoint's count), so the caller can store them; callers never read the raw response.
- A model that cannot be reached throws `ModelUnavailableError` (503); a model that did not answer in time throws a 504 `AppError`. An error answer, an answer of an unexpected shape or a redirect is a plain `Error`: retrying will not fix it.
- Calls refuse redirects (`fetch(url, { redirect: "manual" })`): a model server that redirects is misconfigured or taken over, and following it would send the request to an address nobody chose. The base URL comes from `config/ollama.config.ts`, validated at startup as an absolute http or https URL, with a trailing slash stripped.
- Anything that asks which models exist, such as the health check, reads them through the wrapper (`listInstalledModelsService` in `ollama.service.ts`), never with its own `fetch`. The health service compares the installed names exactly with the required list in `config/ollama.config.ts`.
- A check that reports a dependency as up or down (the health service) catches its own errors and returns the state, with a timeout on each dependency; and because anyone may call it, it caches its report for a few seconds and lets requests that arrive during a check wait for that same check.

## 5. Checklist

- [ ] No `req`/`res`/`next` anywhere in the file.
- [ ] Every expected failure throws `AppError` with the right status.
- [ ] Not-found checks on get-by-id, update and delete.
- [ ] Ownership filtered in the query when the resource belongs to a user; another user's resource gets 404.
- [ ] Sensitive fields excluded from the result and from its type.
- [ ] Arguments and return type annotated; no `any`.
- [ ] Every value is a `$n` parameter; columns are listed explicitly and renamed to camelCase.
