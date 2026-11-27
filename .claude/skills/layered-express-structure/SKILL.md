---
name: layered-express-structure
description: Folder layout, file naming, TypeScript setup and wiring of an Express API. Use when creating a new Express project, adding a new resource/entity end to end (route + controller + service + validator), creating or moving any file, or editing app.ts, server.ts, v1.routes.ts, tsconfig.json or package.json scripts.
---

# Express project structure

## 1. Location & naming

```
.
├── package.json                # "type": "module", scripts below
├── tsconfig.json               # compiles src/ → dist/
├── tsconfig.test.json          # type-checks src/ and test/ together, no output
├── .env.example                # every variable the app reads, with placeholder values
├── docker-compose.yml          # local PostgreSQL, when the project uses one
├── api/index.ts                # optional: Vercel entry, `export default app`
├── migrations/                 # NNN_<description>.sql, applied in order by src/migrate.ts, as the owner
├── scripts/                    # SQL the owner runs by hand, such as create-api-role.sql; no agent role writes it
├── src/
│   ├── app.ts                  # builds the Express app (no listen)
│   ├── server.ts               # checks config, role and schema, imports app and calls listen, shuts down gracefully
│   ├── shutdown.ts             # closeServerGracefully and closePoolGracefully
│   ├── migrate.ts              # applies pending migrations (npm run migrate), with MIGRATION_DATABASE_URL
│   ├── createAdmin.ts          # optional: npm run create-admin, the first admin of a project with accounts
│   └── v1/
│       ├── v1.routes.ts        # mounts every router of the version
│       ├── config/             # external clients / connections   <name>.config.ts
│       ├── routes/             # <entities>.routes.ts
│       ├── controllers/        # <entities>.controller.ts
│       ├── services/           # <entities>.service.ts
│       ├── validators/         # <entities>.validator.ts
│       ├── middlewares/        # <name>.middleware.ts
│       ├── types/              # <entities>.type.ts + express.d.ts
│       └── utils/              # <name>.util.ts
├── test/
│   ├── setup.ts                # runs before every test file: test database, fixed operational settings
│   ├── operationalSettings.ts  # the app's defaults for the settings a developer's .env may change
│   ├── db/                     # schema and migration tests
│   ├── doubles/                # fakes of what the app calls: the model server, a database that freezes
│   ├── repository/             # checks of the repository itself (invisible characters)
│   └── <layer>/                # mirrors src/v1 (utils/, services/, ...): <name>.test.ts
├── docs/                       # project-guide.md: architecture and design decisions
└── dist/                       # build output, git-ignored, never edited
```

- File names: `<name>.<layer>.ts`. The entity is **plural**, the layer suffix is **singular** (`routes` is the one exception, since it is already plural). Multi-word names are camelCase: `watchlistItems.service.ts`, `validateBody.middleware.ts`, `appError.util.ts`. The only file outside this pattern is `types/express.d.ts`.
- One entity = one file per layer. Do not mix entities in a file.
- Folder names are plural and fixed. Do not create new top-level layers without asking.
- Paths in the other skills (`v1/controllers/...`) are relative to `src/`.

## 2. Responsibilities

Request flow, one direction only:

```
v1.routes.ts → <entities>.routes.ts → middlewares → <entities>.controller.ts → <entities>.service.ts → data layer
                                                                    errors ──► next(error) ──► errorMiddleware
```

| Layer | Does | Never |
|---|---|---|
| routes | map method + path → middlewares → controller | contain logic |
| middlewares | auth, authorization, validation, cross-cutting | contain business rules |
| controller | read `req`, call one service, send success response | touch the data layer, contain business rules |
| service | business rules, data access, throw `AppError` | touch `req`/`res` |
| validator | Joi schemas for request bodies + the matching input types | perform DB checks |
| types | entity/row shapes, the JWT payload, the `Request` augmentation | contain runtime code |
| utils | small reusable pure helpers | import from controllers/services |

## 3. Templates

- [templates/tsconfig.json](templates/tsconfig.json)
- [templates/app.ts](templates/app.ts)
- [templates/server.ts](templates/server.ts) — refuses unsafe settings, an over-privileged role, a wrong database and configuration data it cannot use, retries the check in the background while the database is down, starts the background worker (after recovering the jobs a stopped server left running) only once the check has passed, listens, and shuts down gracefully on SIGTERM and SIGINT, stopping the worker first
- [templates/shutdown.ts](templates/shutdown.ts) — `closeServerGracefully` and `closePoolGracefully`, next to `server.ts`
- [templates/server.config.ts](templates/server.config.ts) — `PORT`, `HOST`, `TRUSTED_PROXIES`, `CORS_ORIGINS`
- [templates/env.config.ts](templates/env.config.ts) — `getStartupConfigProblems`, `readIntegerSetting` and `readListSetting`, which validate settings at startup
- [templates/v1.routes.ts](templates/v1.routes.ts)
- [templates/appError.util.ts](templates/appError.util.ts)
- [templates/express.d.ts](templates/express.d.ts) — adds `req.decoded` (the token's claims), `req.user` (the account, from the database) and `req.validatedBody` to Express's `Request`
- [templates/auth.type.ts](templates/auth.type.ts) — `TokenPayload`, `DecodedToken` (`req.decoded`), `AuthenticatedUser` (`req.user`), `AuthResult`; needs the `User` and `UserRole` types of the entity type file
- [templates/products.type.ts](templates/products.type.ts) — example entity type
- [templates/pool.config.ts](templates/pool.config.ts) — `createPool({ connectionString, queryTimeoutMs })` and `runInTransaction`; reads no environment variable
- [templates/db.config.ts](templates/db.config.ts) — the API's `pool` (from `DATABASE_URL`), `withTransaction` and `LOCK_KEYS`, the advisory lock numbers
- [templates/schema.service.ts](templates/schema.service.ts) — `getMigrationStateService(targetPool)`, compares the migration files with the database; goes in `services/`
- [templates/schema.type.ts](templates/schema.type.ts) — `MigrationState`
- [templates/databaseError.util.ts](templates/databaseError.util.ts) — `isDatabaseUnreachableError` and `DATABASE_UNAVAILABLE_MESSAGE`; goes in `utils/`
- [templates/databaseReadiness.service.ts](templates/databaseReadiness.service.ts) — whether the startup check has passed; read by `databaseReadyMiddleware`, set by `server.ts`
- [templates/databaseRole.service.ts](templates/databaseRole.service.ts) — `getDatabaseRoleProblemsService`, what the API's role can do beyond reading and changing rows
- [templates/create-api-role.sql](templates/create-api-role.sql) — `scripts/create-api-role.sql`, the API's role, run once by the owner
- [templates/002_api_role.sql](templates/002_api_role.sql) — the migration that grants the role its rights
- [templates/configuration.config.ts](templates/configuration.config.ts) — the version, the setting keys, the value caps and the body limit of settings that users choose
- [templates/configuration.type.ts](templates/configuration.type.ts) — the types of the settings, their definitions, the snapshot and the resolver's answer
- [templates/004_default_profile.sql](templates/004_default_profile.sql) — a read-only table of defaults (one row, seeded by the migration, `REVOKE` for the API role)
- [templates/005_profiles.sql](templates/005_profiles.sql) — a user-owned table with column grants for the API role and a unique index on `(user_id, lower(name))`
- [templates/006_documents.sql](templates/006_documents.sql) — an immutable user-owned table (`REVOKE UPDATE` and nothing granted back), a content hash with a unique index per user
- [templates/007_document_indexes.sql](templates/007_document_indexes.sql) — a job table that is also the queue (column grants on its state columns only, an index for the claim), and a child table with `UPDATE` on one column and no `DELETE`, removed only by the foreign key's cascade
- [templates/008_index_build_usage.sql](templates/008_index_build_usage.sql) — an insert-only usage table that the daily limits count (`REVOKE UPDATE, DELETE`)
- [templates/migrate.ts](templates/migrate.ts) — migration runner, as the owner (`MIGRATION_DATABASE_URL`), with its own pool and the wrong-database refusals
- [templates/setup.ts](templates/setup.ts) — `test/setup.ts`, points the tests at the test database as the two roles and fixes the operational settings
- [templates/operationalSettings.ts](templates/operationalSettings.ts) — `test/operationalSettings.ts`, the defaults `setup.ts` applies

## 4. Rules

### TypeScript setup

- Copy `tsconfig.json` as is: `module`/`moduleResolution` `NodeNext`, `strict`, `verbatimModuleSyntax`, `rootDir: "src"`, `outDir: "dist"`.
- Relative imports use the **`.js`** extension even though the files are `.ts` (`import { app } from "./app.js"`). `NodeNext` requires it and it is what runs from `dist/`. Never write `.ts` in an import.
- Type-only imports use `import type { ... }` (enforced by `verbatimModuleSyntax`).
- No `any`. Use `unknown` and narrow it, or a precise type. A cast (`as X`) is allowed only where a value crosses an untyped boundary: `req.validatedBody`, `jwt.verify`, rows returned by the data layer.
- Dev dependencies: `typescript`, `tsx`, `@types/node`, `@types/express`, plus `@types/<pkg>` for every runtime package that ships no types (`@types/cors`, `@types/jsonwebtoken`, ...).
- `package.json` scripts (`migrate` only when the project has a database, `create-admin` only when it has accounts):

  ```json
  "scripts": {
      "dev": "tsx watch src/server.ts",
      "build": "tsc",
      "start": "node dist/server.js",
      "migrate": "tsx src/migrate.ts",
      "create-admin": "tsx src/createAdmin.ts",
      "typecheck": "tsc -p tsconfig.test.json",
      "test": "node --import tsx --import ./test/setup.ts --test --test-concurrency=1 \"test/**/*.test.ts\"",
      "test:file": "node --import tsx --import ./test/setup.ts --test --test-concurrency=1"
  }
  ```

  `npm run test:file -- test/<layer>/<name>.test.ts` runs one file with the same setup.

### Database (PostgreSQL with `pg`)

- Two database roles. The **owner** creates the database and owns its tables; only the migration script (`MIGRATION_DATABASE_URL`) and the tests' own schema work connect as it. The **API** connects as a low-privilege role (`rag_lab_api` in RAG Lab, `DATABASE_URL`) that reads and changes rows and nothing else: no superuser, no create-role or create-database, no `CREATE` on the database or on `public`, no tables of its own, no membership in another role. Neither URL is a fallback for the other.
- The API role is created once by `scripts/create-api-role.sql`, run by the owner (`Get-Content scripts/create-api-role.sql | docker compose exec -T db psql -U <owner> -d <db> -v ON_ERROR_STOP=1`), and its password is set by hand (`\password <role>`); no password is in the repository. Its rights on tables are granted in a migration (`002_api_role.sql`), not in the script, so a reset test or development database gets them again. The migration fails naming the script when the role does not exist. `ALTER DEFAULT PRIVILEGES` in it covers only the objects created by the role that ran it, so migrations always run as the same owner role.
- `config/pool.config.ts` exports `createPool({ connectionString, queryTimeoutMs })` and `runInTransaction(pool, callback)` and reads no environment variable, so the migration script can use it without `DATABASE_URL`. `config/db.config.ts` exports the API's `pool`, built from `DATABASE_URL` (startup fails if it is missing), with a connection timeout, `keepAlive` and a query timeout (30 s): without one, a connection that is open but no longer answers holds its request forever; and `withTransaction(callback, targetPool?)`. The migration script never imports `db.config.ts`. Copy the templates.
- At startup `server.ts` asks the database what the role it connected as can do (`getDatabaseRoleProblemsService`, by capability, not by name) and stops if it is a superuser, can create roles or databases, can create objects in the database or in `public`, owns tables in `public`, is a member of another role, or acts as another role than the one that logged in. The message names the role to use and never prints the URL. A PostgreSQL superuser can run commands on the server, so an API that connects as one gives every flaw in a route that much reach.
- A connection taken with `pool.connect()` has no `"error"` listener while it is lent out; if it breaks (PostgreSQL restarting), the unhandled event crashes the process. `withTransaction` listens for that error, releases a broken connection with `release(true)` so the pool drops it, and logs a failed `ROLLBACK` instead of letting it replace the original error. Code that takes a connection by hand does the same.
- The schema changes only through migrations: `migrations/NNN_<description>.sql`, with a three-digit prefix (files are applied in alphabetical order) and one logical change per file. Never edit a migration that has been applied or merged; add a new one.
- `src/migrate.ts` applies the pending files, each together with its `schema_migrations` record in one transaction, under an advisory lock, on its own pool made with `createPool({ connectionString: <MIGRATION_DATABASE_URL> })` (no query timeout: a migration may be slower than any API query). It exits 1 without applying anything when `MIGRATION_DATABASE_URL` is missing. Copy the template.
- Wrong-database guard: `getMigrationStateService(targetPool)` (`services/schema.service.ts`, the pool is always passed) compares the files with `schema_migrations` and returns `applied`, `pending`, `unknown` (recorded but not in this checkout's files) and `foreignTables` (tables in the public schema when there is no `schema_migrations`). `migrate` refuses, and applies nothing, when `unknown` or `foreignTables` is not empty. `server.ts` runs the same comparison at startup, after the role check: it stops on a role with too many rights, on pending, unknown or foreign state and on a database that answers and refuses (a wrong password). The startup check, in order: the settings of `.env` (`getStartupConfigProblems`), the role, the migrations, and then the data the code depends on (`getConfigurationProblemsService`: the default profile is there, at this code's version and inside the caps, and no stored profile is at another version). The data check comes after the schema check because its tables may not exist before it. A project with more data the code depends on adds its check there.
- A table the API may only read (defaults, reference data) is created by a migration, filled by the same migration, and followed by an explicit `REVOKE INSERT, UPDATE, DELETE ON <table> FROM <api role>`, because the default privileges of `002` grant all four rights. A table the API changes only in part (a profile's owner, id and creation time must never change) gets `REVOKE UPDATE ON <table> FROM <api role>` and then `GRANT UPDATE (<columns>) ON <table> TO <api role>`. Both rely on the default privileges applying, so migrations run as the same owner role. A single-row table has a `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`. A table of a user's own rows has `user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE`, and a test that empties `users` uses `TRUNCATE users CASCADE`. Data of a user that is stored as JSON carries a `version` column, written by the app with no database default, and a `CHECK (jsonb_typeof(settings) = 'object')`.
- Rights by what the table is, again as `REVOKE` after the default privileges of `002` and a `GRANT` of only what the code needs (layer 4): a row the API writes once and never changes (an uploaded document) gets `REVOKE UPDATE` and nothing back, so its owner and text cannot change; a job table (`document_indexes`) gets `UPDATE` on its state columns only (status, counters, error, timestamps), never on what the job is (document, size, model, number of chunks); a child table whose rows are removed only by its parent's `ON DELETE CASCADE` (`chunks`) gets `REVOKE UPDATE, DELETE` and `UPDATE` on the one column the work fills in (`embedding`), because a cascade runs as the table's owner and needs no right from the API role; a usage table that limits count (`index_build_usage`) is insert-only (`REVOKE UPDATE, DELETE`), so deleting what was built does not give the build back. A child table with a composite primary key and no URL of its own needs no `id`.
- Limits that depend on what exists are checked against the database, under a lock (see `layered-express-service`, "Background jobs and queues"); a global cap needs an advisory lock, whose numbers live in one object (`LOCK_KEYS` in `config/db.config.ts`) that does not reuse the migration script's.
- A background worker (a queue in the database) is started by `server.ts`, never by importing the app: tests and scripts that import `app` must not start indexing on their own. It starts only once the startup check has passed, whether at once or from the background retry; recovery (jobs a stopped server left "running" go back to the queue) runs first and its failure does not keep the worker from starting. Shutdown stops the worker before it closes the server and the pool, within the same time budget as the requests in progress: its in-flight request is aborted and its job goes back to the queue. Its events go to the log through a listener registered in `server.ts` (job id and message, never the text of a document).
- A change to a default or to a cap is a migration, and an upgrade of the settings follows rules: adding a key bumps the version, and a migration adds it to the default row and moves the versions; widening a cap is code only; renaming or removing a key, or changing its type or unit, bumps the version and needs a data migration.
- When the database cannot be reached (`isDatabaseUnreachableError`, which includes a PostgreSQL that is restarting: 57P01, 57P02, 08000, 08003, 08006), `server.ts` starts anyway with a warning and sets the database as not ready (`setDatabaseReadyService(false)`). The health check reports it as down, every other `/v1` route answers 503 through `databaseReadyMiddleware`, and the whole check (role and migrations) repeats every 3 seconds in the background, with a timer that does not keep the process alive and that shutdown stops, until it passes; any problem it finds then exits 1. `errorMiddleware` answers 503 for an unreachable database during a request too.
- Ids exposed in URLs are UUIDs generated by the database: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`. Tables that never appear in URLs may use `bigint GENERATED ALWAYS AS IDENTITY` or a natural key.
- Column names are snake_case. Fixed value lists are `text` with a `CHECK (... IN (...))` constraint, not `ENUM` types.
- Index every foreign key column; PostgreSQL does not create those indexes automatically.
- Secrets live in `.env` (git-ignored); `.env.example` lists every variable with placeholder values.

### Tests

- `node:test` and `node:assert/strict`, run with `tsx`; files are `test/<layer>/<name>.test.ts`, mirroring `src/v1`.
- Database tests use their own database, whose name ends in `_test`, through two URLs, one per role: `<PROJECT>_TEST_API_DATABASE_URL` (the API role) and `<PROJECT>_TEST_DATABASE_URL` (the owner) (`RAG_LAB_TEST_API_DATABASE_URL` and `RAG_LAB_TEST_DATABASE_URL` in RAG Lab). Both are set in `.env` and also as user environment variables, because a worktree has no `.env`. `test/setup.ts` copies the first into `DATABASE_URL` (the app runs as the API role, with the rights it has in production) and the second into `MIGRATION_DATABASE_URL`, and removes the target of a missing one so tests can never reach the development database. The helper that empties the database refuses one whose name does not end in `_test`, as a second line of defense.
- **The owner-pool rule.** Test helpers do all schema work (reset, running the migration script, creating probe tables) and every inspection of the schema (`pg_tables`, `to_regclass`, `information_schema`) through an owner pool, never through the API's pool: for the API role a table it has no rights on is invisible, so an inspection through its pool can pass while checking nothing. Tests of the API's own rights use the API pool on purpose and assert what it cannot do.
- `test/setup.ts` also sets every operational setting of the app (`HOST`, `PORT`, `TRUSTED_PROXIES`, `CORS_ORIGINS`, the limits, the token lifetime, `OLLAMA_BASE_URL`) to the app's own default from `test/operationalSettings.ts`, so the developer's `.env` cannot change a test. They are set to values, not deleted, because the app loads `.env` itself and would fill a deleted variable in again. Child processes the tests start get the same values. When a new optional setting is added to `.env.example`, add it to `operationalSettings.ts` too.
- `OLLAMA_BASE_URL` is a closed port in tests, so a test that forgets its double gets "connection refused" instead of reaching the real models.
- A database test file resets the schema and runs the real migration script in `before`, empties the tables in `beforeEach`, and closes the pool in `after`. Test files run one at a time (`--test-concurrency=1`) because they share the test database.
- Unit and route tests never call a real model: they replace the provider's wrapper with a test double. Tests that need a live model are integration tests, skipped unless their environment variable is set.
- Test doubles live in `test/doubles/`, one file per thing faked, each with its own test. A double for an HTTP service is a real HTTP server on a free port (`fakeOllama.ts`), so the code under test runs its real `fetch`, timeout and redirect logic; tests choose what each path answers (a list of models, a malformed body, a hang, a redirect, a dropped connection). A double for a database that freezes is a TCP proxy that can pause (`pausableProxy.ts`): connections stay open and no byte travels, which a stopped container cannot simulate. Doubles are written in the test folder, never in `src/`.
- `test/repository/` holds checks of the repository itself, not of the app. One of them scans every project file for invisible characters (zero-width spaces, direction marks, soft hyphen, variation selectors, tag characters, byte order marks, UTF-16 files included) on every `npm test`.
- Tests that wait for a stream to end always have a timeout (`Promise.race` or `{ timeout }`), so a stream that never ends fails the test instead of hanging the suite.
- In RAG Lab, the agent hooks have their own tests in `.claude/hooks/tests/` (`node --test .claude/hooks/tests/`), outside `test/` on purpose so the test-writer cannot change them.

### Types

- Entity/row shapes live in `types/<entities>.type.ts` as `export interface <Entity>` (e.g. `Product`). Services return these types.
- Request-body input types (`Create<Entity>Input`, `Update<Entity>Input`) live in the validator file next to their schema (see `layered-express-validator`).
- New `req.*` properties are declared in `types/express.d.ts` and documented in the `layered-express-middleware` skill.

### Wiring

- `app.ts` order: `import "dotenv/config"` first → `app.disable("x-powered-by")` → `app.set("trust proxy", TRUSTED_PROXIES)` → `securityHeadersMiddleware` → `cors` (limited to `CORS_ORIGINS` when set) → the per-address limit (`rateLimitMiddleware({ keyBy: "ip" })`, every request, before any authentication) → `app.use("/v1", v1Router)` → `notFoundMiddleware` → `errorMiddleware` (always last).
- `v1.routes.ts` order: the health router (it works without the database) → `databaseReadyMiddleware` → public routes (login) → `authenticateMiddleware` → the per-user limit → `currentUserMiddleware` → protected routes. Authentication is token-only and costs no query, the per-user limit comes before the database is asked, and `currentUserMiddleware` then reads the account once per request.
- Behind a proxy or tunnel, every request comes from the proxy: without `trust proxy`, every limit keyed by address becomes one counter for the whole internet. Set it to the proxy's addresses (`TRUSTED_PROXIES`, `loopback` by default), never `true`, which would trust the left-most `X-Forwarded-For` entry, the one the client writes. Test it against the real app's configuration.
- Settings come from `config/*.config.ts`, read with `readIntegerSetting` and `readListSetting` (`config/env.config.ts`): a value that is not plain decimal digits, or is outside its minimum and maximum, stops the app at startup instead of breaking it later, and is never clamped (`Number(env) || default` accepts negatives; `Number("1e3")` and `Number("0x10")` are numbers). Give a setting a maximum whenever a larger value is a mistake. A setting a URL or a secret must satisfy is checked by `getStartupConfigProblems`, which `server.ts` calls first.
- `server.ts` shuts down gracefully on SIGTERM (`docker stop`) and SIGINT: stop background work, `closeServerGracefully` (stop accepting, end long-lived responses, wait for requests in progress, then close what is left), then `closePoolGracefully` (`pool.end()`, and after its timeout destroy the connections still lent out, so a request stuck on a frozen database cannot keep the process alive). Both timeouts add up to less than Docker's 10 s grace period (6 s and 2 s in RAG Lab). `closePoolGracefully` reads pg-pool's private client lists in one commented place because the public API cannot list clients lent out before it is called; keep it that way.
- No global body parser and no `express.urlencoded`: the API only accepts JSON, and each route that takes a body parses it with its own `express.json()` (see `layered-express-route`). A global parser would read the body of requests that authentication or a rate limit is about to reject, and routes that need a larger limit would need path checks in `app.ts`.
- `app.ts` exports `app`; only `server.ts` calls `listen` (Express 5 passes listen errors to its callback, so "Server running" is printed only when the server really listens), so the app can be reused by Vercel and tests.
- Database connection setup lives in `config/pool.config.ts` (shared) and `config/db.config.ts` (the API's).
- Every new project starts with: `tsconfig.json`, `utils/appError.util.ts`, `types/express.d.ts`, `types/auth.type.ts`, the core middlewares from the `layered-express-middleware` skill (`error`, `notFound`, `validateBody`, `authenticate`, `currentUser`, `authorize`, `databaseReady`, `securityHeaders`) with `config/auth.config.ts`, `config/limits.config.ts` and `utils/token.util.ts`, and `utils/requireUserId.util.ts` from the `layered-express-controller` skill.
- **Adding a new resource** — create files in this order, loading each layer's skill:
  0. `migrations/NNN_<description>.sql` when the resource needs new tables or columns
  1. `types/<entities>.type.ts` (entity shape)
  2. `validators/<entities>.validator.ts` → `layered-express-validator`
  3. `services/<entities>.service.ts` → `layered-express-service`
  4. `controllers/<entities>.controller.ts` → `layered-express-controller`
  5. `routes/<entities>.routes.ts` → `layered-express-route`
  6. Mount the router in `v1/v1.routes.ts` (public or protected section).

## 5. Checklist

- [ ] Every file sits in its layer folder under `src/` and follows `<name>.<layer>.ts`.
- [ ] Relative imports end in `.js`; type-only imports use `import type`.
- [ ] No layer is skipped (routes never call services; controllers never touch the data layer).
- [ ] New router is mounted in `v1.routes.ts` in the correct section.
- [ ] `errorMiddleware` is the last `app.use`.
- [ ] `npm run build` and `npm run typecheck` pass with no type errors.
- [ ] Schema changes are in a new migration; no applied migration was edited.
