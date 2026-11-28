# feature/retrieval

Layer 5, the retrieval endpoint. It adds:

- **Search:** `POST /v1/documents/{id}/search` embeds the question with `qwen3-embedding:0.6b` through the shared model turn. It then searches the ready index of the resolved chunk size with exact cosine distance, and returns the matches with their ±1/±2 neighbours. It never builds an index: an index that is missing or not ready is a 409.
- **Runs** (migration 009): a `runs` table that stores what ran, and an insert-only `question_usage` table. A run holds the configuration snapshot and its hash, an HMAC of the question, the fragments without their text, the tokens and the timings. The daily cap counts the usage table.
- **Question caps:**
  - 10 questions per minute, counted before the body is read;
  - 30 a day;
  - one at a time per user;
  - 60 s per question, waiting included;
  - 20 waiting for the model, all users together.
- **Resolve** takes an optional `documentId` and returns the state of its index.
- **The retrieval-only harness**, `npm run eval:retrieval`:
  - it reads the sets and documents from `RAG_LAB_DATA_DIR`;
  - it uploads the documents through the API as a harness account, reusing them by content hash;
  - it reports recall@k, rank, hit, full and context@k, and p50/p95;
  - its results go only to the private data folder.
- **Log fixes:** the startup schema check, the event listener, `createAdmin`, `migrate` and the pool now log `describeError`, never whole error objects.
- **D9(b):** a disabled user's queued builds no longer count toward `MAX_QUEUED_INDEX_BUILDS`.

The owner approved the plan on 2026-11-27, with every recommendation for the 17 open decisions (D1–D17). For D15, the orchestrator extracted the shape of the evaluation sets: keys and types only, never values. The model digests (D2) are deferred to layer 13.

This loop also closed the process report of PR #8.

The full feature loop ran in this order:

1. planner;
2. test-writer;
3. implementer;
4. code-auditor and owasp-auditor, in parallel;
5. finding-verifier;
6. a second round of test-writer and implementer, for the list of findings the owner approved;
7. docs-keeper.

The owner asked for the branch to be pushed and opens the pull request on their own.

## Decisions the AI took without asking

| Who | Decision | Where | How to revert |
|---|---|---|---|
| orchestrator | The worktree uses the main checkout's `node_modules` through a junction (local only, not committed) | `.claude/worktrees/retrieval/node_modules` | Delete the junction |
| orchestrator | Ran the full suite in the worktree, not on main, after each round | — | — |
| orchestrator | Added the owner-approval notes to the untracked plan (§9) and the round-2 list (§10). They set the data layout (`eval\documents\<name>.txt`, `eval\sets\<name>.json`), several evidence passages per case, what the loader refuses, and that a usage row stays when the run is not stored (F4, F5) | `layer-5-plan.md` (not committed) | — |
| orchestrator | Extracted the evaluation set shape with a script that prints keys, types and lengths, never values | scratchpad only | — |
| orchestrator | Wrote the layer 5 lines of `.env.example` and the `eval:retrieval` script | `.env.example`, `package.json` | Revert the commit |
| orchestrator | Fixed two round-1 tests: the counter test asked for a second index size while the first was queued, and `testSetup` lacked the four new caps | `test/routes/searchRateLimit.test.ts`, `test/db/testSetup.test.ts` | Revert the commits |
| orchestrator | Deleted two scratch test files the test-writer left (`test/scratchCosine.test.ts`, `test/scratchProbe.test.ts`) | — | — |
| orchestrator | Fixed the stale `waitMs` comment the docs-keeper reported | `src/v1/types/runs.type.ts` | Revert the commit |
| test-writer | The `runs` CHECK also refuses a configuration without `kind`; the planned CHECK let NULL through | `migrations/009_runs.sql` | — |
| test-writer | Invented the harness contracts that the plan left open (exit codes, the manifest, the summary keys, the preflight messages), stated in the headers of `test/eval/*` | `test/eval/` | — |
| test-writer | Round 2: the exact error messages of F4, F8 and F5; the usage table's shape; the F2 check before anything is made below a link; a malformed model answer left unpinned | round-2 test files | — |
| implementer | Round 1: about 20 choices. Among them: `migrate.ts` logs the cause too; the retrieval-mode switch sits in `toQueryText`; `started()` and `release()` are idempotent; the order of the checks; how the timings are measured; the harness cleans the text with `sanitizeText` until it is stable; the upload uses the first sweep size; the summary is keyed `contextAtK[window][k]`; an extra flag `--build-timeout-minutes` (default 60) | `src/v1/services/`, `src/eval/` | — |
| implementer | Round 2: a malformed model answer writes no usage row, like a 503 | `runs.service.ts` | — |
| implementer | Round 2: the 250 ms floor is a constant (`MIN_MODEL_CALL_MS`), not an `.env` setting | `limits.config.ts` | — |
| implementer | Round 2: the question hash is computed before admission, so a missing `SECRET_KEY` fails before anything is counted | `runs.service.ts` | — |
| implementer | Round 2: the F4 re-check does not compare index ids. An index deleted and rebuilt at the same size during the wait gives `no_match` | `runs.service.ts` | Compare the ids |
| implementer | Round 2: the controller still calls the service for a closed client, with the signal already aborted, so the existing cancel path ends it | `runs.controller.ts` | — |
| docs-keeper | Labelled the layer 5 deferred findings as their own list in §9, because I2, O3 and O5 repeat layer 4 names | `docs/project-guide.md` | — |
| docs-keeper | Documented no 403 for the search: the route has no role check, and a disabled account gets 401 | `docs/api/openapi.yaml` | — |

## Plan against what was done

- **Built as planned:** everything in the approved plan, D1–D17.
- **Migrations:** 009 only. After the audit it also holds `question_usage`, because 009 was not merged yet.
- **Changed by the audit (round 2, approved by the owner as one list):**
  - F6 changes D5: the daily cap counts the embeddings in `question_usage`, not the stored runs, so hanging up during the embedding no longer gives free model turns;
  - F7: the question limiter is keyed by user id alone;
  - F4: a search that races a deletion is refused (404/409) and no run is stored;
  - F1 and F2: the harness refuses a data folder inside any git checkout, and links out of it;
  - F3: NaN guards in the SQL and in `buildFragments`;
  - O5: token counts are capped at 2^31-1;
  - F8: a 250 ms floor before calling the model;
  - F9: a closed socket is detected at the controller;
  - F5: the deadline is checked before the insert;
  - I5: the harness does not retry a 504;
  - T3: the log scan is wider;
  - F11: an HMAC question hash;
  - the comments of the harness output are corrected.
- **Differences from the round-2 list:**
  - O5 answers the existing generic 500, not the 502 the list said: a malformed model answer has always been a 500.
  - T3 needed no source change: nothing in `src/` uses the newly scanned calls.
- **D12, the HNSW measurement:** recorded in the design as the plan states it. The harness has not run yet, because the evaluation documents are not yet in `RAG_LAB_DATA_DIR`.
- **Model download:** the tests use the fake Ollama double. No model was downloaded, and the harness was not run against a real Ollama.
- **No shell for the docs-keeper:** it worked from the plan and the code files, without `git diff`.
- **`gh auth status`** failed at the start of the loop: the GitHub CLI is not logged in. The push uses git alone.
- **Commit trailers:** the agents' trailers lost their angle brackets, because the hook refuses `<` and `>`. The orchestrator fixed them before the push.

## Findings funnel

| Stage | Findings |
|---|---|
| code-auditor | 11. 1 medium: F1, the harness checks only the worktree, not the checkout around it. 1 medium/low: F2, links in the data folder. 6 low: F3 NaN scores; F4 the deletion race; F5 the deadline after the embedding; F6 hanging up during the embedding is not counted; F7 logout resets the limiter; F8 almost no time left. 3 info: F9, F10, F11. Plus 5 test notes (T1–T5) |
| owasp-auditor | 5 findings (O1–O5) and 10 notes (I1–I10) |
| distinct findings | 16, plus the test notes and the notes. Duplicates: O2 = F6 + F7, O4 = F11, I1 = F10, I6 = F5 |
| finding-verifier | Nothing above low. F1 lowered to low. F3 is info (NaN mostly not produced the way the auditor described). F7 has a narrower fix (the question limiter only). O1 is a design limit. I7 is uncertain (no frontend yet). I8 does not apply |
| fixed | 13 in round 2: F1, F2, F3, F4, F5, F6, F7, F8, F9, F11, O5 (the token count), I5 and the harness comments. Plus T1, T2, T3 and T5. Each code fix has a test that failed first |
| deferred | O1 (layer 10); O3 and the O5 body size (layer 13); the turn released on cancel (layer 6); I3 (layers 11 and 13) |
| documented, no code | F10, I2, I7, I10 |

## Test quality

- **Round 1:**
  - The layer 5 tests were written first: 35 files, including the new `test/eval/` folder for the harness and changes to 14 existing files.
  - They were red only for the missing feature.
  - Two of them were wrong and were fixed by the orchestrator (see the decisions).
  - After the implementation, the suite went from 1115 to 1441 tests, all passing.
- **Round 2:**
  - 62 tests added.
  - Each fix was red first, for its own reason, and the test-writer checked each failure message.
  - Some guards already passed and were kept: the links that point inside the data folder, `.github` and `.gitignore` not counted as a checkout, 2147483647 accepted, the same question giving the same hash, and the route-level 500 for a huge token count.
  - The wider log scan was shown to fail with the old pattern by restoring it for a moment.
  - The NaN case was checked against the test database's pgvector 0.8.7 before it was written down.
- **Final:** 1503 tests, all passing, plus a clean typecheck and build, all run by the orchestrator.
- **Limits:**
  - The F8 test depends on timing: it releases the turn about 800 ms into a 1000 ms deadline, which leaves about 175 ms.
  - The F5 test slows the matches query by wrapping `pool.query`.
  - The F9 test uses stand-in request and response objects, not a real socket.
- **Runner output:** neither agent could read the full `npm test` output, because it moved to the background. Both ran the tests by group, and the orchestrator ran the full suite.

## Rework

- A second round of the test-writer and the implementer, caused by the audit (15 items on the approved list).
- Two round-1 tests were fixed by the orchestrator instead of sending them back.
- A gap in the plan, a CHECK that let NULL through, was caught by the test-writer before any code existed.
- No role ran twice for any other reason.

<!-- usage-report:start -->
## Usage and cost

`feature/retrieval` (no pull request merged yet): 672 model calls from 2026-11-27 19:08 to 2026-11-28 00:22 UTC, in 1 session (335e66b9).

**API-equivalent cost: USD 40.37**: what these tokens would cost on the Claude API at the prices of 2026-11-03; a subscription plan bills differently.

| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
| test-writer | tests | 2 | 207 | 414 | 363,399 (152,261) | 909,534 | 60,088,740 | USD 11.92 | 30 % |
| planner | plan | 1 | 53 | 106 | 141,092 (106,315) | 387,179 | 11,382,695 | USD 7.03 | 17 % |
| implementer | code | 2 | 162 | 324 | 171,658 (61,661) | 628,924 | 32,453,955 | USD 6.53 | 16 % |
| orchestrator | orchestration | 0 | 90 | 206 | 64,261 (16,181) | 242,627 | 14,890,749 | USD 6.21 | 15 % |
| code-auditor | audit | 1 | 33 | 66 | 45,162 (33,296) | 206,384 | 3,503,727 | USD 2.64 | 7 % |
| owasp-auditor | audit | 1 | 40 | 80 | 41,548 (23,890) | 173,256 | 3,834,584 | USD 2.46 | 6 % |
| docs-keeper | docs | 1 | 55 | 110 | 67,229 (6,983) | 256,153 | 9,446,875 | USD 2.26 | 6 % |
| finding-verifier | verification | 1 | 32 | 64 | 23,983 (12,237) | 92,175 | 1,897,649 | USD 1.32 | 3 % |

### By model

| Model | Calls | Output | Cache read | Cost | Share |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | 424 | 602,286 | 101,989,570 | USD 20.71 | 51 % |
| claude-opus-5-5 | 248 | 316,046 | 35,509,404 | USD 19.66 | 49 % |

### Agents

| Start (UTC) | Role | Model | Description | Calls | Cost |
|---|---|---|---|---|---|
| 2026-11-27 19:11 | planner | claude-opus-5-5 | Plan layer 5: retrieval endpoint | 53 | USD 7.03 |
| 2026-11-27 19:48 | test-writer | claude-sonnet-5-5 | Write layer 5 tests first | 113 | USD 8.19 |
| 2026-11-27 20:23 | implementer | claude-sonnet-5-5 | Implement layer 5 retrieval | 98 | USD 5.15 |
| 2026-11-27 20:45 | owasp-auditor | claude-opus-5-5 | OWASP audit of layer 5 | 40 | USD 2.46 |
| 2026-11-27 20:45 | code-auditor | claude-opus-5-5 | Audit layer 5 code for bugs | 33 | USD 2.64 |
| 2026-11-27 20:54 | finding-verifier | claude-opus-5-5 | Verify layer 5 audit findings | 32 | USD 1.32 |
| 2026-11-27 23:47 | test-writer | claude-sonnet-5-5 | Round-2 tests for layer 5 | 94 | USD 3.73 |
| 2026-11-28 00:01 | implementer | claude-sonnet-5-5 | Round-2 fixes for layer 5 | 64 | USD 1.38 |
| 2026-11-28 00:14 | docs-keeper | claude-sonnet-5-5 | Document layer 5 | 55 | USD 2.26 |

### Extra rounds

Launches of a role after its first, such as a second test-writer after the audit.

| Role | Launches | Extra | Cost of the extra rounds |
|---|---|---|---|
| test-writer | 2 | 1 | USD 3.73 |
| implementer | 2 | 1 | USD 1.38 |

### Check against Claude Code's own estimate

No session of this loop has a cost estimate from Claude Code.

Generated by `.claude/metrics/usage-report.mjs` on 2026-11-28 00:24 UTC from the Claude Code transcripts.
<!-- usage-report:end -->
