# RAG Lab

A RAG API built by a team of Claude Code agents. It answers questions about uploaded documents with two local models and a router, measures every question (accuracy, latency, tokens), and lets each signed-in user change the configuration in a playground to see how precision and token use respond. A frontend comes later, from the API contract kept in [docs/api/](docs/api/).

The design, with every decision and its reason, is in [docs/design.md](docs/design.md); the architecture and the decisions taken while building are in [docs/project-guide.md](docs/project-guide.md).

> **Status:** layer 4 of 13, Documents and indexes, is built on top of layer 3 (Configuration as data), layer 2 (Accounts and authentication) and layer 1 (Foundations): a user uploads a document as text, and the API cuts it in chunks, embeds them with `qwen3-embedding:0.6b` in a background queue and stores the vectors, one index per chunk size. Layer 3 gave the settings users may change with their caps, a default profile in the database, each user's own profiles, and a resolver that turns them into one configuration with a hash. Layer 2 gave accounts created by an admin, login and logout, tokens that can be revoked, the low-privilege database role of the API and the limits of the account routes. There is no search or questions yet. The order of the layers is in the [design](docs/design.md#13-build-order).

## Requirements

- Node.js 22.18 or later
- Docker Desktop (runs PostgreSQL 17 with pgvector)
- Ollama with `qwen3.5:4b` and `qwen3-embedding:0.6b` (`gpt-oss:20b` joins in layer 8). Indexing a document uses the embedding model `qwen3-embedding:0.6b`; without it (or without Ollama running) an uploaded document's index fails or waits

## Setup

All commands are for PowerShell, run from the project folder.

1. Create `.env` from `.env.example`:

   ```powershell
   Copy-Item .env.example .env
   ```

   There are two database roles. The owner, `rag_lab`, owns the tables and is the only one that changes the schema (`npm run migrate`). The API runs as `rag_lab_api`, which reads and changes rows and nothing else.

2. In `.env`, replace every `change-me` in `POSTGRES_PASSWORD`, `MIGRATION_DATABASE_URL` and `RAG_LAB_TEST_DATABASE_URL` with one long random password (the owner's; letters and digits only, so it works inside the URLs), every `change-me-api` in `DATABASE_URL` and `RAG_LAB_TEST_API_DATABASE_URL` with a different one (the API role's), and `SECRET_KEY` with a third random value of at least 32 characters. This prints a random value:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

   The database lines end up like this (port `25432`, databases `rag_lab` and `rag_lab_test`):

   ```
   POSTGRES_PASSWORD=<owner password>
   DATABASE_URL=postgresql://rag_lab_api:<api password>@127.0.0.1:25432/rag_lab
   MIGRATION_DATABASE_URL=postgresql://rag_lab:<owner password>@127.0.0.1:25432/rag_lab
   RAG_LAB_TEST_API_DATABASE_URL=postgresql://rag_lab_api:<api password>@127.0.0.1:25432/rag_lab_test
   RAG_LAB_TEST_DATABASE_URL=postgresql://rag_lab:<owner password>@127.0.0.1:25432/rag_lab_test
   ```

3. Start PostgreSQL. It listens on `127.0.0.1:25432` only, and its data lives in a Docker volume:

   ```powershell
   docker compose up -d db
   ```

4. Create the test database, once (the tests empty it on every run):

   ```powershell
   docker compose exec db createdb -U rag_lab rag_lab_test
   ```

5. Create the API's role, once. [scripts/create-api-role.sql](scripts/create-api-role.sql) creates `rag_lab_api` without any privilege beyond connecting to the two databases; the rights on tables come from the migrations. It must run after step 4, because it names both databases:

   ```powershell
   Get-Content scripts/create-api-role.sql | docker compose exec -T db psql -U rag_lab -d rag_lab -v ON_ERROR_STOP=1
   ```

6. Set the API role's password, the one in the two `rag_lab_api` URLs. This opens a `psql` session; at its prompt type `\password rag_lab_api`, enter the password twice, then `\q`:

   ```powershell
   docker compose exec db psql -U rag_lab -d rag_lab
   ```

7. Also set both test database URLs as user environment variables, because a worktree has no `.env`. Use the same values as in `.env`, then open a new terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("RAG_LAB_TEST_API_DATABASE_URL", "postgresql://rag_lab_api:<api password>@127.0.0.1:25432/rag_lab_test", "User")
   ```

   ```powershell
   [Environment]::SetEnvironmentVariable("RAG_LAB_TEST_DATABASE_URL", "postgresql://rag_lab:<owner password>@127.0.0.1:25432/rag_lab_test", "User")
   ```

8. Install the dependencies:

   ```powershell
   npm install
   ```

9. Create the schema. This connects as the owner (`MIGRATION_DATABASE_URL`) and needs the role from step 5, because migration `002_api_role.sql` grants it its rights and stops, naming the script, when the role is missing:

   ```powershell
   npm run migrate
   ```

10. Create the first admin. There is no self-registration: this prints a generated 24-character password once, and only its hash is stored. Log in with it, then create the other accounts through the API (`POST /v1/users`):

    ```powershell
    npm run create-admin -- admin@example.com
    ```

11. Start the API on `http://127.0.0.1:3000`, restarting on every change:

    ```powershell
    npm run dev
    ```

12. Check it:

    ```powershell
    Invoke-RestMethod http://127.0.0.1:3000/v1/health
    ```

    `data.status` is `ok` when the database answers and both models are installed in Ollama, `degraded` when Ollama is unreachable or a model is missing, and `down` when the database does not answer.

### An existing checkout (after layer 2 is merged)

The database already has its tables, and `.env` has the old `DATABASE_URL`, which is the owner's. Do steps 5 and 6 above (the role and its password), then:

1. In `.env`, move the old `DATABASE_URL` value to a new `MIGRATION_DATABASE_URL`, set `DATABASE_URL` to the `rag_lab_api` URL, and add `RAG_LAB_TEST_API_DATABASE_URL` (see step 2).
2. Set `RAG_LAB_TEST_API_DATABASE_URL` as a user environment variable (step 7).
3. Run `npm run migrate` (step 9) and `npm run create-admin -- <email>` (step 10).

The server stops at startup if `DATABASE_URL` still connects as the owner, and says to use the role `rag_lab_api`.

### An existing checkout (after layer 3 is merged)

Run `npm run migrate` (step 9). Migration `004_default_profile.sql` creates and fills the default profile, and `005_profiles.sql` creates the profiles table. The server refuses to start while they are pending, and when the default profile in the database is missing or outside the caps, or a stored profile is at another configuration version.

### An existing checkout (after layer 4 is merged)

Run `npm run migrate` (step 9). It applies `006_documents.sql`, `007_document_indexes.sql` and `008_index_build_usage.sql`: the tables of documents, indexes, chunks and the count of index builds. The new variables are optional and have defaults (see Configuration and `.env.example`). There are no new roles and no new scripts. The server refuses to start while the migrations are pending. When it starts, it puts the indexes that a stopped server left half built back in the queue and starts the indexing worker.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the API from `src/` with `tsx`, restarting on every change |
| `npm run build` | Compiles `src/` to `dist/` with `tsc` |
| `npm start` | Runs the compiled API (`node dist/server.js`) |
| `npm run migrate` | Applies the pending SQL files of `migrations/` to the database in `MIGRATION_DATABASE_URL`, as the owner (`rag_lab`); it does not need `DATABASE_URL` |
| `npm run create-admin -- <email>` | Creates the first admin, through `DATABASE_URL`, and prints its generated password once |
| `npm run typecheck` | Type-checks `src/` and `test/` together, with no output |
| `npm test` | Runs the whole suite, one test file at a time, against the test database |
| `npm run test:file -- <file>` | Runs one test file, for example `npm run test:file -- test/routes/health.test.ts` |

The hooks that limit the agents have their own tests: `node --test .claude/hooks/tests/`.

## Process metrics

`.claude/metrics/usage-report.mjs` measures the usage and the API-equivalent cost of each loop (pull request) from Claude Code's transcripts. It has no dependencies and is run by the orchestrator, from the main checkout or a worktree. It needs `RAG_LAB_DATA_DIR` (from the environment or `.env`).

```powershell
node .claude/metrics/usage-report.mjs begin feature/<name>
```

| Command | What it does |
|---|---|
| `begin <branch>` | Marks the start of a loop (run it once, in the loop's own session) |
| `collect` | Reads the transcripts and stores the new calls and a gzip copy of the transcripts |
| `windows` | Shows each loop's span and the calls that are ambiguous or unattributed |
| `report <branch> [--write <file>]` | The usage part of a loop's report, for example `--write docs/process/NN-<name>.md` |
| `summary [--write <file>]` | The table of all loops |

The records go to `RAG_LAB_DATA_DIR\usage\`, never into the repository. Its tests: `node --test .claude/metrics/tests/`. How the numbers are made, and the reports so far: [docs/process/README.md](docs/process/README.md).

## Endpoints

All paths start with `/v1`. Protected endpoints need the header `Authorization: Bearer <token>` (the token comes from login), and each user can make 120 requests per minute to them; one client address can make 300 requests per minute in total. The full contract is in [docs/api/openapi.yaml](docs/api/openapi.yaml).

| Method and path | Access | What it does |
|---|---|---|
| `GET /health` | Public | Answers `200` with `data.status` `ok`, `degraded` or `down`, and the state of `database` and `ollama` (`up` or `down`). A client address can make 30 checks per minute; a report is reused for 10 seconds |
| `POST /auth/login` | Public | Body `{ email, password }`; answers `200` with `data` (the user) and `token`. 10 logins per address and 5 failed ones per email and address, per 15 minutes |
| `POST /auth/logout` | Token | Ends every session of the account: all its tokens stop working |
| `GET /users/me` | Token | The signed-in user |
| `PATCH /users/me/password` | Token | Body `{ currentPassword, newPassword }` (8 to 64 characters); answers with a new `token`, and the old ones stop working. 5 attempts per 15 minutes |
| `POST /users` | Admin | Creates an account: `{ email, password, role? }`; answers `201`. 20 attempts per hour |
| `PATCH /users/:id` | Admin | Changes another account's `role` and/or `status` (`active` or `disabled`); never your own |
| `GET /configuration` | Token | What each setting accepts (type, allowed values or range), the defaults the database holds, and the limits on profiles, documents and index builds |
| `POST /configuration/resolve` | Token | Body `{ profileId?, overrides? }`, both optional; answers the complete configuration a question would run with, and its hash. A dry run: it calls no model |
| `GET /profiles` | Token | The caller's profiles, oldest first, each with its `problems` |
| `POST /profiles` | Token | Body `{ name, settings? }`; answers `201`. `409` over `MAX_PROFILES_PER_USER` or for a name the user already has |
| `GET /profiles/:id` | Token | One of the caller's profiles; another user's is a `404`, an admin's too |
| `PATCH /profiles/:id` | Token | Body with `name` and/or `settings`, at least one; the settings sent replace the stored ones |
| `DELETE /profiles/:id` | Token | Deletes the profile |
| `GET /documents` | Token | The caller's documents, newest first, each with its indexes; never the text |
| `POST /documents` | Token | Body `{ filename, text, chunkSize?, embeddingModel? }` (the client extracts the text; the server never parses a file); answers `202`, because the first index is built in the background. `409` over `MAX_DOCUMENTS_PER_USER`, for a text the user already has, or while another build is in progress; `429` over `UPLOAD_REQUESTS_PER_MINUTE` or the daily build limits; `503` when the queue is full |
| `GET /documents/:id` | Token | One of the caller's documents; another user's is a `404`, an admin's too |
| `DELETE /documents/:id` | Token | Deletes the document, its indexes and its chunks, and aborts a build in progress |
| `POST /documents/:id/indexes` | Token | Body `{ chunkSize?, embeddingModel? }`, both optional; queues an index (`202`), or returns the one already queued, being built or ready (`200`). A failed one is queued again (`202`) |
| `GET /documents/:id/indexes/:indexId` | Token | The state of an index: `status` (`queued`, `indexing`, `ready`, `failed`), progress, tokens, place in the queue. Poll it every 2 to 3 seconds |
| `DELETE /documents/:id/indexes/:indexId` | Token | Deletes the index (this is how a build is cancelled) |

Numbers in settings must be JSON numbers, never text, and a value outside its cap is refused, never rounded or clamped. Successful responses look like `{ success: true, message, data }`; errors look like `{ message }`, with `details` for validation errors. While the database cannot be reached, every endpoint except `GET /health` answers `503`.

## Configuration

Every variable is in [.env.example](.env.example), with its default and range. A value out of range, or not written as plain decimal digits, stops the API at startup. The server also refuses to start with a missing or placeholder `SECRET_KEY`, or with an `OLLAMA_BASE_URL` that is not an absolute http or https URL.

`DATABASE_URL` must connect as the role `rag_lab_api`. The server refuses to start when that role is a superuser, can create roles or databases, can create objects in the database or in the `public` schema, owns tables there, is a member of another role, or acts as another role than the one that logged in: the owner's URL belongs in `MIGRATION_DATABASE_URL`. If the database cannot be reached at startup, the server starts anyway, checks again every 3 seconds, and answers `503` on every route but `GET /v1/health` until the check passes. The limits of the account routes (`REQUESTS_PER_ADDRESS_PER_MINUTE`, `LOGINS_PER_15_MINUTES`, `FAILED_LOGINS_PER_EMAIL_PER_15_MINUTES`, `PASSWORD_CHANGES_PER_15_MINUTES`, `USER_CREATIONS_PER_HOUR`) have defaults and are counted in memory, so they reset when the API restarts. Behind a tunnel, `TRUSTED_PROXIES` must match it, or every user shares one address and one counter.

A user may keep at most `MAX_PROFILES_PER_USER` profiles (default 20, range 1 to 1000). The values the settings may take (chunk size, models, top K and the rest) are capped in the code, in `src/v1/config/configuration.config.ts`, not in `.env`; the defaults are the row of the `default_profile` table, which only a migration changes. At startup the server also refuses a default profile that is missing or outside the caps, and a stored profile at another configuration version.

Documents and indexes (layer 4) have their own limits, all optional and each with a range (the two request limits are counted in memory and reset when the API restarts; the others are counted in the database): `MAX_DOCUMENTS_PER_USER` (3), `MAX_DOCUMENT_CHARACTERS` (1,000,000, at most 5,000,000; the upload body limit follows from it, 3 bytes per character plus 16 kB), `UPLOAD_REQUESTS_PER_MINUTE` (5, also the limit of `POST /documents/:id/indexes`, with its own counter), `MAX_ACTIVE_INDEX_BUILDS_PER_USER` (1), `MAX_QUEUED_INDEX_BUILDS` (20, counts the builds waiting, all users together), `MAX_INDEX_BUILDS_PER_DAY` (6 per user, over the last 24 hours, uploads included; deleting does not give a build back), `MAX_INDEX_BUILDS_PER_DAY_TOTAL` (100, all users together) and `OLLAMA_TIMEOUT_MS` (120000, how long one request to Ollama may take). The indexing worker runs inside the API process, started by `server.ts` once the database check has passed, and builds one index at a time; nothing is deleted automatically.

## Project structure

```
.
├── docker-compose.yml     # the db service (PostgreSQL 17 with pgvector), project rag-lab
├── migrations/            # numbered SQL files, applied in order by npm run migrate
├── scripts/               # SQL the owner runs by hand: create-api-role.sql
├── src/
│   ├── app.ts             # builds the Express app
│   ├── server.ts          # checks the config, the role and the schema, starts the indexing worker, listens, shuts down gracefully
│   ├── shutdown.ts        # closeServerGracefully and closePoolGracefully
│   ├── migrate.ts         # the migration runner (as the owner)
│   ├── createAdmin.ts     # npm run create-admin: the first admin
│   └── v1/                # config, routes, controllers, services, middlewares, types, utils
├── test/                  # mirrors src/; doubles/ holds the fake Ollama and the pausable proxy
├── docs/                  # design.md, project-guide.md, api/, experiments/, process/
└── .claude/               # agents, hooks, skills and the usage-report script (metrics/)
```

Evaluation sets, documents and run results are private: they live outside the repository, in `RAG_LAB_DATA_DIR`.
