# PR #6: feature/accounts

Layer 2, Accounts and authentication: the `users` table, login, logout by token version, the current user, password change, admin creation and update of accounts, an owner-run script for the first admin, and the three findings that layer 1's audit deferred to this layer (a low-privilege database role for the API, token revocation with `iss`/`aud` and a role read fresh from the database, a per-address limit before authentication with a length cap on the email in rate-limit keys). Plan approved by the owner on 2026-11-26 with the planner's recommendations for its 17 open decisions, except D13: the owner chose a minimum password length of 8 (as RAG Web) instead of the proposed 15, and confirmed 300 requests per minute per address for D11 "as long as there are no hardware problems".

The full feature loop ran: planner, test-writer, implementer, code-auditor and owasp-auditor in parallel, finding-verifier, a second round of test-writer and implementer for the confirmed findings, and docs-keeper. The owner created the database role `rag_lab_api` and its test URL before the test-writer started.

## Decisions the AI took without asking

| Who | Decision | Where | How to revert |
|---|---|---|---|
| orchestrator | The worktree uses the main checkout's `node_modules` through a junction (same lockfile, nothing installed); local only, not committed | `.claude/worktrees/accounts/node_modules` | Delete the junction |
| orchestrator | Fix every confirmed code finding of the audit in this layer, including two rated info (the role check and the login timing with old hashes), instead of deferring them | second round | Revert the round-2 commits |
| orchestrator | Account creations count every attempt after authorization, like password changes, instead of only successes (closes a bypass by closing the connection; the implementer had asked) | `src/v1/routes/users.routes.ts` | Put `onlySuccesses` back and count creations after the insert |
| orchestrator | Two admins demoting each other: lock both rows and re-check the actor, no "last admin" rule (the actor cannot change themselves, so a checked active actor always remains) | `src/v1/services/users.service.ts` | — |
| orchestrator | While the database cannot be reached at startup, every `/v1` route except health answers 503 until the role and migration checks pass, and the server retries them in the background | `src/server.ts`, `databaseReady.middleware.ts` | Exit at startup instead of retrying |
| orchestrator | Deferred: a per-account limit on failed logins across addresses, a cap on concurrent scrypt jobs, a breached-password check | `docs/project-guide.md` section 9 | Build them now |
| implementer | A password change or a login rehash only applies if the stored hash is still the one that was checked; a concurrent change gets 409 | `users.service.ts`, `auth.service.ts` | Unconditional update |
| implementer | Stored hash parameters outside fixed ranges are refused without throwing; the dummy hash is computed on first use and cached | `src/v1/utils/password.util.ts`, `auth.service.ts` | — |
| implementer | The per-user limit is keyed `user:<id>:v<tokenVersion>` (from the audit; the brief named the key) | `rateLimit.middleware.ts` | Key by user id only |
| implementer | `migrate` stops needing `DATABASE_URL` by splitting the pool code into `pool.config.ts`, rather than making the API pool lazy (the tests import it eagerly) | `src/v1/config/pool.config.ts`, `src/migrate.ts` | Lazy pool |
| implementer | Background retry every 3 s, counted from the end of each check; messages of the new role problems and of the retry are its own wording | `src/server.ts`, `databaseRole.service.ts` | — |
| test-writer | Tests beyond the plan: refusals for each risky role right with a right-less control, pgvector use by the API role, TRUNCATE refused on later tables, a test file for the account-creation limit, update-time constraint checks | `test/` | — |

## Plan against what was done

- Everything in the approved plan was built, with the owner's D11 (300) and D13 (8 to 64).
- The planner's risk 1 (a leftover `test/db/.migrations-copy-*` folder that would break the typecheck) was a temporary copy made by the baseline test run that was running at the same time; it was gone when checked, and `failedMigration.test.ts` now removes leftovers in `before`.
- Not in the plan, from the audit: the readiness gate and background retry at startup, the per-version user key, row locks in `updateUserService`, `pool.config.ts`, the 57P01/57P02/08xxx codes, three more role checks (session user, membership, CREATE on the database), the dummy hash after failures against old or unusable hashes.
- The orchestrator wrote `scripts/create-api-role.sql` and the `create-admin` line of `package.json`, which no agent may write, and removed scratch files the agents could not delete (three test scratch files, the old `testTokens.ts`, a latency probe, report files under `dist/`).
- The hook refuses `<` and `>` in agent commands, so the agents' commit trailers lost their angle brackets; the orchestrator fixed them by amending the unpushed commits.

## Findings funnel

| Stage | Findings |
|---|---|
| code-auditor | 11: 1 medium (the role and migration checks were skipped for the whole process when the database was down at startup), 8 low (two admins could demote each other at once; the role check ignored the session user and memberships; closing the connection got around the account-creation limit; `migrate` needed `DATABASE_URL`; a revoked token used up the per-user counter; login timing with old or unusable hashes; a PostgreSQL restart during a request gave 500; weak or missing tests), 2 info (no per-account limit across addresses; ops notes) |
| owasp-auditor | 6: 1 medium (same startup gap), 4 low (revoked token and the per-user counter; account-creation bypass; guessing limited per address only; `.env.example` out of date), 1 info (role memberships). All 6 overlap the code-auditor's |
| distinct findings | 12 (the code-auditor's 11, with the `.env.example` part of its `migrate` finding counted apart) |
| finding-verifier | 0 refuted: 10 confirmed, 1 partly (login timing: no such hash can exist today), 1 confirmed and accepted by the spec (per-account limit across addresses) |
| fixed | 9 in code, each with a test that failed first; `.env.example` by the docs-keeper |
| deferred | 2: per-account limit and concurrent scrypt cap (accepted risk, layer 10 or 13); the default-privileges ops note (documented) |

## Test quality

- Layer-2 tests written first: 154 tests on `main` became 362 counted in the red run (150 passing: layer-1 behavior and explicit guards; 61 failing; 151 cancelled by the `before`-hook cascade, since `migrate` ignored `MIGRATION_DATABASE_URL` and migrations 002 and 003 did not exist), plus 4 files failing on missing modules. The test-writer checked the database tests against a draft of the migrations, reverted.
- After the first implementation: 417 passing. After the second round: 458 passing.
- The test-writer listed its own weak spots (only an older token version tested; the creation limit's failed attempts; the timing test machine-dependent; no test of logs); the auditors found more (the superuser check removable without a failing test; a one-sided timing bound; the upper-case self id; concurrent password changes; `migrate` without `DATABASE_URL`, hidden because the test helper passed the whole environment). All were added in round 2, except a test of log output.
- Round-2 tests that passed before the fix, kept as guards: the superuser line, the two-sided timing bound, the upper-case self id, concurrent password changes, server and `createAdmin` refusing without `DATABASE_URL`, routes working once the database comes back.

## Rework

- Second round of the test-writer and the implementer, caused by the audit (9 confirmed code findings).
- No other role ran twice.

<!-- usage-report:start -->
## Usage and cost

PR #6, `feature/accounts`: 618 model calls from 2026-11-26 16:50 to 2026-11-26 21:53 UTC, in 1 session (01fa8889).

**API-equivalent cost: USD 33.03**: what these tokens would cost on the Claude API at the prices of 2026-11-03; a subscription plan bills differently.

| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
| test-writer | tests | 2 | 180 | 360 | 271,151 (109,773) | 614,952 | 35,741,391 | USD 7.82 | 24 % |
| orchestrator | orchestration | 0 | 83 | 196 | 71,005 (11,910) | 370,045 | 16,350,002 | USD 7.65 | 23 % |
| implementer | code | 2 | 194 | 388 | 131,692 (47,230) | 445,938 | 29,739,798 | USD 5.41 | 16 % |
| planner | plan | 1 | 35 | 70 | 109,483 (81,252) | 466,031 | 3,664,941 | USD 5.25 | 16 % |
| docs-keeper | docs | 1 | 44 | 88 | 98,628 (9,332) | 231,066 | 6,357,594 | USD 2.20 | 7 % |
| code-auditor | audit | 1 | 33 | 66 | 47,277 (33,346) | 144,106 | 2,491,169 | USD 2.16 | 7 % |
| owasp-auditor | audit | 1 | 25 | 50 | 32,893 (19,817) | 114,826 | 1,516,182 | USD 1.54 | 5 % |
| finding-verifier | verification | 1 | 24 | 48 | 21,031 (10,907) | 71,645 | 1,092,320 | USD 1.00 | 3 % |

### By model

| Model | Calls | Output | Cache read | Cost | Share |
|---|---|---|---|---|---|
| claude-opus-5-5 | 200 | 281,689 | 25,114,614 | USD 17.60 | 53 % |
| claude-sonnet-5-5 | 418 | 501,471 | 71,838,783 | USD 15.43 | 47 % |

### Agents

| Start (UTC) | Role | Model | Description | Calls | Cost |
|---|---|---|---|---|---|
| 2026-11-26 16:51 | planner | claude-opus-5-5 | Plan layer 2: accounts and auth | 35 | USD 5.25 |
| 2026-11-26 17:24 | test-writer | claude-sonnet-5-5 | Write layer 2 tests first | 114 | USD 5.67 |
| 2026-11-26 17:55 | implementer | claude-sonnet-5-5 | Implement layer 2 accounts and auth | 77 | USD 2.90 |
| 2026-11-26 18:15 | owasp-auditor | claude-opus-5-5 | OWASP audit of layer 2 | 25 | USD 1.54 |
| 2026-11-26 18:15 | code-auditor | claude-opus-5-5 | Audit layer 2 code for bugs | 33 | USD 2.16 |
| 2026-11-26 18:24 | finding-verifier | claude-opus-5-5 | Verify layer 2 audit findings | 24 | USD 1.00 |
| 2026-11-26 18:29 | test-writer | claude-sonnet-5-5 | Round 2: tests for audit fixes | 66 | USD 2.15 |
| 2026-11-26 18:43 | implementer | claude-sonnet-5-5 | Round 2: apply audit fixes | 117 | USD 2.51 |
| 2026-11-26 18:57 | docs-keeper | claude-sonnet-5-5 | Sync docs for layer 2 | 44 | USD 2.20 |

### Extra rounds

Launches of a role after its first, such as a second test-writer after the audit.

| Role | Launches | Extra | Cost of the extra rounds |
|---|---|---|---|
| test-writer | 2 | 1 | USD 2.15 |
| implementer | 2 | 1 | USD 2.51 |

### Check against Claude Code's own estimate

Claude Code writes its own running estimate of a session's cost into the transcript; it can be older than the transcript's last call.

- 01fa8889: the session spans several loops, so it is not compared.

Generated by `.claude/metrics/usage-report.mjs` on 2026-11-26 21:57 UTC from the Claude Code transcripts.
<!-- usage-report:end -->
