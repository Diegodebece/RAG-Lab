# PR #7: feature/configuration

Layer 3, Configuration as data: the version-1 settings (11 keys) with their value caps in code, a read-only default profile seeded by a migration with RAG Web's evaluated values, named profiles per user (sparse, at most 20, unique names regardless of case), a resolver that merges default, profile and overrides by known keys, validates once and returns a frozen snapshot with its SHA-256 hash, and a startup check of the stored configuration. Plan approved by the owner on 2026-11-27 with the planner's recommendations for its 15 open decisions; the owner confirmed D2 (`answerMode` is a setting, default `baseline`) on its own first. The design's open question on playground caps (section 12) is partly decided (D14). This loop also closes the process report of PR #6.

The full feature loop ran: planner, test-writer, implementer, code-auditor and owasp-auditor in parallel, finding-verifier, a second round of test-writer and implementer for the findings the owner approved, and docs-keeper. The owner asked for the branch to be pushed and opens the pull request on their own.

## Decisions the AI took without asking

| Who | Decision | Where | How to revert |
|---|---|---|---|
| orchestrator | Fixed `test/db/users.test.ts` (`TRUNCATE users` without `CASCADE`, broken by the new foreign key) itself instead of a third test-writer launch | `test/db/users.test.ts` | Revert the commit |
| orchestrator | The worktree uses the main checkout's `node_modules` through a junction (local only, not committed) | `.claude/worktrees/configuration/node_modules` | Delete the junction |
| orchestrator | Worded the round-2 messages "This profile was saved by another configuration version" (409) and "Name must contain a letter, number, symbol or punctuation"; a profile at another version is a 500 on resolve | round-2 brief | Change the messages |
| orchestrator | Wrote the six filler characters of the profile name rule as `\u` escapes instead of raw characters (the docs-keeper pointed out a reader cannot see them; same behaviour) | `src/v1/validators/profiles.validator.ts` | Revert the commit |
| orchestrator | Fixed the stale guide reference in report 06 (deferred findings are now guide section 9) | `docs/process/06-accounts.md` | — |
| orchestrator | Added a repository test that every variable read in `src/` is in `.env.example` (round 2) | `test/repository/envExample.test.ts` | Delete the test |
| test-writer | Named the exports the plan left open (`resolveConfigurationSchema`, `createProfileSchema`, `updateProfileSchema`) and added a fixtures file | `test/configurationFixtures.ts` | — |
| implementer | A Joi extension with a `prepare` hook to see an own `__proto__` key before Joi's copy drops it; in round 2 it renames the key to an internal stand-in so the rest is still validated | `src/v1/validators/configuration.validator.ts` | — |
| implementer | Creating a profile for a user row that vanished is 404 "User not found" | `src/v1/services/profiles.service.ts` | — |
| implementer | Singular startup message for one profile; the 64-character cut of echoed keys counts code points | `configuration.service.ts`, `unknownSetting.util.ts` | — |
| implementer | The resolver also reports unknown override keys; a broken default is logged by the resolver and again by `errorMiddleware` | `configuration.service.ts` | Log once |
| implementer | No `AND version = ...` in the profile UPDATE (only a hand edit could change the version between check and update) | `profiles.service.ts` | Add the condition |

## Plan against what was done

- Everything in the approved plan was built, with the owner's recommendations for D1 to D15.
- Not in the plan, from the audit (approved by the owner as one list): the UUID rule of resolve, the 1000 maximum of `MAX_PROFILES_PER_USER`, the version guard while running, a broken default answered as 500, the stricter name rule, column grants on `profiles`, echoed keys cut to 64 characters, `__proto__` no longer hiding other problems, sparse arrays refused by `toCanonicalJson`, stronger tests.
- Migration 005 was changed in place for the column grants (it was never on `main`), not by a migration 006.
- The first test-writer launch ran from the main checkout: the hook kept it out of the worktree, it changed nothing and stopped. The orchestrator moved its session into the worktree and launched it again.
- The docs-keeper copied the new code into skill templates (`configuration.service.ts`, `configurationSnapshot.util.ts`, `unknownSetting.util.ts`, `configuration.validator.ts`, `configuration.config.ts`, `configuration.type.ts`, migrations 004 and 005) and described the profile service and name rule in prose. It has no shell, so `docs/api/openapi.yaml` was not parsed by a tool in this loop (no YAML parser is installed).
- The agents' commit trailers lost their angle brackets (the hook refuses `<` and `>`); the orchestrator fixed them before the push.

## Findings funnel

| Stage | Findings |
|---|---|
| code-auditor | 12: 6 low (version guard defeated while running; resolve's UUID rule; broken default answered as the user's 400; look-alike or blank names; the row lock on profile creation; `.env.example` missing a setting), 6 info (`__proto__` hiding other errors; sparse arrays; "never rounded" comment; ZWJ emoji refused; weak tests; full UPDATE on `profiles`) |
| owasp-auditor | 7: 2 medium (no cap on the combination of topK, neighbors and chunk size; settings that would force escalation), 2 low (logout and login reset the per-user counter; CORS open by default), 3 info (unkeyed hash; echoed keys; index settings in overrides), plus 2 notes |
| distinct findings | 19 |
| finding-verifier | 1 refuted (the row lock); 7 confirmed or partly confirmed for this layer's code; 11 confirmed only for later layers or as info |
| fixed | 10 in round 2 (F1, F2, F3, F4, F6, F7, F8, F9, F12, O6) plus stronger tests (F11), each with a test that failed first except F9 (a comment) and F11 |
| deferred | O1 (layer 6), O2 (layer 8), O3 (layer 10), O4 (layer 5), O5 (layers 11 and 13), O7 (layer 4), the role check of `default_profile` privileges, top-level unknown fields echoed whole, ZWJ names (documented trade-off) |

## Test quality

- Layer-3 tests written first: 17 files, red only for the missing feature; the test-writer could not read a single full `npm test` run (it went to the background) and reported by groups.
- One test it missed (`TRUNCATE users` without `CASCADE`) failed only after the migration existed; the implementer found it and stopped.
- After the first implementation: 674 passing. After the second round: 755 tests, all passing once `.env.example` gained its line.
- The auditors found weak tests (startup messages matched with `/default/i` against all output; blank-name cases checked by status only; a mounted-route check that a wrong handler would pass; timing-dependent race tests); the first two were tightened in round 2.
- Round-2 tests that passed before the fix, kept as guards: reads of a profile at another version, the 400 for bad stored profiles and overrides, ZWJ names refused, VS16 and accents accepted, the API's own update of the four columns.

## Rework

- Second round of the test-writer and the implementer, caused by the audit (10 approved fixes).
- One extra test-writer launch that did nothing (wrong working folder).
- No other role ran twice.

<!-- usage-report:start -->
## Usage and cost

`feature/configuration` (no pull request merged yet): 476 model calls from 2026-11-26 21:58 to 2026-11-27 05:18 UTC, in 2 sessions (4b883490, a974fcf7).

**API-equivalent cost: USD 27.29**: what these tokens would cost on the Claude API at the prices of 2026-11-03; a subscription plan bills differently.

| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
| orchestrator | orchestration | 0 | 64 | 174 | 75,373 (11,492) | 404,444 | 14,195,314 | USD 7.58 | 28 % |
| test-writer | tests | 3 | 135 | 272 | 189,352 (65,662) | 532,870 | 21,905,034 | USD 5.42 | 20 % |
| planner | plan | 1 | 32 | 64 | 96,707 (70,040) | 395,470 | 3,710,436 | USD 4.65 | 17 % |
| implementer | code | 2 | 121 | 244 | 93,729 (41,739) | 359,008 | 15,727,058 | USD 3.41 | 12 % |
| code-auditor | audit | 1 | 39 | 78 | 42,649 (30,568) | 145,901 | 3,202,792 | USD 2.22 | 8 % |
| docs-keeper | docs | 1 | 38 | 76 | 59,483 (5,711) | 200,544 | 4,945,982 | USD 1.59 | 6 % |
| owasp-auditor | audit | 1 | 26 | 52 | 30,082 (16,614) | 125,323 | 1,629,625 | USD 1.55 | 6 % |
| finding-verifier | verification | 1 | 21 | 42 | 16,524 (7,633) | 69,756 | 883,231 | USD 0.86 | 3 % |

### By model

| Model | Calls | Output | Cache read | Cost | Share |
|---|---|---|---|---|---|
| claude-opus-5-5 | 182 | 261,335 | 23,621,398 | USD 16.87 | 62 % |
| claude-sonnet-5-5 | 294 | 342,564 | 42,578,074 | USD 10.42 | 38 % |

### Agents

| Start (UTC) | Role | Model | Description | Calls | Cost |
|---|---|---|---|---|---|
| 2026-11-26 21:59 | planner | claude-opus-5-5 | Plan layer 3: configuration as data | 32 | USD 4.65 |
| 2026-11-27 03:41 | test-writer | claude-sonnet-5-5 | Write layer 3 tests first | 7 | USD 0.13 |
| 2026-11-27 03:42 | test-writer | claude-sonnet-5-5 | Write layer 3 tests first | 75 | USD 3.25 |
| 2026-11-27 04:04 | implementer | claude-sonnet-5-5 | Implement layer 3 configuration | 68 | USD 2.21 |
| 2026-11-27 04:27 | owasp-auditor | claude-opus-5-5 | OWASP audit of layer 3 | 26 | USD 1.55 |
| 2026-11-27 04:27 | code-auditor | claude-opus-5-5 | Audit layer 3 code for bugs | 39 | USD 2.22 |
| 2026-11-27 04:36 | finding-verifier | claude-opus-5-5 | Verify layer 3 audit findings | 21 | USD 0.86 |
| 2026-11-27 04:43 | test-writer | claude-sonnet-5-5 | Round 2: tests for audit fixes | 53 | USD 2.04 |
| 2026-11-27 04:53 | implementer | claude-sonnet-5-5 | Round 2: apply audit fixes | 53 | USD 1.20 |
| 2026-11-27 05:07 | docs-keeper | claude-sonnet-5-5 | Sync docs for layer 3 | 38 | USD 1.59 |

### Extra rounds

Launches of a role after its first, such as a second test-writer after the audit.

| Role | Launches | Extra | Cost of the extra rounds |
|---|---|---|---|
| test-writer | 3 | 2 | USD 5.28 |
| implementer | 2 | 1 | USD 1.20 |

### Check against Claude Code's own estimate

Claude Code writes its own running estimate of a session's cost into the transcript; it can be older than the transcript's last call.

- 4b883490: this report USD 1.19, Claude Code USD 1.25 (-4 %).
- a974fcf7: the session spans several loops, so it is not compared.

Generated by `.claude/metrics/usage-report.mjs` on 2026-11-27 05:18 UTC from the Claude Code transcripts.
<!-- usage-report:end -->
