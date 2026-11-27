# PR #8: feature/documents

Layer 4, Documents and indexes. It adds:

- **Documents** per user: plain text sent as JSON by the client, sanitized and stored with its line breaks.
- **Indexes**: one index per chunk size and embedding model. Each holds RAG Web's chunks and 1024-dimension vectors from `qwen3-embedding:0.6b`, stored in batches of 10 with `truncate: false`.
- **A persisted queue** in the `document_indexes` rows, claimed with `FOR UPDATE SKIP LOCKED`. One in-process worker, started after the database check, makes one Ollama request at a time through the model turn.
- **A failure policy**: a failed batch probes `GET /api/tags`, and the result decides between re-queueing and counting an attempt.
- **Cancellation** by deleting the index or the document.
- **Build caps**, checked under the user-row lock plus an advisory lock, and column grants for the API role.

The owner approved the plan on 2026-11-27. They took the planner's recommendations for its 16 open decisions, with these changes:

- **D3:** `MAX_DOCUMENT_CHARACTERS` defaults to 1,000,000, with a maximum of 5,000,000.
- **D10:** a global daily cap was added, `MAX_INDEX_BUILDS_PER_DAY_TOTAL`, default 100.
- **D15:** the owner wants a 1-day document lifetime later; it is revisited in layer 13.

This loop closes deferred finding O7 and RAG Web's F10, answers the design's open question on build caps (section 12), and closes the process report of PR #7.

The full feature loop ran in this order:

1. planner;
2. test-writer;
3. implementer;
4. code-auditor and owasp-auditor, in parallel;
5. finding-verifier;
6. a second round of test-writer and implementer, for the findings the owner approved;
7. docs-keeper.

The owner asked for the branch to be pushed and opens the pull request on their own.

## Decisions the AI took without asking

| Who | Decision | Where | How to revert |
|---|---|---|---|
| orchestrator | Session 4b883490 of PR #7 (a fork the owner opened to ask about the plan) stays in layer 3: no override | `docs/process/07-configuration.md` | Add an override |
| orchestrator | The worktree uses the main checkout's `node_modules` through a junction (local only, not committed) | `.claude/worktrees/documents/node_modules` | Delete the junction |
| orchestrator | Wrote the layer 4 lines of `.env.example` itself, and later corrected the wording of `MAX_QUEUED_INDEX_BUILDS` (it counts waiting builds only, audit F7) | `.env.example` | Revert the commits |
| orchestrator | Deleted a comment-only scratch folder the test-writer left (`test/tmp-plan/`) | — | — |
| orchestrator | Restored a missing space in the error middleware's declaration, left by the round-2 implementer | `src/v1/middlewares/error.middleware.ts` | — |
| orchestrator | Briefed the docs-keeper to write the owner's chat message about O4 ("avoid prompt injection at all costs") into the design as a requirement of layer 6 | `docs/design.md` section 13, `docs/project-guide.md` section 9 | Revert the docs commit |
| orchestrator | Checked `docs/api/openapi.yaml` with a throwaway script (tabs, indentation, duplicate keys, `$ref` targets: 212 resolved) instead of a YAML parser, which is not installed | — | — |
| docs-keeper | Put the layer 4 guide section at number 11, after the process section, so the references to section 9 in earlier process reports stay right | `docs/project-guide.md` | Renumber and fix the reports |
| docs-keeper | Listed the test-only `RAG_LAB_LIVE_OLLAMA_URL` in `.env.example`, commented out | `.env.example` | Remove the line |
| test-writer | The cap pre-check is observed through a wrapper on the API's `pool.query` (no statement reading `text`), because an ES export such as `chunkText` cannot be spied on | `test/routes/documentIndexes.test.ts` | — |
| test-writer | The index-creation rate limit has its own counter, separate from uploads | `test/routes/documentIndexLimits.test.ts` | Reverse the two "separate" tests |
| test-writer | A database error while storing a batch leaves the index `indexing` for the stuck-build requeue: no probe, no attempt, not failed | `test/services/indexingQueueDatabase.test.ts` | — |
| test-writer | After the third probed timeout the index fails with the generic "Indexing failed" | `test/services/indexingQueueTimeout.test.ts` | — |
| implementer | The failure classification of a build: which errors fail at once, which probe, and which are logged | `src/v1/services/indexing.service.ts` | — |
| implementer | An index whose embedding model is no longer allowed fails with "The embedding model of this index is no longer allowed" | `indexing.service.ts` | — |
| implementer | Deleting an index removes the row first and then aborts the running request; locks are taken user row first, then the advisory lock; an existing index answers 200 right after the user lock | `documentIndexes.service.ts`, `documents.service.ts` | — |
| implementer | A text that is too long after cleaning is a 400 "Validation error" | `documents.service.ts` | — |
| implementer | Round 2: a `ModelTimeoutError` class (still a 504 with the same message) instead of checking the status | `src/v1/utils/modelTimeoutError.util.ts` | — |
| implementer | Round 2: a shared `describeError` util (name, code, message) for every log of an unexpected error, not only the middleware; a thrown value that is not an `Error` is logged as its type only | `src/v1/utils/describeError.util.ts` | Log in place |
| implementer | Round 2: the wake flag is cleared before each claim and read only after an empty claim, so a wake during a re-queued build does not restart the loop | `indexingQueue.service.ts` | — |

## Plan against what was done

- **Built as planned:** everything in the approved plan, with the owner's changes to D3, D10 and D15.
- **Migrations:** 006, 007 and 008 were written as planned. One index was added beyond the plan, `index_build_usage_accepted_at_idx`, for the global daily count.
- **Not in the plan, from the audit** (approved by the owner as one list):
  - a lock-free cap pre-check before the text is read and chunked;
  - a per-user rate limit on index creation, with the `UPLOAD_REQUESTS_PER_MINUTE` value and no new variable;
  - the index row locked first when a batch is stored (no deadlock with a delete);
  - database errors kept apart from model errors;
  - a broken `/api/tags` answer counted as an attempt;
  - a body cut mid-read counted as unavailable, not malformed;
  - disabled users' builds skipped;
  - the float4 range check on vectors;
  - the wake flag;
  - logs without error details;
  - the dead export removed.
- **Approved change to D8 (O2):** a timeout no longer fails the index at once. It probes Ollama like the other failures.
- **O4, deferred to layer 6 and the owner's top priority:** invisible characters in stored text, which can hide instructions. Filtering them on storage would break composed emoji and scripts such as Persian. So the design now requires layer 6 to filter them when the prompt is built, fence each chunk as data, and instruct the model that document text is never instructions.
- **Model download:** the tests use the fake Ollama double, so no model was downloaded. The live embedding test (`test/integration/ollamaEmbed.live.test.ts`) runs only when `RAG_LAB_LIVE_OLLAMA_URL` is set. It did not run in this loop, so F9 stays open until the owner runs it.
- **No shell for the docs-keeper:** it could not parse `docs/api/openapi.yaml`, so the orchestrator ran a structural check instead (not a full YAML parse).
- **Found by the docs-keeper, left open:**
  - Two logs outside the scope of F12 still write a whole error object: the startup schema check in `src/server.ts` and a failing event listener in `events.service.ts`. Both run only at startup or on a listener bug.
  - A disabled user's queued indexes still count toward `MAX_QUEUED_INDEX_BUILDS`.
  - In `POST /documents`, the lock-free pre-check covers only the documents cap; the build caps are checked once, under the locks.
- **Commit trailers:** the agents' trailers lost their angle brackets (the hook refuses `<` and `>`). The orchestrator fixed them before the push.
- **Usage part:** regenerated after the merge, in the next loop, with no override (`windows` showed no ambiguous calls). The orchestrator session's calls after the merge fall outside every loop window and stay unattributed, as the rules say.

## Findings funnel

| Stage | Findings |
|---|---|
| code-auditor | 13. 2 medium: a deadlock between storing a batch and deleting the index; index creation reads and chunks the whole text before any cap. 7 low: a cut body counted as malformed; database errors and a broken probe counted as model attempts; vectors outside float4; locks held across large inserts; the `.env.example` wording of the queue cap; a lost wake; 5000-character chunks with `truncate: false`. 4 info: a delete between claim and abort; the probe outside the model turn; whole database errors in the log; an upload answering 404 after its document was stored. Plus 4 test notes (T1–T4) |
| owasp-auditor | 14. 1 medium (O1, the same as F2). 4 low: a timeout fails at once and spends the daily cap; Ollama bodies read without a size limit; invisible characters kept in stored text; the model identified by name, not digest. 9 info (I1–I9) |
| distinct findings | 24, plus the 4 test notes. Duplicates: F2 = O1, F7 = I5, F12 = I9 |
| finding-verifier | 3 refuted as defects: F11, I7, T3. F1 lowered from medium to low. The rest confirmed or partly confirmed |
| fixed | 11 in round 2 (F1, F2/O1, F3, F4, F5, F7/I5, F8, F12/I9, O2, I3, I4), plus stronger tests (T1, T4). Each code fix has a test that failed first |
| deferred | O4 and I1 (layer 6; I1 possibly layer 11), I2 and I6 (layer 10), F6, O3 and O5 (layer 13), F9 (pending the owner's live test; if confirmed, an evaluated value for E1) |
| no action | F10, F13, I8, T2 |

## Test quality

- **Round 1:**
  - The layer 4 tests were written first: 15 new files and 15 changed ones. The fake Ollama double gained embeddings, held requests and recorded requests.
  - They were red only for the missing feature.
  - After the implementation, the suite went from 755 to 1069 tests, all passing.
- **Round 2:**
  - 47 tests added (46 net: the old "a timeout fails at once" test was replaced by 7).
  - 40 were red because their fix was missing. The test-writer checked each failure message.
  - 7 guards already passed and were kept: the fake double's two new answers, a non-JSON `/api/tags` body as malformed, the float4 boundary accepted, the `instanceof` checks, the separate upload counter, and the pre-check's positive control.
  - Final: 1115 tests, all passing, plus a clean typecheck, both run by the orchestrator.
- **Limits:**
  - The deadlock test forces one dangerous interleaving with a trigger and an advisory lock, not every interleaving.
  - The wake test depends on the 10-second poll interval.
  - The pre-check test proves the text is not read, not that `chunkText` is not called.
- **Runner output:** neither the test-writer nor the implementer could read the full `npm test` output, because it moved to the background. Both ran the suite in groups and reported the counts that way.

## Rework

- A second round of the test-writer and the implementer, caused by the audit (11 approved fixes).
- **Shared test database:** the round-1 implementer collided with its own background suite by running a database group at the same time. It ran again cleanly. Rule kept for later briefs: never two database runs at once.
- **Invisible character:** the round-1 implementer copied a literal U+FEFF from RAG Web's `sanitizeText`, caught it in its scan, and replaced it with `String.fromCodePoint(0xfeff)`.
- No other role ran twice.

<!-- usage-report:start -->
## Usage and cost

PR #8, `feature/documents`: 554 model calls from 2026-11-27 14:10 to 2026-11-27 18:05 UTC, in 1 session (ef8c43d0).

**API-equivalent cost: USD 33.79**: what these tokens would cost on the Claude API at the prices of 2026-11-03; a subscription plan bills differently.

| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
| test-writer | tests | 2 | 157 | 314 | 290,475 (114,803) | 696,051 | 36,248,717 | USD 8.27 | 24 % |
| orchestrator | orchestration | 0 | 84 | 198 | 91,430 (18,996) | 254,736 | 13,969,776 | USD 6.66 | 20 % |
| implementer | code | 2 | 138 | 278 | 133,381 (50,703) | 488,130 | 27,186,789 | USD 5.27 | 16 % |
| planner | plan | 1 | 43 | 86 | 112,993 (80,224) | 302,844 | 6,925,086 | USD 5.16 | 15 % |
| docs-keeper | docs | 1 | 52 | 104 | 100,344 (13,624) | 292,841 | 10,360,151 | USD 2.77 | 8 % |
| code-auditor | audit | 1 | 31 | 62 | 52,577 (40,666) | 152,116 | 2,596,829 | USD 2.33 | 7 % |
| owasp-auditor | audit | 1 | 29 | 58 | 44,552 (30,095) | 128,895 | 2,270,917 | USD 1.99 | 6 % |
| finding-verifier | verification | 1 | 20 | 40 | 30,425 (18,865) | 93,934 | 1,279,547 | USD 1.33 | 4 % |

### By model

| Model | Calls | Output | Cache read | Cost | Share |
|---|---|---|---|---|---|
| claude-opus-5-5 | 207 | 331,977 | 27,042,155 | USD 17.48 | 52 % |
| claude-sonnet-5-5 | 347 | 524,200 | 73,795,657 | USD 16.32 | 48 % |

### Agents

| Start (UTC) | Role | Model | Description | Calls | Cost |
|---|---|---|---|---|---|
| 2026-11-27 14:14 | planner | claude-opus-5-5 | Plan layer 4: documents and indexes | 43 | USD 5.16 |
| 2026-11-27 14:55 | test-writer | claude-sonnet-5-5 | Write layer 4 tests first | 82 | USD 5.67 |
| 2026-11-27 15:20 | implementer | claude-sonnet-5-5 | Implement layer 4 documents and indexes | 92 | USD 4.33 |
| 2026-11-27 15:51 | code-auditor | claude-opus-5-5 | Audit layer 4 code for bugs | 31 | USD 2.33 |
| 2026-11-27 15:51 | owasp-auditor | claude-opus-5-5 | OWASP audit of layer 4 | 29 | USD 1.99 |
| 2026-11-27 16:02 | finding-verifier | claude-opus-5-5 | Verify layer 4 audit findings | 20 | USD 1.33 |
| 2026-11-27 17:15 | test-writer | claude-sonnet-5-5 | Round 2: tests for layer 4 fixes | 75 | USD 2.60 |
| 2026-11-27 17:35 | implementer | claude-sonnet-5-5 | Round 2: apply layer 4 fixes | 46 | USD 0.94 |
| 2026-11-27 17:53 | docs-keeper | claude-sonnet-5-5 | Sync docs for layer 4 | 52 | USD 2.77 |

### Extra rounds

Launches of a role after its first, such as a second test-writer after the audit.

| Role | Launches | Extra | Cost of the extra rounds |
|---|---|---|---|
| test-writer | 2 | 1 | USD 2.60 |
| implementer | 2 | 1 | USD 0.94 |

### Check against Claude Code's own estimate

No session of this loop has a cost estimate from Claude Code.

Generated by `.claude/metrics/usage-report.mjs` on 2026-11-27 19:08 UTC from the Claude Code transcripts.
<!-- usage-report:end -->
