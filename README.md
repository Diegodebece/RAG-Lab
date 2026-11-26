# RAG Lab

A RAG API built by a team of Claude Code agents. It answers questions about uploaded documents with two local models and a router, measures every question (accuracy, latency, tokens), and lets each signed-in user change the configuration in a playground to see how precision and token use respond. A frontend comes later, from the API contract kept in [docs/api/](docs/api/).

The design, with every decision and its reason, is in [docs/design.md](docs/design.md); the architecture and the decisions taken while building are in [docs/project-guide.md](docs/project-guide.md).

> **Status:** layer 1 of 13, Foundations, is built: the app, the health check, the migrations, the middlewares and the test setup. There are no accounts, documents or questions yet. The order of the layers is in the [design](docs/design.md#13-build-order).

## Requirements

- Node.js 22.18 or later
- Docker Desktop (runs PostgreSQL 17 with pgvector)
- Ollama with `qwen3.5:4b` and `qwen3-embedding:0.6b` (`gpt-oss:20b` joins in layer 8)

## Setup

All commands are for PowerShell, run from the project folder.

1. Create `.env` from `.env.example`:

   ```powershell
   Copy-Item .env.example .env
   ```

2. In `.env`, replace every `change-me` in `POSTGRES_PASSWORD`, `DATABASE_URL` and `RAG_LAB_TEST_DATABASE_URL` with the same long random password (letters and digits only, so it works inside the URLs), and `SECRET_KEY` with a different random value of at least 32 characters. This prints a random value:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

   The database lines end up like this (user `rag_lab`, port `25432`, databases `rag_lab` and `rag_lab_test`):

   ```
   POSTGRES_PASSWORD=<password>
   DATABASE_URL=postgresql://rag_lab:<password>@127.0.0.1:25432/rag_lab
   RAG_LAB_TEST_DATABASE_URL=postgresql://rag_lab:<password>@127.0.0.1:25432/rag_lab_test
   ```

3. Start PostgreSQL. It listens on `127.0.0.1:25432` only, and its data lives in a Docker volume:

   ```powershell
   docker compose up -d db
   ```

4. Create the test database, once (the tests empty it on every run):

   ```powershell
   docker compose exec db createdb -U rag_lab rag_lab_test
   ```

5. Also set the test database URL as a user environment variable, because a worktree has no `.env`. Use the same value as in `.env`, then open a new terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("RAG_LAB_TEST_DATABASE_URL", "postgresql://rag_lab:<password>@127.0.0.1:25432/rag_lab_test", "User")
   ```

6. Install the dependencies:

   ```powershell
   npm install
   ```

7. Create the schema:

   ```powershell
   npm run migrate
   ```

8. Start the API on `http://127.0.0.1:3000`, restarting on every change:

   ```powershell
   npm run dev
   ```

9. Check it:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:3000/v1/health
   ```

   `data.status` is `ok` when the database answers and both models are installed in Ollama, `degraded` when Ollama is unreachable or a model is missing, and `down` when the database does not answer.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the API from `src/` with `tsx`, restarting on every change |
| `npm run build` | Compiles `src/` to `dist/` with `tsc` |
| `npm start` | Runs the compiled API (`node dist/server.js`) |
| `npm run migrate` | Applies the pending SQL files of `migrations/` to the database in `DATABASE_URL` |
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

All paths start with `/v1`. Protected endpoints will need the header `Authorization: Bearer <token>`, and each user can make 120 requests per minute to them. The full contract is in [docs/api/openapi.yaml](docs/api/openapi.yaml).

| Method and path | Access | What it does |
|---|---|---|
| `GET /health` | Public | Answers `200` with `data.status` `ok`, `degraded` or `down`, and the state of `database` and `ollama` (`up` or `down`). A client address can make 30 checks per minute; a report is reused for 10 seconds |

Successful responses look like `{ success: true, message, data }`; errors look like `{ message }`, with `details` for validation errors.

## Configuration

Every variable is in [.env.example](.env.example), with its default and range. A value out of range, or not written as plain decimal digits, stops the API at startup. The server also refuses to start with a missing or placeholder `SECRET_KEY`, or with an `OLLAMA_BASE_URL` that is not an absolute http or https URL.

## Project structure

```
.
├── docker-compose.yml     # the db service (PostgreSQL 17 with pgvector), project rag-lab
├── migrations/            # numbered SQL files, applied in order by npm run migrate
├── src/
│   ├── app.ts             # builds the Express app
│   ├── server.ts          # checks the config and the schema, listens, shuts down gracefully
│   ├── shutdown.ts        # closeServerGracefully and closePoolGracefully
│   ├── migrate.ts         # the migration runner
│   └── v1/                # config, routes, controllers, services, middlewares, types, utils
├── test/                  # mirrors src/; doubles/ holds the fake Ollama and the pausable proxy
├── docs/                  # design.md, project-guide.md, api/, experiments/, process/
└── .claude/               # agents, hooks, skills and the usage-report script (metrics/)
```

Evaluation sets, documents and run results are private: they live outside the repository, in `RAG_LAB_DATA_DIR`.
