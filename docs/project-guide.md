# Project guide

How RAG Lab is built and why. [design.md](design.md) is the source of truth for what the project is and how the agents work; this guide describes the code as it is, section by section, and records each decision taken while building it. The API contract is in [api/](api/). Every decision sits in a box that starts with **Decision:**.

## 1. Origin and goal

RAG Lab is a RAG API built by a team of Claude Code agents: two local models and a router answer questions about uploaded documents, every question is measured (accuracy, latency, tokens), and each signed-in user changes the configuration in a playground to see how precision and token use respond. It reuses the architecture and the evaluated settings of RAG Web (the deployed RAG API) and the evaluation harness of RAG1 (the original command-line app); see design section 1.

The work goes in layers, in the order of [design section 13](design.md#13-build-order). Layer 1, Foundations, is built: the app, the health check, the migrations, the middlewares and the test setup. Layer 2, Accounts and authentication, is built on top of it (section 6): accounts created by an admin, login and logout, tokens that can be revoked, the low-privilege database role of the API and the limits of the account routes. Layer 3, Configuration as data, is built on top of that (section 7): the settings users may change and their caps, the default profile in the database, each user's profiles, and a resolver that gives one complete configuration with a hash. There are no documents or questions yet.

## 2. Stack

| Part | Choice |
|---|---|
| Runtime | Node.js 22.18 or later, ES modules |
| Language | TypeScript, `strict`, `NodeNext`; `tsc` compiles `src/` to `dist/`, `tsx` runs the sources in development |
| Web | Express 5, Joi for validation, `jsonwebtoken` (HS256) for tokens, `cors`, `express-rate-limit` |
| Passwords | scrypt from `node:crypto`; no dependency was added for accounts (section 6) |
| Data | PostgreSQL 17 with pgvector through `pg`; plain parameterized SQL, numbered migrations, no ORM |
| Models | Ollama on the host, always through `ollama.service.ts` |
| Tests | `node:test` with `tsx`, `supertest` for routes |

The database is the `db` service of `docker-compose.yml` (image `pgvector/pgvector:pg17`, project `rag-lab`), published on `127.0.0.1:25432` only. Its data lives in the `pgdata` volume. It has two roles: the owner `rag_lab` and the API's `rag_lab_api` (section 5, "Database roles").

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
> **Decision:** an invisible-character test runs on every `npm test` (2026-11-26). It scans `src/`, `test/`, `migrations/`, `docs/`, `.claude/skills/`, `.claude/metrics/` (added 2026-11-26 with the process metrics, section 10) and the files of the project root for U+200B to U+200F, U+2028 to U+202F, U+2060 to U+206F, U+FEFF, U+00AD (soft hyphen), U+180E, U+FE00 to U+FE0F (variation selectors) and U+E0000 to U+E007F (tag characters), and reads UTF-16 files too. Such characters hide in pasted text and change what code or a document says without showing; checking by hand after each edit is not a guarantee, a test is. The test itself writes the ranges as numbers, so it never contains one.

## 5. Foundations (layer 1)

### Container and database

`docker-compose.yml` defines one service, `db`, with user `rag_lab` (the owner), database `rag_lab`, a health check with `pg_isready`, and `POSTGRES_PASSWORD` (the owner's) taken from `.env` (the compose file refuses to start without it). The development database is `rag_lab`; the test database `rag_lab_test` is created once by hand.

> [!NOTE]
> **Decision:** the databases are `rag_lab` and `rag_lab_test`, the user is `rag_lab`, and the compose project is `rag-lab` (2026-11-26). RAG Web uses other names for all of them, so a database URL copied from RAG Web fails loudly (wrong user, wrong database) instead of silently reaching the other project's data.

> [!NOTE]
> **Decision:** the database is published on `127.0.0.1:25432`, not on 5433 as first designed (2026-11-26). A native PostgreSQL service on this machine already uses 5433, and 25432 sits below Windows' dynamic port range, so another program cannot take it at random. Only the local address is published.

### Migrations and the wrong-database guard

`migrations/` holds numbered SQL files: `001_init.sql` creates the pgvector extension, `002_api_role.sql` gives the API's role its rights and `003_users.sql` creates the `users` table (see "Database roles" below and section 6); `004_default_profile.sql` creates and fills the default profile and `005_profiles.sql` creates the `profiles` table (section 7). `npm run migrate` (`src/migrate.ts`) applies the pending ones, each together with its `schema_migrations` record in one transaction, under a PostgreSQL advisory lock so two processes cannot migrate at once. It connects as the owner with `MIGRATION_DATABASE_URL`, with its own pool (made by `createPool` in `pool.config.ts`), without the API's query timeout, because a migration can take longer than any query the API runs and waiting for the lock lasts as long as another process takes to migrate. It never imports `db.config.ts`, so it does not need `DATABASE_URL`, and neither URL is a fallback for the other.

`getMigrationStateService(targetPool)` (`schema.service.ts`) compares the files with the `schema_migrations` table and returns four lists: `applied`, `pending` (only in the files), `unknown` (recorded in the database but missing from the files) and `foreignTables` (tables of the public schema when there is no `schema_migrations` table at all). The pool is always passed: the server gives the API's, the migration script its own. Two of those mean the URL points at the wrong database:

- `unknown` is not empty: the database was made by another checkout or project.
- `foreignTables` is not empty: there are tables but this project's migrations never ran, so they are "another project's".

`npm run migrate` refuses both, and applies nothing, not even the `schema_migrations` table, so the database stays as it was. The server runs the same comparison at startup:

| What the server finds | What it does |
|---|---|
| The database cannot be reached (connection refused, timeout, host unknown, PostgreSQL still starting or restarting) | Starts with a warning and listens; `GET /v1/health` reports `down`, every other `/v1` route answers 503, and the full check (role and migrations) is repeated every 3 s in the background until it passes |
| The database answers and refuses (wrong password, missing database) | Stops with the reason (exit 1); it will not get better by itself |
| The role of `DATABASE_URL` has more rights than the API needs (see "Database roles") | Stops and lists what the role can do; never prints the URL |
| Pending migrations, unknown migrations or foreign tables | Stops and says to run `npm run migrate` or to check `DATABASE_URL` |
| The default profile is missing, is at another configuration version or is outside the caps, or a stored profile is at another configuration version (section 7, "Startup check") | Stops and lists every problem |
| Settings that are missing or unsafe (see Configuration) | Stops and lists every problem |

> [!NOTE]
> **Decision:** a wrong-database guard (2026-11-26). `migrate` refuses a database that has migrations this checkout does not have, or that has tables but no `schema_migrations` ("another project's"). The server refuses to start on pending, unknown or foreign state, and starts with a warning only when the database cannot be reached (health then reports `down`); any other database error, such as a wrong password, stops it. Pointing the API at the wrong database is the most expensive configuration mistake (migrations would mix two schemas), while a database that is merely starting is expected and recovers by itself.

> [!NOTE]
> **Decision:** layer 2 changes the startup behavior when the database is down (2026-11-26, decided by the orchestrator after the audit, without asking the owner; the owner can reverse it). The server still starts and still reports health as `down`, but it now also repeats the whole check (role and migrations) every 3 s, exits 1 on any problem it finds, and until the check passes every `/v1` route except health answers 503 (`databaseReady.middleware.ts`, `databaseReadiness.service.ts`). Before, a database that came up later was never checked against the role or the migrations, so the first requests would have run against a schema or a role nobody had verified. Unreachable also counts SQLSTATE 57P01, 57P02, 08000, 08003 and 08006 (a PostgreSQL that restarts ends the connection), so a restart is a reason to try again and not to stop.

### The connection: `pg`

`pool.config.ts` exports `createPool({ connectionString, queryTimeoutMs? })` and `runInTransaction(pool, callback)`; it reads no environment variable, so the migration script can use it without `DATABASE_URL`. `db.config.ts` builds the API's `pool` from `DATABASE_URL` (the module throws at import without it) and exports `withTransaction(callback, targetPool?)`. The API's pool has a 5 s connection timeout, TCP keepAlive and a 30 s query timeout; an idle connection that breaks is logged, not fatal. `withTransaction` runs the callback on one connection in one transaction, and a connection that breaks or fails its `ROLLBACK` is discarded instead of going back to the pool.

### Database roles

The API connects as `rag_lab_api`; the owner `rag_lab` creates the schema. The owner creates the role once with `scripts/create-api-role.sql` (`CREATE ROLE ... LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, `REVOKE ALL ON DATABASE` from `PUBLIC`, `GRANT CONNECT`) and sets its password by hand with `\password rag_lab_api`; nothing in the repository holds that password. `migrations/002_api_role.sql` fails naming the script when the role is missing, then revokes `CREATE` on `public` from `PUBLIC`, grants `USAGE` on the schema and `SELECT` on `schema_migrations`, and sets default privileges so the tables and sequences the owner creates afterwards (`users`, and the tables of the next layers) are usable by the API without a new grant. The API role can read and change rows and nothing else: it cannot create, alter, drop or truncate anything, and it cannot change `schema_migrations`. Layer 3 narrows the default privileges where a table needs it: migration 004 revokes `INSERT`, `UPDATE` and `DELETE` on `default_profile` from the role, which leaves it `SELECT` only, and migration 005 revokes `UPDATE` on `profiles` and grants it back on four columns only (`name`, `settings`, `version`, `updated_at`), so the API can never change a profile's owner, id or creation time (section 7).

Before it serves anything, the server asks the database what the role it connected as can do (`databaseRole.service.ts`, by capability and not by name) and stops if the role is a superuser, can create roles or databases, can create objects in the database or in `public`, owns relations in `public`, is a member of another role, or acts as another role than the one that logged in (the `role` connection option, or `SET ROLE`, would hide a login with more rights behind a harmless-looking current role).

> [!NOTE]
> **Decision:** the API runs as a low-privilege role, `rag_lab_api`, and the server stops when `DATABASE_URL` connects as anything with more rights (2026-11-26, the owner's decision, layer 2). A PostgreSQL superuser can run commands on the server, and an owner can drop the tables, so a flaw in any route that reaches the database would reach all of it. The check is by capability, not by name, so it also catches a role someone later gives a right it should not have.

> [!NOTE]
> **Decision:** the role script lives in `scripts/` and was written by the orchestrator (2026-11-26, the owner's decision). No agent role may write `scripts/`, and the auditors do not read it: the orchestrator pastes it into their prompts. Widening their read set is for layer 13 (deployment), when more of the repository is operational files.

> [!NOTE]
> **Decision:** the rights live in migration 002, not in the script (2026-11-26, the owner's decision), so the test and development databases get them again after every reset, and the script only holds what is outside any database (the role itself and its right to connect).

> [!NOTE]
> **Decision:** `npm run migrate` no longer needs `DATABASE_URL` (2026-11-26, decided by the orchestrator after the audit, without asking the owner; the owner can reverse it). The pool code was split into `pool.config.ts` (by the implementer, instead of making the API pool lazy, because the tests import the pool directly) so the migration script uses `MIGRATION_DATABASE_URL` alone and never imports `db.config.ts`, which throws at import without `DATABASE_URL`. Before the split, a shell or a CI job that set only the owner's URL crashed with "DATABASE_URL is not set" instead of migrating; the tests did not show it, because their helper passed the whole environment to the script.

Operational note for layer 13: `ALTER DEFAULT PRIVILEGES` in migration 002 applies only to objects created by the role that ran it, so migrations must always run as the same owner role. The explicit `REVOKE` on `default_profile` and the column grants on `profiles` (layer 3) rely on the same default privileges.

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

Layer 1 carried the whole starting set of the skills' middlewares, and layer 2 completed it with the account check:

| Middleware | What it does |
|---|---|
| `securityHeadersMiddleware` | First in `app.ts`: `Cache-Control: no-store`, `nosniff`, a closed `Content-Security-Policy`, `no-referrer`, `X-Frame-Options: DENY` on every response, errors included |
| per-address floor | In `app.ts`, after `cors` and before everything else: 300 requests per minute per client address, to any path (`REQUESTS_PER_ADDRESS_PER_MINUTE`). `OPTIONS` preflights end in `cors` and are not counted |
| `databaseReadyMiddleware` | In `v1.routes.ts`, after the health router and before everything else: 503 "The database is not available, please try again later" until the startup check has passed (see "Migrations"); health works without the database, because it is what reports it |
| `authenticateMiddleware` | `Authorization: Bearer <token>`; verifies the HS256 token through `verifyToken` (signature, algorithm, `iss`, `aud`, expiry, claim shapes) and sets `req.decoded` (`id`, `tokenVersion`, `expiresAt`); 401 when missing or invalid, 500 when `SECRET_KEY` is missing. Token only: it asks the database nothing |
| `rateLimitMiddleware` | Limits keyed by address (`ip`), email and address (`emailAndIp`) or user (`user`); `RateLimit` headers in the draft-8 form; a 429 goes through `errorMiddleware` |
| per-user limit | In `v1.routes.ts`, right after authentication and before the database is asked: one counter per user and token version for every protected route (120 per minute by default), on top of each route's own limits |
| `currentUserMiddleware` | After the per-user limit: one query per request reads the account's role, status and token version; 401 "Invalid or expired authentication token" when the account does not exist, is disabled, or the token's version is not the current one; sets `req.user` (`id`, `role`, `expiresAt`) |
| `authorizeMiddleware(roles)` | 401 without `req.user`, 403 when `req.user.role` is not listed. The role is the database's, from this request |
| `validateBodyMiddleware` | Joi validation of `req.body`; 400 with `details` |
| `notFoundMiddleware`, `errorMiddleware` | Last in `app.ts`; the only place that writes error responses. `errorMiddleware` also answers 503 (and not 500) for a database that cannot be reached during a request |

`app.ts` sets `trust proxy` from `TRUSTED_PROXIES` (never `true`), applies `cors` (limited to `CORS_ORIGINS` when set), the per-address floor, and has no global body parser: each route that takes a body parses it itself after authentication and the per-user limit, so rejected requests never get their body read.

The order in `v1.routes.ts` is: health (public, no database needed) → readiness gate → public routes (login) → `authenticateMiddleware` → per-user limit → `currentUserMiddleware` → protected routes.

> [!NOTE]
> **Decision:** layer 1 included the skills' whole starting set of middlewares (authenticate, authorize, the rate limits and the per-user limit) (2026-11-26), even though no route needed authorization yet. They were tested against test tokens, so layer 2 adds accounts on top of code that was already proven, and the order of `v1.routes.ts` (public routes, authentication, per-user limit, protected routes) was fixed from the start. Layer 2 added two steps to it, the readiness gate and `currentUserMiddleware`, without changing that order.

### Health

`GET /v1/health` is public and limited to 30 checks per minute per address. It always answers 200 when the API answers; `data` holds `status`, `database` and `ollama`. The database is `up` when `SELECT 1` answers within 2 s. Ollama is `up` when `GET /api/tags` answers within 2 s and both required models are installed, matched by exact name. `status` is `down` when the database is down, `degraded` when only Ollama is, `ok` otherwise. The two checks run together and the report is cached for 10 s (requests that arrive during a check wait for the same one), so a flood of requests becomes one check every few seconds.

> [!NOTE]
> **Decision:** health requires exactly `qwen3.5:4b` and `qwen3-embedding:0.6b` (2026-11-26). `gpt-oss:20b` joins the list in layer 8, when the router needs it. The public report shows only three states (`ok`, `degraded`, `down`) and the two dependency states, never a model name or an error, so an anonymous caller learns nothing about the machine.

### Model calls

`ollama.service.ts` is the only code that calls the model server. Each call has a timeout (`AbortSignal.timeout`); a connection failure is a `ModelUnavailableError` (503), a timeout is a 504 `AppError`, and a non-OK answer, an answer of an unexpected shape or a redirect is a plain error, because retrying will not fix it. Layer 1 uses it for one call, the list of installed models; token counts arrive with the first answer call in layer 6.

### Tests

`npm test` runs `node:test` through `tsx`, one file at a time against the test database; `npm run test:file -- <file>` runs one file.

- **The test database.** `test/setup.ts` runs before every file. It copies `RAG_LAB_TEST_API_DATABASE_URL` (the role `rag_lab_api`) into `DATABASE_URL` and `RAG_LAB_TEST_DATABASE_URL` (the owner `rag_lab`) into `MIGRATION_DATABASE_URL`, and deletes the target when its source is missing (the app then fails with "DATABASE_URL is not set" instead of touching the development database). `test/db/testDatabase.ts` adds a second line of defense: it refuses to empty a database whose name does not end in `_test`.
- **The owner-pool rule.** The app runs as the API role in the tests, as in production. Everything that changes or inspects the schema goes through an owner pool (`ownerPool` in `testDatabase.ts`): resetting the database, running the migration script, reading `pg_tables` or `to_regclass`. An inspection through the API pool can pass while checking nothing, because the role cannot see a table it has no rights on.
- **Fixed operational settings.** `test/operationalSettings.ts` sets `HOST`, `PORT`, `TRUSTED_PROXIES`, `CORS_ORIGINS`, the limits (the five of layer 2 included), the token lifetime and `OLLAMA_BASE_URL` to the app's defaults before any module loads, and the child processes the tests start get the same values (`test/childEnvironment.ts`). They are set to values, not deleted, because the app loads `.env` itself and would fill a deleted variable in again.
- **Test doubles** live in `test/doubles/`. `fakeOllama.ts` is a real HTTP server on a free port; `OLLAMA_BASE_URL` points at a closed port (`http://127.0.0.1:1`) in every test, so a test that forgets to start it gets "connection refused" and never reaches the real models. `pausableProxy.ts` is a TCP proxy that can go silent (connections stay open, no byte travels), which simulates a frozen database.
- **Repository checks** live in `test/repository/` (the invisible-character test).
- **The `SECRET_KEY` placeholder** is repeated in `test/config/placeholder.ts` and must equal the value in `.env.example`; the app refuses that exact value by name, because it is longer than 32 characters and the length rule would not catch it.

> [!NOTE]
> **Decision:** the test database comes from `RAG_LAB_TEST_DATABASE_URL`, set in `.env` and also as a Windows user environment variable, because worktrees have no `.env` (2026-11-26). `test/setup.ts` copies it into `DATABASE_URL`, or deletes `DATABASE_URL` when it is missing. The tests also get fixed operational settings, so the developer's `.env` cannot change them: a test that passes on one computer because of its `.env` and fails on another proves nothing. Layer 2 changed the mapping (next decision).

> [!NOTE]
> **Decision:** the test suite runs the app as the API role (2026-11-26, the owner's decision, layer 2). `RAG_LAB_TEST_API_DATABASE_URL` goes into `DATABASE_URL` and `RAG_LAB_TEST_DATABASE_URL` (the owner) into `MIGRATION_DATABASE_URL`; both are set in `.env` and as Windows user environment variables. Tests that ran as the owner would pass with rights the API does not have in production (a missing grant would show up only there), so the app is exercised with the rights it really has, and the schema work goes through an owner pool.

> [!NOTE]
> **Decision:** Ollama is replaced in tests by a shared fake HTTP server (`test/doubles/fakeOllama.ts`), and `OLLAMA_BASE_URL` points at a closed port in tests (2026-11-26). A pausable TCP proxy (`test/doubles/pausableProxy.ts`) simulates a frozen database. A real HTTP server lets the code under test run its real `fetch`, timeout and redirect logic, and the test suite never depends on the models installed on the developer's machine.

## 6. Accounts and authentication (layer 2)

Accounts, login, logout, tokens that can be revoked, and the limits that protect them. The routes follow the layered pattern (`auth.routes.ts`, `users.routes.ts`, their controllers, `auth.service.ts` and `users.service.ts`, `auth.validator.ts` and `users.validator.ts`); the exact bodies, messages and status codes are in the [API contract](api/openapi.yaml).

### Endpoints

| Method and path | Access | What it does |
|---|---|---|
| `POST /v1/auth/login` | Public | Checks email and password; returns the user and a token |
| `POST /v1/auth/logout` | Token | Ends every session of the account |
| `GET /v1/users/me` | Token | The signed-in user |
| `PATCH /v1/users/me/password` | Token | Changes the password; returns a new token |
| `POST /v1/users` | Admin | Creates an account (role `user` unless the request says `admin`) |
| `PATCH /v1/users/:id` | Admin | Changes another account's role or status |

### Accounts

The `users` table (migration `003_users.sql`) holds `id` (UUID), `email`, `password_hash`, `role` (`user` or `admin`), `status` (`active` or `disabled`), `token_version` and `created_at`. There is a unique index on `lower(email)`, so an email is one account whatever its capitalization, and a `CHECK` keeps it within 254 characters. Emails are trimmed, lowercased and normalized to Unicode NFC by the validator before they are checked and stored, and the same rule (`emailRule`) is used by login, by account creation and by `create-admin`. The API never returns the hash or the token version (`User` type: `id`, `email`, `role`, `status`, `createdAt`).

There is no self-registration. The first admin comes from `npm run create-admin -- <email>` (`src/createAdmin.ts`): it connects with `DATABASE_URL` like the server, creates an `admin` account with a random 24-character password (18 random bytes in base64url, 144 bits) and prints it once; only its hash is stored. An existing email stops it without printing a password. The admin then creates the other accounts with `POST /v1/users`, and changes their role or status with `PATCH /v1/users/:id`.

`updateUserService` locks the actor's and the target's rows in id order in one transaction (`SELECT ... FOR UPDATE`) and checks again that the actor is still an active admin, before making the change. The route's permission check ran earlier, and two admins who change each other at the same moment would both pass it and could leave no admin at all; the second call now waits for the first one's commit and sees the actor as it is. An admin cannot change their own role or status (409, compared case-insensitively), and a role change needs no token bump because the role is read from the database on every request. Disabling an account raises its token version, so the old tokens stay dead if the account is enabled again.

### Tokens and revocation

Tokens are HS256 JWTs (`token.util.ts`, the only place that signs or verifies them) with the claims `sub` (the user's id), `ver` (the account's `token_version`), `iss` (`rag-lab`), `aud` (`rag-lab-api`), `iat` and `exp` (3600 s by default, at most 86400). There is no role in the token and no refresh token. `verifyToken` pins the algorithm, the issuer and the audience, and rejects a correctly signed token whose claims have another shape, so a token of RAG Web (same algorithm, no issuer or audience) or of the earlier design is a 401.

Revocation works by `token_version`. A token is good only while its `ver` equals the account's current `token_version`:

- logout raises it, so every token of the account stops working, on every device (a sessions table can come later, if one device's logout must not end the others);
- a password change raises it and returns a new token for the session that asked;
- disabling the account raises it.

The check is in `currentUserMiddleware` (`getActiveUserService`), one query per request that reads `role`, `status` and `token_version` and answers 401 "Invalid or expired authentication token" for a missing account, a disabled one or a version that is not current. It is the same message as for a forged token, so the client cannot tell the reasons apart. The same query gives the role, so a promotion, a demotion or a disabled account applies on the next request with the same token. Measured cost of that lookup: median 1.45 ms, p95 1.9 ms (500 calls against the Docker test database over loopback, one at a time; a floor, not a prediction under load).

`authenticateMiddleware` is token-only (`req.decoded`: `id`, `tokenVersion`, `expiresAt`); `currentUserMiddleware` sets `req.user` (`id`, `role`, `expiresAt`); `authorizeMiddleware` and `requireUserId` read `req.user`, so a request that was only authenticated and not checked against the account never counts as a signed-in user.

### Passwords

Passwords are hashed with scrypt from `node:crypto` (`password.util.ts`): N = 16384, r = 8, p = 5, 16 MiB per hash, a random 16-byte salt and a 64-byte key, stored as `scrypt$N$r$p$salt$hash`. The password is normalized to Unicode NFKC before hashing, so the same visible password typed on different keyboards is one password. Comparison uses `timingSafeEqual`. The parameters are stored with each hash, so raising them later keeps old passwords valid, and a successful login replaces a hash made with other parameters (a rehash).

New passwords have 8 to 64 characters and are not trimmed (spaces count). Login and the current password of a change have no minimum, only the maximum of 64, so an account made under an older rule can still log in. Hash parameters read from the database outside fixed ranges, hex that is not hex, or a value of another shape are a password that does not match, never an error or a huge allocation.

Login takes about as long whether or not the email exists: an unknown email, and a failure against an old or unusable stored hash, also run a dummy hash (computed on first use and cached). A wrong password and an unknown email give the same 401 "Invalid email or password". A disabled account gets 403 "This account is disabled" only after a correct password, so the answer does not reveal which accounts exist or are disabled. A wrong current password in a password change is a 400, not a 401, which the client would mistake for an expired session. A password change and a login rehash apply only while the stored hash is still the one that was checked: if another request changed it in between, the answer is 409 "The password was changed by another request, please try again" and nothing is overwritten.

### Limits

All counters are in memory (they reset when the API restarts, which is fine for one process). Defaults are in `limits.config.ts`; each can be changed in `.env` (see `.env.example`).

| Limit | Default | Key | What counts | Where |
|---|---|---|---|---|
| Every request | 300 per minute | address | every request to any path, forged tokens and unknown paths included; `OPTIONS` preflights are not counted | `app.ts`, before authentication (`REQUESTS_PER_ADDRESS_PER_MINUTE`) |
| Logins | 10 per 15 minutes | address | every login, successful ones too (each costs a hash); counted before the body is read | login route (`LOGINS_PER_15_MINUTES`) |
| Failed logins | 5 per 15 minutes | email and address | only responses with an error (`FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES`) | login route, after the body is parsed |
| Protected requests | 120 per minute | user and token version | every protected request | `v1.routes.ts`, before the database is asked (`AUTHENTICATED_REQUESTS_PER_MINUTE`) |
| Password changes | 5 per 15 minutes | user and token version | every attempt, the wrong ones too, before the body is read | `PASSWORD_CHANGES_PER_15_MINUTES` |
| Account creations | 20 per hour | admin and token version | every attempt after the permission check, failed ones too, before the body is read | `USER_CREATIONS_PER_HOUR` |

The failed-login key is `email:<email>|<address>`, so guessing one account from one address is stopped without letting someone else lock the owner out from another address; the email is normalized like the validator does (NFC, trimmed, lowercased). An email longer than 254 characters, or a value that is not text, is not part of the key: the address alone counts it, so a flood of huge emails cannot fill the counters. The per-user key is `user:<id>:v<version>`: a revoked token still reaches that limit (the account is only checked afterwards), and with the version in the key whoever holds an old token cannot use up the counter of the account's current session.

### Decisions

> [!NOTE]
> **Decision:** accounts are created only by an admin; there is no self-registration (2026-11-26, the owner's decision). The hosting is undecided and consumption caps arrive in layer 10, so open sign-up would let anyone use the models.

> [!NOTE]
> **Decision:** the first admin comes from a script the owner runs, `npm run create-admin -- <email>`, with a generated password printed once (2026-11-26, the owner's decision). "The first account that registers becomes the admin" was ruled out: whoever reaches an empty database first would own it.

> [!NOTE]
> **Decision:** the admin endpoints are: create an account, and change the role or status of other accounts, never their own (2026-11-26, the owner's decision). An admin who locks themselves out or demotes themselves by mistake could not undo it; another admin can.

> [!NOTE]
> **Decision:** tokens are revoked by `token_version`, and logout ends every session of the account (2026-11-26, the owner's decision). It needs one counter in the `users` row and no new table; a sessions table, with one row per login, can come later if a device's logout must not end the others.

> [!NOTE]
> **Decision:** the order of a protected request is: token (no database) → per-user limit → database check (2026-11-26, the owner's decision). A flood from one valid token is limited before it reaches the database, and a user over the limit costs the database nothing.

> [!NOTE]
> **Decision:** a disabled account gets 403 only after a correct password, and a wrong current password in a password change is a 400 (2026-11-26, the owner's decision). The 403 would otherwise tell anyone which emails exist and are disabled; a 401 for a wrong current password would look like an expired session and send the user to the login screen.

> [!NOTE]
> **Decision:** one limit per address of 300 requests per minute sits in front of every request, in `app.ts` (2026-11-26, the owner's decision: fine as long as there are no hardware problems). Forged tokens, unknown paths and login attempts from one address are answered with a 429 before the token is checked or the database is asked.

> [!NOTE]
> **Decision:** the other limits take RAG Web's defaults (2026-11-26, the owner's decision): 10 logins per address and 5 failed logins per email and address per 15 minutes, 5 password changes per user per 15 minutes, and 20 account creations per admin per hour. There is no global cap on logins for now.

> [!NOTE]
> **Decision:** passwords have 8 to 64 characters (2026-11-26, the owner's decision). The owner chose 8, as in RAG Web, over the 15 that NIST SP 800-63B-4 asks for single-factor passwords; the maximum of 64 keeps a request from making scrypt hash a huge string.

> [!NOTE]
> **Decision:** passwords are hashed with scrypt from `node:crypto`, with no new dependency (2026-11-26, the owner's decision). bcrypt silently cuts passwords at 72 bytes, and argon2 would be a native dependency to build on every machine and in the container.

> [!NOTE]
> **Decision:** the token carries `sub` and `ver`, with `iss` and `aud` as constants, lasts 3600 s, has no refresh token and has no role (2026-11-26, the owner's decision). The role is read from the database on every request, so a promotion or a demotion applies at once, and a leaked token cannot keep an admin's rights after a demotion.

> [!NOTE]
> **Decision:** logout is `POST /v1/auth/logout` (2026-11-26, the owner's decision), a protected route mounted after `currentUserMiddleware`, so a token that was already revoked is a 401 and does not raise the version again.

> [!NOTE]
> **Decision:** a database that cannot be reached is a 503 on every route (2026-11-26, the owner's decision), during a request as well as at startup (SQLSTATE 57P01, 57P02 and 08xxx included, such as a PostgreSQL restart). The client is told to try again later and nothing about the connection leaves the server.

> [!NOTE]
> **Decision:** the audit of layer 2 led to these changes, decided by the orchestrator and the implementer without asking the owner; the owner can reverse any of them (2026-11-26). After the audit: the readiness gate and the background retry when the database is down at startup (see "Migrations"); the per-user limit keyed per token version; account creations counted on every attempt after authorization and not only on successes; `updateUserService` locks and re-checks the actor; `migrate` no longer needs `DATABASE_URL`; 57P01, 57P02, 08000, 08003 and 08006 count as unreachable; the role check also refuses a session that acts as another role, a role that is a member of another role and `CREATE` on the database; and the dummy hash also runs after failures against old or unusable stored hashes. In the first implementation round: a password change or a rehash applies only if the stored hash is still the one that was checked (a concurrent change gets 409); stored hash parameters outside fixed ranges are refused without throwing; and the dummy hash is computed on first use and cached. The worktree's `node_modules` is a junction to the main checkout's (the orchestrator, local only).

## 7. Configuration as data (layer 3)

The settings a user may change, the caps on their values, the default profile, each user's own profiles, and the resolver that turns them into one complete configuration with a hash. Nothing calls a model yet: the configuration is what layers 4 to 6 will read. The routes follow the layered pattern (`configuration.routes.ts`, `profiles.routes.ts`, their controllers, `configuration.service.ts` and `profiles.service.ts`, `configuration.validator.ts` and `profiles.validator.ts`); the exact bodies, messages and status codes are in the [API contract](api/openapi.yaml). The design is in [design section 4](design.md#4-configuration-as-data).

### Endpoints

All are protected (a token) and counted in the per-user limit.

| Method and path | What it does |
|---|---|
| `GET /v1/configuration` | The configuration version, the definition of each setting (type, allowed values or range, whether it is index time or question time), the defaults the database holds right now, and the limits on profiles (`maxPerUser`, `maxNameLength`) |
| `POST /v1/configuration/resolve` | Body `{ profileId?, overrides? }`, both optional: the complete configuration a question would run with, `{ profileId, snapshot, hash }`. A dry run: it calls no model and writes nothing |
| `GET /v1/profiles` | The caller's profiles, oldest first |
| `POST /v1/profiles` | Body `{ name, settings? }`; `201` |
| `GET /v1/profiles/:id` | One of the caller's profiles |
| `PATCH /v1/profiles/:id` | Body with `name` and/or `settings`, at least one; the settings sent replace the stored object as a whole (`{}` goes back to the default) |
| `DELETE /v1/profiles/:id` | Deletes the profile (also one saved by another configuration version) |

A profile is `{ id, name, settings, problems, createdAt, updatedAt }`. `settings` holds only what the user set. `problems` lists what is wrong with the stored settings today (a value outside a cap, a setting this version does not have); it is empty for a profile made through the API, which checks the settings first. The owner's id and the version are never returned. Another user's profile, an id that is not a UUID and an id that does not exist are the same 404 "Profile not found", also for an admin.

### Version 1 of the settings

`config/configuration.config.ts` defines version 1: `CONFIGURATION_VERSION`, the eleven keys, and their caps. The defaults are data, in the row of `default_profile` (migration 004). `chunkSize` is measured in characters (RAG Web's `CHUNK_MAX_CHARS`). Sources of the defaults: RAG Web's `rag.config.ts`, `ollama.config.ts`, `fragments.util.ts` and `prompts.util.ts`.

| Setting | Kind | Default | Cap |
|---|---|---|---|
| `chunkSize` | index | 1000 | 300, 500, 750, 1000, 2000 or 5000 |
| `embeddingModel` | index | `qwen3-embedding:0.6b` | that model only |
| `retrievalMode` | question | `vector` | `vector` only |
| `topK` | question | 3 | whole number, 1 to 30 |
| `minScore` | question | 0.3 | 0 to 1, at most 2 decimals |
| `neighborWindow` | question | 1 | 1 or 2 |
| `smallModel` | question | `qwen3.5:4b` | that model only |
| `temperature` | question | 0 | 0 to 1, at most 2 decimals |
| `maxTokens` | question | 1024 | whole number, 1 to 1024 |
| `answerLanguage` | question | `en` | `en` or `es` |
| `answerMode` | question | `baseline` | `baseline` or `structured` |

`kind` says whether a change needs the documents indexed again (`index`) or only a new question (`question`). Not settings, so no user can change them: `num_ctx` 8192, `seed` 42, `think: false`, the prompt texts, `format: "json"` and the 1024 embedding dimensions.

### Tables

- `default_profile` (migration 004): one row, `singleton` (always true, the primary key, so a second row is impossible), `version`, `settings jsonb` (an object) and `updated_at`. Seeded with the defaults above. The API role has `SELECT` only.
- `profiles` (migration 005): `id` (UUID), `user_id` (foreign key to `users`, `ON DELETE CASCADE`), `name` (1 to 100 characters), `version`, `settings jsonb` (an object, `{}` by default), `created_at`, `updated_at`. A unique index on `(user_id, lower(name))` makes a name one profile per user, whatever its capitalization. `version` has no default: the app writes it. The API role may `UPDATE` only `name`, `settings`, `version` and `updated_at`.

Migration 005 was never on `main`, so a development database has nothing to re-migrate; after the merge the owner runs `npm run migrate`.

### Resolution

`resolveConfigurationService` builds the configuration key by key, for each of the eleven settings: the override if there is one, else the stored profile's value, else the default's. Keys are read as own properties (`Object.hasOwn`) and copied one by one into a new object, never spread or deep-merged, so a key such as `__proto__` is not a way to reach the result. The merged object is checked against the caps (the same schema as for writing: `completeSettingsSchema`), so a value is never clamped and the snapshot always matches what ran.

| Situation | Answer |
|---|---|
| `profileId` is not a UUID | 400 "Validation error" ("Profile id must be a valid UUID") |
| The profile does not exist or is another user's | 404 "Profile not found" |
| A stored profile or the overrides are outside the caps, or hold a key that is not a setting | 400 "The configuration is not valid", with every problem in `details` |
| The caller's profile was saved by another configuration version | 500 "Internal server error" (this code cannot read it) |
| The default profile in the database is not valid (it changed while the server ran) | 500 "Internal server error"; the problems are logged, never sent |

The default is checked on its own first, so its problems are never mixed with the caller's, and a broken default is never shown to a user as their 400. The `profileId` in the answer is the id in lower case, or `null` when none was asked for.

### The snapshot and its hash

The snapshot is `{ version, settings }` with all eleven settings, frozen. Its canonical text (`toCanonicalJson` in `configurationSnapshot.util.ts`) is JSON with the keys sorted at every level and no spaces; only what JSON can hold is accepted (`undefined`, a function, `NaN`, an infinity and an array with holes are errors, because a snapshot that lost a value would hash like one that never had it). The hash is the SHA-256 of that text as UTF-8, in lowercase hexadecimal. The profile id and the timestamps are not part of it. The resolver's answer to a client leaves out the canonical text: the snapshot and the hash are what it needs.

### Startup check

After the schema check, `getConfigurationProblemsService` (called from `server.ts`) reads the database. The server stops, listing every problem, when the default profile row is missing, is at another configuration version or is outside the caps (all eleven settings present, each inside its cap, nothing else), or when any stored profile is at another configuration version. A profile whose settings are outside today's caps is not a startup problem: it is shown with its `problems` and refused when it is resolved. The check does not verify that `rag_lab_api` still has only `SELECT` on `default_profile`.

### Profile names

The validator (`profiles.validator.ts`) stores the name in Unicode form NFC, with every space of category `Zs` turned into a plain space and the ends trimmed, so two spellings of the same text are one name. It refuses control, format, surrogate and line or paragraph separator characters, and the characters that draw nothing without being any of those (U+3164, U+115F, U+1160, U+FFA0, U+034F, U+2800). The name must hold a letter, number, symbol or punctuation. Because the zero-width joiner is a format character, joined emoji sequences are refused; a variation selector after an emoji is accepted. Joi counts UTF-16 units, so a name of emoji may be refused a little before 100 characters, never accepted past it.

### Limits

| Limit | Default | Where |
|---|---|---|
| Profiles per user | 20 (1 to 1000) | `MAX_PROFILES_PER_USER` in `limits.config.ts`; counted inside a transaction that locks the user's row, so two creations that arrive together are counted one after the other; the 21st is a 409 "You have reached the maximum number of profiles" |
| Request body | 16 kB | `CONFIGURATION_BODY_LIMIT`, on the POST and PATCH routes of these two routers only; over it is a 413 "request entity too large", before the body is parsed |
| Writes | no extra limit | the per-user limit of 120 requests per minute applies |

The 409 answers of a profile are: "A profile with that name already exists", "You have reached the maximum number of profiles" (creation) and "This profile was saved by another configuration version" (PATCH; reading and deleting still work).

### Decisions

> [!NOTE]
> **Decision:** the owner approved the plan of layer 3 with every recommendation of the planner (2026-11-27). The decisions below are the plan's.

> [!NOTE]
> **Decision:** version 1 holds only the settings whose shape and default are known, the eleven keys above (2026-11-27, the owner's decision). An enumeration the design already names widens in code without a version bump (`retrievalMode` will gain `vector_query_instruction` and `hybrid`). Settings of unknown shape (the big model, the router policy and thresholds, the gpt-oss thinking level, reranking, the hybrid weights, the chunking strategy, contextual headers) arrive with their layer and a version bump. A setting is never accepted and ignored: a client that sends a key this version does not have gets a 400. `num_ctx` 8192, `seed` 42, `think: false`, the prompt texts, `format: "json"` and the 1024 embedding dimensions are not settings.

> [!NOTE]
> **Decision:** `answerMode` (baseline or structured) is a setting, default `baseline` (2026-11-27, the owner's decision). In RAG Web's runs baseline scored 75/100 and structured 72/100. It is added to the table of design section 4.

> [!NOTE]
> **Decision:** keys are flat camelCase, and `kind` (`index` or `question`) is metadata of the definition (2026-11-27, the owner's decision).
> [!NOTE]
> **Decision:** profiles are sparse and carry a `version` (2026-11-27, the owner's decision). A profile stores only the keys the user set; a missing key takes the default. Upgrade rules: adding a key bumps the version, and a migration adds the key to the default row and moves the versions; widening a cap is code only; renaming or removing a key, or changing its type or unit, bumps the version and needs a data migration. The trade-off: an approved change to the default reaches every profile that did not set that key, while snapshots keep the history exact.

> [!NOTE]
> **Decision:** the default profile is a single-row table, `default_profile`, seeded by migration 004 (2026-11-27, the owner's decision). The API role has `SELECT` only, through an explicit `REVOKE` after the default privileges of migration 002; only a new migration changes it, and there is no admin endpoint.
> [!NOTE]
> **Decision:** the default chunk size is 1000 (2026-11-27, the owner's decision). It is RAG Web's value, and RAG1's 100-question run with it scored 75/100. 500 scored better in one RAG1 run, but experiment E1 decides. Changing a default is an approval gate and goes through the experiment loop.

> [!NOTE]
> **Decision:** value caps (what may run) are constants in `configuration.config.ts`; consumption caps (how much) are in `limits.config.ts` and `.env` (2026-11-27, the owner's decision). The caps are the table above. `maxTokens` 1024 is RAG Web's guard against runaway answers, not a value RAG1 evaluated. Spanish prompts have not been evaluated (experiment E2), so `answerLanguage` `es` is allowed but unproven. A cap changes with a new version and a migration, not in `.env`.

> [!NOTE]
> **Decision:** a stored profile outside today's caps is refused when it is used, with a 400 "The configuration is not valid" and its problems, and is shown in `problems` on every read (2026-11-27, the owner's decision). It is never clamped and never silently replaced, so the snapshot of a question is what ran and the user sees why a profile no longer works.

> [!NOTE]
> **Decision:** at most 20 profiles per user (`MAX_PROFILES_PER_USER`, range 1 to 1000; the owner set the maximum of 1000 after the audit), counted under a lock on the user's row, so the 21st is a 409 (2026-11-27, the owner's decision). Names have 1 to 100 characters and are unique per user whatever their capitalization. The body limit on these routes is 16 kB. There is no extra write limit: the general per-user limit applies.

> [!NOTE]
> **Decision:** a PATCH with `settings` replaces the stored object (2026-11-27, the owner's decision). `{}` goes back to the default.
> [!NOTE]
> **Decision:** `POST /v1/configuration/resolve` is a dry run that calls no model (2026-11-27, the owner's decision). A frontend can show what a question would run with, and the hash, before layers 4 to 6 exist.

> [!NOTE]
> **Decision:** layer 3 has no snapshot table (2026-11-27, the owner's decision). Layer 5's runs table stores `configuration jsonb`, `configuration_hash text` (indexed) and `profile_id` (nullable, `ON DELETE SET NULL`), so a deleted profile leaves its runs. A note for layer 5: the API role could be insert-only on the runs table.

> [!NOTE]
> **Decision:** the hash is the SHA-256, in hexadecimal, of the canonical JSON of `{ version, settings }` (2026-11-27, the owner's decision): keys sorted at every level, no spaces, UTF-8. `profileId` and the timestamps are outside it, so identical settings from two profiles or two users are one configuration. The hash is an identifier, not a security control. Layer 6 adds a `fixed` section (`num_ctx`, `seed`, `think`, the prompt id) with a version bump, and layers 5 and 13 add the model digests.

> [!NOTE]
> **Decision:** the playground caps of design section 12 are partly decided (2026-11-27, the owner's decision). The value caps are in code. Interim request caps arrive with the first layer that calls a model (5 for question embeddings, 6 for answers), taking RAG Web's values: 10 questions per minute, 30 per day, 1 at a time per user, 60 s per question and 20 waiting. Layer 10 adds per-user token budgets per day. Still open, needing the owner or measurements: the token budgets (after layer 9), a cap on indexes per document or indexing jobs per user (layer 4), and an exemption or higher caps for the harness account (layer 10).

> [!NOTE]
> **Decision:** admins have no powers over other users' profiles (2026-11-27, the owner's decision). An admin gets the same 404 as anyone else for a profile that is not theirs, and there is no admin route to profiles.

> [!NOTE]
> **Decision:** the audit of layer 3 led to a second round of fixes, and the owner approved the list (2026-11-27). The resolver's `profileId` follows the same UUID rule as `isUuid` (any version, hyphenated only); `MAX_PROFILES_PER_USER` has a maximum of 1000; a profile at another configuration version is a 409 on PATCH and a 500 on resolve, and `version` is written only when the settings are replaced (a rename keeps it); a default profile that breaks while the server runs is logged and answered as a 500 with the generic message, not as the user's 400; profile names also refuse U+3164, U+115F, U+1160, U+FFA0, U+034F and U+2800, turn every `Zs` space into U+0020 and must hold a letter, number, symbol or punctuation; joined emoji sequences are refused (the trade-off of refusing format characters) and a variation selector is accepted; the API role may `UPDATE` only four columns of `profiles` (migration 005), so it can never change the owner; an unknown setting key is echoed cut to 64 characters plus an ellipsis; a `__proto__` key no longer hides the other problems; and `toCanonicalJson` refuses arrays with holes. One audit claim was refuted: that the row lock on profile creation blocked other work.

> [!NOTE]
> **Decision:** these were taken without asking the owner, and the owner can reverse any of them (2026-11-27). The orchestrator fixed `test/db/users.test.ts` (`TRUNCATE users CASCADE`), which the new foreign key broke, and worded two messages: the 409 "This profile was saved by another configuration version" and the validator's "Name must contain a letter, number, symbol or punctuation". The implementer: used a Joi extension with a `prepare` hook to see an own `__proto__` key before Joi's copy drops it (the key is renamed to an internal stand-in so the rest is still validated, and the real name is restored in the error); answers 404 "User not found" when a profile is created for a user row that vanished; uses the singular in the startup message for one profile; limits names in UTF-16 units through Joi (a name of emoji can be refused slightly before the table's 100 characters, never accepted past it); counts the 64-character cut of an echoed key in code points; makes the resolver also report unknown override keys; and logs a broken default twice per request (once by the resolver and once by `errorMiddleware`).

## 8. Contract for the frontend

The contract is OpenAPI 3.1 in [api/openapi.yaml](api/openapi.yaml) (version 0.3.0), explained in [api/README.md](api/README.md). It holds `GET /v1/health`, the six account endpoints of section 6, the seven configuration and profile endpoints of section 7, the schemas they use, and the shared answers every other `/v1` path gets (401, 403, 404, 429, 503).

> [!NOTE]
> **Decision:** the API contract is OpenAPI 3.1 YAML in `docs/api/` (2026-11-26). A machine-readable contract lets the frontend be built (and its client generated or checked) without reading the backend code, and it is frozen in layer 11.

## 9. Findings deferred to later layers

The audits of layer 1 found these; none was exploitable with the layer-1 code, because there were no accounts or documents yet. They are listed so they are not lost. The three that belonged to layer 2 are done.

> [!NOTE]
> **Decision:** these findings wait for the layer that makes them matter (2026-11-26):
>
> - ~~A separate low-privilege database role for the API (layer 2, before users exist).~~ Done in layer 2 (section 5, "Database roles").
> - ~~Token revocation, `aud` and `iss` claims, and reading a fresh role from the database instead of trusting the one inside the token (layer 2).~~ Done in layer 2 (section 6, "Tokens and revocation").
> - ~~A per-address limit before authentication, and a length cap on the email used in rate-limit keys (layer 2).~~ Done in layer 2 (section 6, "Limits").
> - Requiring `CORS_ORIGINS` and `TRUSTED_PROXIES` to be set when the API is exposed (layers 11 and 13).
> - A size cap on model responses (layer 6, when answers are read).
> - Image and model digests (layers 5 and 13).

The audits of layer 2 found these, which wait too:

> [!NOTE]
> **Decision:** these findings from the audit of layer 2 wait for the layer that makes them matter (2026-11-26):
>
> - A limit per account on failed logins across addresses (a slowdown or an alert, not a lockout, which would let anyone lock the owner out), and a cap on scrypt jobs running at once (layer 10 or 13).
> - A check of new passwords against a list of breached passwords. It needs a list download, so it needs the owner's approval.
> - `ALTER DEFAULT PRIVILEGES` in migration 002 applies only to objects created by the role that ran it, so migrations must always run as the same owner role (an operations note, layer 13). Layer 3 touched it: the explicit `REVOKE` on `default_profile` and the column grants on `profiles` rely on the same default privileges.
> - Rate-limit counters are in memory and reset when the API restarts; fine for one process (revisit if the API ever runs as several).
> - The frontend keeps the token in memory and clears it on a 401 (layer 11, in the contract notes; already written in `docs/api/`).
> - `TRUSTED_PROXIES` must match the tunnel, or every user shares one address and one counter (layers 11 and 13, already deferred above).

The audits of layer 3 found these, which wait too:

> [!NOTE]
> **Decision:** these findings from the audit of layer 3 wait for the layer that makes them matter (2026-11-27):
>
> - The combination topK × neighbors × chunk size has no cap. A prompt-size budget against `num_ctx`, refusing what does not fit (layer 6).
> - Settings within the caps that would make the small model fail every time and force an escalation, for example `minScore` 1 or `maxTokens` 1 in structured mode. Abstain instead of escalating when the user's own settings caused it, and cap escalations per user per day (layer 8).
> - Logout and login give a fresh per-user rate-limit counter, because its key holds the token version. A second counter by user id only (layer 10).
> - Never accept a snapshot or a hash from the client, and cache keys must include the user and the document or index ids (layer 5).
> - Index-time settings in per-request overrides could trigger index builds. Refuse unless the index exists, and cap builds per user (layer 4).
> - CORS is open by default (already deferred to layers 11 and 13).
> - Model digests in the snapshot (layers 5 and 13); interim consumption caps (layers 5 and 6); the harness exemption (layer 10); a run kind in layer 5, so retrieval-only runs ignore the answer settings.
> - The startup check does not verify that `rag_lab_api` still has only `SELECT` on `default_profile` (defence in depth).
> - A top-level unknown field in a body still echoes its key whole (Joi's `"<key>" is not allowed`); only setting keys are cut.
> - There is no test yet for a default profile moved to another version while the server runs.

## 10. Process metrics

How much the agent team uses and costs is measured per loop (a feature or an experiment, from its start to the merge of its pull request), so loops can be compared and the owner can see where the usage goes. It measures the development agents, not the application's token accounting ([design section 14](design.md#14-process-metrics); the application's is [section 5](design.md#5-token-accounting-as-fine-as-possible)).

The tool is `.claude/metrics/usage-report.mjs`, a Node script with no dependencies and its own tests (`node --test .claude/metrics/tests/`), run by the orchestrator. It reads the Claude Code transcripts of this project and keeps only numbers and names: model, token counts, time, session, agent type and description, and the working folder relative to the repository.

| Command | What it does |
|---|---|
| `begin <branch>` | Records that a loop starts now, and which session runs it |
| `collect` | Reads the transcripts, adds the new calls to `calls.jsonl` and copies the transcripts (gzip) |
| `windows` | Shows each loop's time span, how many calls fall in it, overlaps, and the calls that are ambiguous or unattributed |
| `report <branch>` | Prints the usage part of a loop's report; `--write <file>` puts it between the `usage-report` markers of that file |
| `summary` | The table of all loops; `--write <file>` puts it between the `usage-summary` markers |

Everything it stores goes to `RAG_LAB_DATA_DIR\usage\`: `calls.jsonl` (one record per call), the begin markers, `overrides.json` (manual attribution), Claude Code's own cost estimates and `transcripts\` (the gzip copies). The script refuses a data folder inside the repository, and `.gitignore` ignores `*.jsonl` and `*.jsonl.gz`. The reports are in `docs/process/`, one per pull request, described in `docs/process/README.md`; they never show message text, paths, user folders, session titles or full session ids, and an agent description that names a path is hidden whole.

> [!NOTE]
> **Decision:** the source of the numbers is the Claude Code transcripts, not the totals in the agents' completion notifications (2026-11-26). The notifications' totals do not match the transcripts, and the transcripts hold every call with its model and token counts.

> [!NOTE]
> **Decision:** each model call counts once, deduplicated by message id (2026-11-26). Claude Code writes one row per content block of an answer, and side or resumed sessions copy their parent's history, so counting rows would count the same call two or more times.

> [!NOTE]
> **Decision:** records, markers, overrides and transcript copies live in `RAG_LAB_DATA_DIR\usage\`, never in the repository (2026-11-26). They describe the owner's sessions and work, and the repository will become public. Claude Code deletes old transcripts after `cleanupPeriodDays`; the owner's user setting was raised to 365 days, and the copies keep the data anyway.

> [!NOTE]
> **Decision:** a loop runs from `begin <branch>` to the merge of its branch, and a call is attributed to a loop by rule (2026-11-26). The session that ran `begin` belongs to that loop; an agent belongs to the loop its first call fell in; when two loops overlap the worktree decides, and otherwise the call is "ambiguous" and is resolved by hand in `overrides.json`. Nothing is forced into a loop, because a wrong guess would corrupt the comparison without showing. Merges are read from `main` and `origin/main`, because the owner merges on GitHub and the local `main` may not be pulled yet. Each loop gets a fresh orchestrator session, so one session's cost is not split across loops.

> [!NOTE]
> **Decision:** layer 1, pull requests #1 and #2 and the setup committed straight to `main` were attributed by hand (2026-11-26), from the orchestrator's tool calls and the merge commits, because the script did not exist then. The owner confirmed the windows.

> [!NOTE]
> **Decision:** one loop runs at a time (2026-11-26, confirmed by the owner), so that costs do not run away. In layer 1 it did not hold (pull requests #1 and #2 overlapped it), which is why the attribution handles overlaps instead of assuming there are none.

> [!NOTE]
> **Decision:** cost is the "API-equivalent cost": what the tokens would cost on the Claude API, from `.claude/metrics/prices.json` (taken from the `claude-api` skill, prices of 2026-11-03) (2026-11-26). A subscription plan bills differently, so it is a measure for comparing loops, not a bill. Thinking tokens are inside the output and are not charged twice. A price that cannot be computed (an unknown model, a missing rate, web searches) is never guessed: the report says the cost is incomplete and why. Claude Code's own running estimate is shown for comparison only, and a gap between the two is reported, not corrected.

> [!NOTE]
> **Decision:** each pull request gets a process report, in `docs/process/NN-<name>.md` and in the pull request body (2026-11-26): decisions the AI took without asking, plan against what was done, findings funnel, test quality, rework, and the generated usage part. The orchestrator writes it, because it measures the agents' own work, and the docs-keeper may not write `docs/process/`.

> [!NOTE]
> **Decision:** `.claude/metrics/` is out of the agents' reach, like the hooks, and the invisible-character test scans it (2026-11-26). No role writes the script, and the experiment-runner, lab-reporter and analyst no longer read `RAG_LAB_DATA_DIR\usage\`, so the numbers cannot be changed by the agents they measure.

> [!NOTE]
> **Decision:** no role may Grep or Glob the root of the data folder (2026-11-26). A Grep there also read the data folder's `.env`, a gap found while testing, and a Glob there lists the names of the transcript copies in `usage\`. The Glob part was added by the orchestrator after the independent review, without asking the owner.

> [!NOTE]
> **Decision:** path components lose trailing dots and spaces before the hook compares them, and a component with a colon is denied (2026-11-26). This was decided by the orchestrator after the independent review, without asking the owner; the owner can reverse it. Windows reads `name.`, `name ` and `name::$INDEX_ALLOCATION` as the same folder as `name`, and a component such as `.env::$DATA` is an alternate data stream of `.env`, so the old comparison could be bypassed. It also tightens the older rules (`.env`, the lab notebook).

Planned, not built: a chart of usage across loops, once two or three layers have data; and Stryker mutation testing later, which is a new dependency and needs the owner's approval.
