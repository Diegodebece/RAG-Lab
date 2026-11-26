# Project guide

How RAG Lab is built and why. [design.md](design.md) is the source of truth for what the project is and how the agents work; this guide describes the code as it is, section by section, and records each decision taken while building it. The API contract is in [api/](api/). Every decision sits in a box that starts with **Decision:**.

## 1. Origin and goal

RAG Lab is a RAG API built by a team of Claude Code agents: two local models and a router answer questions about uploaded documents, every question is measured (accuracy, latency, tokens), and each signed-in user changes the configuration in a playground to see how precision and token use respond. It reuses the architecture and the evaluated settings of RAG Web (the deployed RAG API) and the evaluation harness of RAG1 (the original command-line app); see design section 1.

The work goes in layers, in the order of [design section 13](design.md#13-build-order). Layer 1, Foundations, is built: the app, the health check, the migrations, the middlewares and the test setup. There are no accounts, documents or questions yet.

## 2. Stack

| Part | Choice |
|---|---|
| Runtime | Node.js 22.18 or later, ES modules |
| Language | TypeScript, `strict`, `NodeNext`; `tsc` compiles `src/` to `dist/`, `tsx` runs the sources in development |
| Web | Express 5, Joi for validation, `jsonwebtoken` (HS256) for tokens, `cors`, `express-rate-limit` |
| Data | PostgreSQL 17 with pgvector through `pg`; plain parameterized SQL, numbered migrations, no ORM |
| Models | Ollama on the host, always through `ollama.service.ts` |
| Tests | `node:test` with `tsx`, `supertest` for routes |

The database is the `db` service of `docker-compose.yml` (image `pgvector/pgvector:pg17`, project `rag-lab`), published on `127.0.0.1:25432` only. Its data lives in the `pgdata` volume.

## 3. Repository and workflow

- One `feature/*` branch and worktree per task; the owner merges. The feature loop (planner, test-writer, implementer, auditors, finding-verifier, implementer, docs-keeper) and the experiment loop are in [design sections 8 and 9](design.md#8-agent-team), and the working rules are in `CLAUDE.md`.
- Every fix or feature gets a test shown to fail without it, then the whole suite passes.
- Evaluation sets, documents and run results are private and live outside the repository (`RAG_LAB_DATA_DIR`).
- `.gitattributes` sets `* text=auto eol=lf`, so every text file has LF line endings on every computer.

> [!NOTE]
> **Decision:** the repository has a `.gitattributes` with LF line endings (2026-11-26). The owner works on Windows, where git would otherwise convert line endings and make the same file differ between the owner's checkout, the agents' worktrees and CI.

> [!NOTE]
> **Decision:** layer 1 has no linter (2026-11-26). The type checker (`npm run typecheck`), the tests and the independent audits cover what a linter would; one can be added later with the owner's approval as a new dependency.

## 4. Code conventions

The standards are in `CLAUDE.md` and the `layered-express-*` skills. In short: everything in English, 4-space indentation, double quotes, semicolons, named exports, arrow functions, `async/await`, relative imports ending in `.js`, no `any`. Expected errors are `new AppError(status, message)`; the success body is `{ success: true, message, data }` and the error body `{ message }` plus `details` for validation errors, written only by `errorMiddleware`. Source files are `<name>.<layer>.ts` under `src/v1/` (`config`, `routes`, `controllers`, `services`, `validators`, `middlewares`, `types`, `utils`).

Invisible characters are checked by a test, `test/repository/invisibleCharacters.test.ts`, which runs on every `npm test` and fails when a file of the project holds one.

> [!NOTE]
> **Decision:** an invisible-character test runs on every `npm test` (2026-11-26). It scans `src/`, `test/`, `migrations/`, `docs/`, `.claude/skills/` and the files of the project root for U+200B to U+200F, U+2028 to U+202F, U+2060 to U+206F, U+FEFF, U+00AD (soft hyphen), U+180E, U+FE00 to U+FE0F (variation selectors) and U+E0000 to U+E007F (tag characters), and reads UTF-16 files too. Such characters hide in pasted text and change what code or a document says without showing; checking by hand after each edit is not a guarantee, a test is. The test itself writes the ranges as numbers, so it never contains one.

## 5. Foundations (layer 1)

### Container and database

`docker-compose.yml` defines one service, `db`, with user `rag_lab`, database `rag_lab`, a health check with `pg_isready`, and `POSTGRES_PASSWORD` taken from `.env` (the compose file refuses to start without it). The development database is `rag_lab`; the test database `rag_lab_test` is created once by hand.

> [!NOTE]
> **Decision:** the databases are `rag_lab` and `rag_lab_test`, the user is `rag_lab`, and the compose project is `rag-lab` (2026-11-26). RAG Web uses other names for all of them, so a database URL copied from RAG Web fails loudly (wrong user, wrong database) instead of silently reaching the other project's data.

> [!NOTE]
> **Decision:** the database is published on `127.0.0.1:25432`, not on 5433 as first designed (2026-11-26). A native PostgreSQL service on this machine already uses 5433, and 25432 sits below Windows' dynamic port range, so another program cannot take it at random. Only the local address is published.

### Migrations and the wrong-database guard

`migrations/` holds numbered SQL files (`001_init.sql` creates the pgvector extension; layer 1 creates no tables). `npm run migrate` (`src/migrate.ts`) applies the pending ones, each together with its `schema_migrations` record in one transaction, under a PostgreSQL advisory lock so two processes cannot migrate at once. It uses its own pool, without the API's query timeout, because a migration can take longer than any query the API runs and waiting for the lock lasts as long as another process takes to migrate.

`getMigrationStateService` (`schema.service.ts`) compares the files with the `schema_migrations` table and returns four lists: `applied`, `pending` (only in the files), `unknown` (recorded in the database but missing from the files) and `foreignTables` (tables of the public schema when there is no `schema_migrations` table at all). Two of those mean the DATABASE_URL points at the wrong database:

- `unknown` is not empty: the database was made by another checkout or project.
- `foreignTables` is not empty: there are tables but this project's migrations never ran, so they are "another project's".

`npm run migrate` refuses both, and applies nothing, not even the `schema_migrations` table, so the database stays as it was. The server runs the same comparison at startup:

| What the server finds | What it does |
|---|---|
| The database cannot be reached (connection refused, timeout, host unknown, PostgreSQL still starting) | Starts with a warning; `GET /v1/health` reports `down` until it recovers |
| The database answers and refuses (wrong password, missing database) | Stops with the reason; it will not get better by itself |
| Pending migrations, unknown migrations or foreign tables | Stops and says to run `npm run migrate` or to check `DATABASE_URL` |
| Settings that are missing or unsafe (see Configuration) | Stops and lists every problem |

> [!NOTE]
> **Decision:** a wrong-database guard (2026-11-26). `migrate` refuses a database that has migrations this checkout does not have, or that has tables but no `schema_migrations` ("another project's"). The server refuses to start on pending, unknown or foreign state, and starts with a warning only when the database cannot be reached (health then reports `down`); any other database error, such as a wrong password, stops it. Pointing the API at the wrong database is the most expensive configuration mistake (migrations would mix two schemas), while a database that is merely starting is expected and recovers by itself.

### The connection: `pg`

`db.config.ts` exports `createPool`, `pool` and `withTransaction`. `DATABASE_URL` is required; the module throws at import without it. The API's pool has a 5 s connection timeout, TCP keepAlive and a 30 s query timeout; an idle connection that breaks is logged, not fatal. `withTransaction(callback, targetPool?)` runs the callback on one connection in one transaction (the optional pool is how `migrate` uses its own), and a connection that breaks or fails its `ROLLBACK` is discarded instead of going back to the pool.

> [!NOTE]
> **Decision:** timeouts after the audit (2026-11-26). The API pool has a 30 s query timeout and keepAlive; the health probe has a 2 s timeout; `migrate` uses its own pool with no query timeout; shutdown waits at most 6 s for HTTP and 2 s for the pool (`closePoolGracefully`), under Docker's 10 s grace period. Without a query timeout, a connection that is open but no longer answers (a frozen PostgreSQL, a network dropping packets) holds its request forever. `closePoolGracefully` reads pg-pool's private client lists in one commented place (`getCheckedOutClients` in `shutdown.ts`), because the public API cannot list the clients lent out before it is called, and a stuck request is exactly one of those; if those fields ever disappear, it destroys nothing and gives up after one more second, so the process still exits.

### Shutdown

On SIGTERM (`docker stop`) or SIGINT the server stops accepting connections, closes idle ones, lets the requests in progress finish for up to 6 s (then closes what is left), and then closes the pool, waiting up to 2 s before it destroys the connections still lent out. `closePoolGracefully` never rejects, so the process always exits.

### Configuration

`config/` reads the server's own settings, validated at startup. `readIntegerSetting` accepts only plain decimal digits in range (not `1e3`, `0x10`, ` 5 ` or negatives) and throws otherwise, so an out-of-range value stops the app; it is never clamped. `readListSetting` reads comma-separated lists. `getStartupConfigProblems` (checked by `server.ts`) refuses a missing `SECRET_KEY`, the placeholder from `.env.example`, a `SECRET_KEY` under 32 characters, and an `OLLAMA_BASE_URL` that is not an absolute http or https URL. Every variable, default and range is in `.env.example`.

> [!NOTE]
> **Decision:** the operational defaults come from RAG Web (2026-11-26): `PORT` 3000, `HOST` 127.0.0.1, `TRUSTED_PROXIES` loopback, token lifetime 3600 s, 120 protected requests per minute per user, 30 health checks per minute per address and a 10 s health cache. After the audit two maximums were added: token lifetime 1 to 86400 s and health cache 0 to 300 s (a longer cache would show a stale state); integers are plain decimal only; an out-of-range value stops the app and is never clamped.

> [!NOTE]
> **Decision:** `OLLAMA_BASE_URL` must be an absolute http or https URL, and a trailing slash is stripped so a request path never starts with a doubled slash (2026-11-26). The Bearer scheme of the `Authorization` header is case-insensitive (RFC 9110) and anything after the token is rejected, so a malformed header is a 401 instead of being half-read. Model-server redirects are not followed (`redirect: "manual"`): a server that redirects is misconfigured or taken over, and following it would send the request to an address nobody chose.

### Middlewares

Layer 1 carries the whole starting set of the skills' middlewares, so later layers only mount routes:

| Middleware | What it does |
|---|---|
| `securityHeadersMiddleware` | First in `app.ts`: `Cache-Control: no-store`, `nosniff`, a closed `Content-Security-Policy`, `no-referrer`, `X-Frame-Options: DENY` on every response, errors included |
| `authenticateMiddleware` | `Authorization: Bearer <token>`; verifies the HS256 token through `verifyToken` and sets `req.decoded`; 401 when missing or invalid, 500 when `SECRET_KEY` is missing |
| `authorizeMiddleware(roles)` | 401 without `req.decoded`, 403 when the role is not listed |
| `rateLimitMiddleware` | Limits keyed by address (`ip`), email and address (`emailAndIp`) or user (`user`); `RateLimit` headers in the draft-8 form; a 429 goes through `errorMiddleware` |
| per-user limit | In `v1.routes.ts`, right after authentication: one counter per user for every protected route (120 per minute by default), on top of each route's own limits |
| `validateBodyMiddleware` | Joi validation of `req.body`; 400 with `details` |
| `notFoundMiddleware`, `errorMiddleware` | Last in `app.ts`; the only place that writes error responses |

`app.ts` sets `trust proxy` from `TRUSTED_PROXIES` (never `true`), applies `cors` (limited to `CORS_ORIGINS` when set) and has no global body parser: each route that takes a body parses it itself after authentication and the per-user limit, so rejected requests never get their body read.

> [!NOTE]
> **Decision:** layer 1 includes the skills' whole starting set of middlewares (authenticate, authorize, the rate limits and the per-user limit) (2026-11-26), even though no route needs authorization yet. They are tested now against test tokens, so layer 2 adds accounts on top of code that is already proven, and the order of `v1.routes.ts` (public routes, authentication, per-user limit, protected routes) is fixed from the start.

### Health

`GET /v1/health` is public and limited to 30 checks per minute per address. It always answers 200 when the API answers; `data` holds `status`, `database` and `ollama`. The database is `up` when `SELECT 1` answers within 2 s. Ollama is `up` when `GET /api/tags` answers within 2 s and both required models are installed, matched by exact name. `status` is `down` when the database is down, `degraded` when only Ollama is, `ok` otherwise. The two checks run together and the report is cached for 10 s (requests that arrive during a check wait for the same one), so a flood of requests becomes one check every few seconds.

> [!NOTE]
> **Decision:** health requires exactly `qwen3.5:4b` and `qwen3-embedding:0.6b` (2026-11-26). `gpt-oss:20b` joins the list in layer 8, when the router needs it. The public report shows only three states (`ok`, `degraded`, `down`) and the two dependency states, never a model name or an error, so an anonymous caller learns nothing about the machine.

### Model calls

`ollama.service.ts` is the only code that calls the model server. Each call has a timeout (`AbortSignal.timeout`); a connection failure is a `ModelUnavailableError` (503), a timeout is a 504 `AppError`, and a non-OK answer, an answer of an unexpected shape or a redirect is a plain error, because retrying will not fix it. Layer 1 uses it for one call, the list of installed models; token counts arrive with the first answer call in layer 6.

### Tests

`npm test` runs `node:test` through `tsx`, one file at a time against the test database; `npm run test:file -- <file>` runs one file.

- **The test database.** `test/setup.ts` runs before every file. It copies `RAG_LAB_TEST_DATABASE_URL` into `DATABASE_URL`, or deletes `DATABASE_URL` when it is missing (the app then fails with "DATABASE_URL is not set" instead of touching the development database). `test/db/testDatabase.ts` adds a second line of defense: it refuses to empty a database whose name does not end in `_test`.
- **Fixed operational settings.** `test/operationalSettings.ts` sets `HOST`, `PORT`, `TRUSTED_PROXIES`, `CORS_ORIGINS`, the limits, the token lifetime and `OLLAMA_BASE_URL` to the app's defaults before any module loads, and the child processes the tests start get the same values (`test/childEnvironment.ts`). They are set to values, not deleted, because the app loads `.env` itself and would fill a deleted variable in again.
- **Test doubles** live in `test/doubles/`. `fakeOllama.ts` is a real HTTP server on a free port; `OLLAMA_BASE_URL` points at a closed port (`http://127.0.0.1:1`) in every test, so a test that forgets to start it gets "connection refused" and never reaches the real models. `pausableProxy.ts` is a TCP proxy that can go silent (connections stay open, no byte travels), which simulates a frozen database.
- **Repository checks** live in `test/repository/` (the invisible-character test).
- **The `SECRET_KEY` placeholder** is repeated in `test/config/placeholder.ts` and must equal the value in `.env.example`; the app refuses that exact value by name, because it is longer than 32 characters and the length rule would not catch it.

> [!NOTE]
> **Decision:** the test database comes from `RAG_LAB_TEST_DATABASE_URL`, set in `.env` and also as a Windows user environment variable, because worktrees have no `.env` (2026-11-26). `test/setup.ts` copies it into `DATABASE_URL`, or deletes `DATABASE_URL` when it is missing. The tests also get fixed operational settings, so the developer's `.env` cannot change them: a test that passes on one computer because of its `.env` and fails on another proves nothing.

> [!NOTE]
> **Decision:** Ollama is replaced in tests by a shared fake HTTP server (`test/doubles/fakeOllama.ts`), and `OLLAMA_BASE_URL` points at a closed port in tests (2026-11-26). A pausable TCP proxy (`test/doubles/pausableProxy.ts`) simulates a frozen database. A real HTTP server lets the code under test run its real `fetch`, timeout and redirect logic, and the test suite never depends on the models installed on the developer's machine.

## 6. Contract for the frontend

The contract is OpenAPI 3.1 in [api/openapi.yaml](api/openapi.yaml), explained in [api/README.md](api/README.md). It holds `GET /v1/health` and the shared answers every other `/v1` path gets (401, 404, 429).

> [!NOTE]
> **Decision:** the API contract is OpenAPI 3.1 YAML in `docs/api/` (2026-11-26). A machine-readable contract lets the frontend be built (and its client generated or checked) without reading the backend code, and it is frozen in layer 11.

## 7. Findings deferred to later layers

The audits of layer 1 found these; none is exploitable with the layer-1 code, because there are no accounts or documents yet. They are listed so they are not lost.

> [!NOTE]
> **Decision:** these findings wait for the layer that makes them matter (2026-11-26):
>
> - A separate low-privilege database role for the API (layer 2, before users exist). It needs a script that the owner runs; the migrations keep using the owner role.
> - Token revocation, `aud` and `iss` claims, and reading a fresh role from the database instead of trusting the one inside the token (layer 2).
> - A per-address limit before authentication, and a length cap on the email used in rate-limit keys (layer 2).
> - Requiring `CORS_ORIGINS` and `TRUSTED_PROXIES` to be set when the API is exposed (layers 11 and 13).
> - A size cap on model responses (layer 6, when answers are read).
> - Image and model digests (layers 5 and 13).
