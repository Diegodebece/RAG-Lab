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
- [templates/uuid.util.ts](templates/uuid.util.ts) — `UUID_PATTERN` and `isUuid`, goes in `utils/`; the validators use the same pattern
- [templates/configuration.service.ts](templates/configuration.service.ts) — settings chosen by users: the definition for clients, the resolver (override, then profile, then default) and the startup check of the default; needs the config, type and validator templates of the structure and validator skills
- [templates/configurationSnapshot.util.ts](templates/configurationSnapshot.util.ts) — canonical JSON, SHA-256 hash and a frozen snapshot, goes in `utils/`
- [templates/unknownSetting.util.ts](templates/unknownSetting.util.ts) — the message for an unknown setting key, cut to 64 characters, goes in `utils/`
- [templates/modelUnavailableError.util.ts](templates/modelUnavailableError.util.ts) — example of an `AppError` subclass that callers recognize by type, goes in `utils/`
- [templates/describeError.util.ts](templates/describeError.util.ts) — `describeError`, what an error may put in a log (name, code, message), goes in `utils/`
- [templates/documentIndexes.service.ts](templates/documentIndexes.service.ts) — a job created by a request: the build caps under the user's row lock plus an advisory lock, the lock-free pre-check before expensive work, "ensure" semantics (`created`), the usage row, and a read that never builds (`findReadyIndexService`)
- [templates/indexingQueue.service.ts](templates/indexingQueue.service.ts) — the rows as a persisted queue: the claim that skips disabled users, one in-process worker, the wake flag, aborting a build on delete, stuck-build requeue, recovery and stop
- [templates/indexing.service.ts](templates/indexing.service.ts) — the work of one claimed job: vectors and counts stored in one short transaction with the parent row locked first, and the probe-based retry that keeps a database error apart from a model failure
- [templates/modelTurn.service.ts](templates/modelTurn.service.ts) — one model request at a time for the whole API, first come first served, with the caller's signal and a maximum wait
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
- Two kinds of cap, in two places. Value caps (what may run: the allowed models, the ranges) are constants in `config/<name>.config.ts`, next to the definition of the settings and the version number; they change with a new configuration version and a migration. Consumption caps (how much: profiles per user, request limits) are in `config/limits.config.ts` and `.env`, read with `readIntegerSetting`.
- The defaults are a read-only table (see `layered-express-structure`): one row, seeded and changed only by migrations, never by a route. The API role has `SELECT` only on it.
- User profiles are sparse: they hold only the keys the user set, plus the configuration `version` they were written for, and a missing key takes the default. A `PATCH` with `settings` replaces the stored object as a whole.
- A service that runs with user settings receives one resolved configuration object (profile plus per-request overrides), built by one resolver and checked against the caps in one place before any work starts. A value outside its cap is a 400 `AppError`; it is never clamped silently, so the stored snapshot always matches what ran. The same schema checks a value when it is written and when it is used, so there is one definition of each cap.
- The resolver merges by known keys only: for each key of the definition, `Object.hasOwn(overrides, key)`, then the profile, then the default. It never spreads or deep-merges an object a user wrote (`{ ...a, ...b }`, `Object.assign`, lodash `merge`) and never reads a key through the prototype, so `__proto__` cannot reach the result. A key that is not a setting is a problem in the answer, never ignored.
- A stored profile outside today's caps (saved before a cap changed) is shown with its problems and refused at use with a 400 listing every problem; it is never clamped or replaced. Reading and deleting it still work, because it is the user's.
- Who is to blame decides the status. What the user sent or saved (overrides, their own profile outside the caps) is a 400. What the server holds (the default profile broken while the server runs, a profile at a configuration version this code cannot read) is a plain `Error`: `errorMiddleware` answers the generic 500, and the problems go to the log. The default is checked on its own first, so a broken default is never shown to a user as their 400. A `PATCH` on a profile at another version is a 409 and changes nothing; `version` is written only when the settings are replaced, never by a rename.
- The startup check (`getConfigurationProblemsService`, called by `server.ts` after the schema check) refuses to start when the default row is missing, at another version or outside the caps, and when any stored profile is at another version. A profile outside the caps is not a startup problem.
- A snapshot is the resolved configuration as `{ version, settings }`, frozen. Its text is canonical JSON (keys sorted at every level, no spaces, only what JSON can hold) and its hash is the SHA-256 of that text in hex (`utils/configurationSnapshot.util.ts`). The id of the profile and the timestamps are outside it, so identical settings are one configuration. The hash identifies, it does not authenticate: never accept a snapshot or a hash from a client, and put the user and the document or index ids in any cache key.
- A per-user limit on rows (profiles per user) is counted inside the transaction that inserts, after locking the owner's row (`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`), so two creations that arrive together are served one after the other. The lock is held only for that short transaction.
- A user setting never reaches SQL text, a file path or an outgoing request unchecked: a model name or a retrieval mode must be one of the allowed values, never a free string.

### Background jobs and queues

The queue is the table (layer 4: `document_indexes`), not a second system. Copy the templates and keep these rules.

- **Persisted queue.** A job is a row whose `status` is `queued`, `indexing`, `ready` or `failed`. The worker claims the oldest queued row with one `UPDATE ... WHERE id = (SELECT ... ORDER BY queued_at, id LIMIT 1 FOR UPDATE OF <job> SKIP LOCKED) RETURNING ...`, which reads the owner in the same statement. One worker runs in the process, started by `server.ts` (see `layered-express-structure`); one model request at a time goes through `runWithModelTurnService`, one turn per batch, so a question waits for at most one batch. Calls to `process...Service` made while it runs share the same run, so a job is never built twice in parallel.
- **The claim skips disabled users.** The subquery joins the owner and requires `u.status = 'active'`: the jobs of a disabled account stay queued and unchanged, use none of the model's time, and run when the account is active again.
- **The wake flag.** `notify...Service()` sets `wakeRequested = true` whether or not a run is going on and starts a run only when the worker is started and idle. The loop clears the flag before it looks at the queue and reads it before it goes idle, with nothing awaited between that read and the end of the run, so a job queued while the loop was finishing its last, empty look is never left for the poll. The poll (every few seconds, with an unref'd timer) also requeues stuck builds and wakes the worker.
- **Cancelling is deleting.** There is no `cancelled` state: the service deletes the row, and only after the delete calls `abort...Service({ indexId } | { documentId })`, which aborts the in-flight request when it is that job's; the worker cannot take the row again in between. The build catches `RequestCancelledError` and puts the job back in the queue quietly (a deleted row matches nothing). Stopping the worker aborts the same way, and the job goes back to the queue with the vectors it has stored, not to `failed`.
- **Recovery and stuck builds.** At startup, before the worker, every `indexing` row goes back to `queued` keeping its stored work and its attempts (an interrupted build is not a failed attempt). While the API runs, a row still `indexing` over a minute after it started and that is not the one this process runs is put back too (an error after the claim, for example the database failing in the middle, can leave one).
- **Store the work in one short transaction after the model call.** Never hold a transaction open while the model works. `storeBatch` locks the parent row first (`SELECT 1 FROM <jobs> WHERE id = $1 AND status = 'indexing' FOR NO KEY UPDATE`), then updates the children, then the counts, which it reads from the children themselves. A delete takes the parent row and then the children through the cascade, so taking the children first would deadlock with it: lock in the order the delete does. A batch whose chunks are already filled (`embedding IS NULL` is part of the `WHERE`) or whose job is gone returns `null`, and the build ends as `done`. A build continues where it stopped: it reads only the children without a vector.
- **Retry by probing.** Only the call to the model is guarded. A failed batch asks the server once what it has installed (`GET /api/tags`, short timeout): it does not answer, or the probe times out, so it is away: requeue with the attempts unchanged and stop the queue until its next round; it answers and the model is not in its list: fail at once with its own message; it answers and has the model, or answers with something that is not a list (an error status, a body that cannot be read): it is up, so the batch was dropped and counts as an attempt (`attempts + 1`, failed after `MAX_INDEXING_ATTEMPTS`, else requeue), so a server that is up and broken runs out of attempts. A timeout of the model call takes this path too, not an instant failure. An answer that is not what the API needs (`MalformedModelAnswerError`: a body that arrived whole and is not JSON, the wrong number of vectors, a vector of the wrong size, a number beyond the float4 range) fails at once. An `AppError` that is neither unavailable nor timeout fails with its own message.
- **A database error is not the model's fault.** It is not caught around the model call: no probe, no attempt, the job is not failed. It goes up, the queue logs it, and the job stays `indexing` until the stuck-build requeue puts it back.
- **Caps on starting a job.** The caps that count other rows (the user's builds in progress, the builds of the last 24 hours per user and in all, the queue) are checked in a fixed order, so the same request always gets the same refusal (409 in progress, 429 per user per day, 429 in all per day, 503 queue full). They run in one transaction that takes the user's row lock (`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`) and then an advisory lock (`pg_advisory_xact_lock`, number in `LOCK_KEYS`), always in that order, so two requests cannot wait for each other and two users cannot both take the last place. Each accepted build inserts a `index_build_usage` row; the daily counts read those rows, so deleting a job does not give it back. The queue cap counts waiting jobs of every user, not running ones.
- **A lock-free pre-check before expensive work.** The same function runs first with the pool and no lock, before reading or chunking a text that may be a million characters. It is only a guess (another request may take the last place a moment later); the check under the locks decides. A document upload first checks the documents cap the same way.
- **"Ensure" semantics.** A request for a job that already exists (queued, indexing or ready) returns it with `created: false` before any cap is looked at, because nothing is built; the controller answers 200. A failed job is queued again with the same id (attempts 0, no error, a new queue time, the work it kept) and counts as a build; a missing one is made. Both answer 202.
- **Builds start in one place.** Only the services of the routes that create the thing (`createDocumentService`, `createDocumentIndexService`) spend the build caps. A service that answers from the result (`findReadyIndexService`) never builds and never calls the model: a job that is not ready is a 409 that tells the client to build it first. A dry run (`POST /v1/configuration/resolve`) accepts the job's settings and starts nothing.
- **Events.** The worker emits `started`, `progress`, `ready` and `failed` through `emitEvent` (an observer in `events.service.ts`); each names the job and its owner and none carries the text of a document or a chunk. `server.ts` logs them; a later layer streams them to the owner only.
- **What goes in a log.** An unexpected error is logged as `describeError(error)` (`utils/describeError.util.ts`: name, code and message), never as the error object: a database error carries the failing row, the statement and its parameters, and any of them can hold the text of a document. `errorMiddleware` and the background code do the same. Write the log line yourself with the job id.
- **Vectors.** The wrapper accepts only vectors of the model's dimensions, with finite numbers inside the float4 range (`FLOAT4_MAX`, because that is what the vector type stores) and not all zeros; anything else is a `MalformedModelAnswerError`.

### Calls to a model

- Every model call goes through the provider's wrapper (`ollama.service.ts`). It takes an `AbortSignal` and a timeout (`OLLAMA_TIMEOUT_MS` for a call that does work, a short one for a probe), validates the shape of the response, and returns the answer together with the provider's token counts (`prompt_eval_count`, `eval_count`, the embed endpoint's count), so the caller can store them; callers never read the raw response. An embed call sends `truncate: false`, so an input longer than the model's window is an error answer and never a silently shortened vector.
- A model that cannot be reached, or whose answer is cut in the middle of the body, throws `ModelUnavailableError` (503); a model that did not answer in time throws `ModelTimeoutError` (504, an `AppError` subclass); a caller's signal that aborted throws `RequestCancelledError` (nothing is sent when it was aborted before the call). An error answer, an answer of an unexpected shape or a redirect is a plain `Error`: retrying will not fix it; a body that arrives whole and is not JSON is a `MalformedModelAnswerError`, also a plain `Error`. Callers recognize each by `instanceof`.
- The text of an error answer is part of the message only for a GET: the answer to a POST may quote what was sent (the text of a document).
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
