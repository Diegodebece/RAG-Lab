# PR #4: feature/token-metrics

The process-metrics loop: a dependency-free script that turns the Claude Code transcripts into usage and API-equivalent cost per pull request, the process reports in `docs/process/`, the backfill of the setup, pull requests #1 and #2 and layer 1, and two hook changes that keep the agents away from the usage records. Plan approved by the owner on 2026-11-26 with the orchestrator's recommendations for its nine open decisions; the backfill windows were confirmed by the owner before the reports were written.

The orchestrator wrote the script, its tests and the hook changes itself, as with the hooks: no agent may write `.claude/`. The auditors read only the application code, so the review was done by a fresh read-only agent that got the code and the specification, not the author's explanations.

## Decisions the AI took without asking

| Who | Decision | Where | How to revert |
|---|---|---|---|
| orchestrator | After the review: path components lose trailing dots and spaces, and a component with a colon (an alternate data stream) is denied, because Windows reads `usage.` or `usage::$INDEX_ALLOCATION` as `usage`. This also tightens the older rules: `.env::$DATA` was readable before | `.claude/hooks/agent-scope.mjs` (`partsBelow`) | Drop the normalization; the bypass returns |
| orchestrator | No role may Glob the root of the data folder either (the plan said Grep), because a Glob there lists the names of the transcript copies | `agent-scope.mjs` (`isReadableDataPath`) | Allow Glob at the root |
| orchestrator | An existing hook test changed from "analyst may Grep the whole data folder" to "may not": that Grep also read the data folder's `.env` | `.claude/hooks/tests/agent-scope.test.mjs` | — |
| orchestrator | An agent description that names a path in any form is hidden whole in the reports (cutting a path with spaces out is not reliable) | `.claude/metrics/lib/report.mjs` | Print descriptions as they are |
| orchestrator | `begin` refuses to guess the session when more than one session changed in the last 10 minutes; it asks for `--session` | `.claude/metrics/usage-report.mjs` | Take the newest |
| orchestrator | The rows of one message carry the same usage today (0 of 641 messages differ), but the script takes the largest count of each field in case a row is ever written mid-answer | `.claude/metrics/lib/transcripts.mjs` | Take the first row |
| orchestrator | Merges are read from `main` and `origin/main`, because the owner merges on GitHub | `usage-report.mjs` | Local `main` only |
| orchestrator | Claude Code's own running estimate is shown next to each session that lies inside one loop, as a reference, and never corrects the report | `report.mjs` | Remove the section |
| orchestrator | `.gitignore` ignores `*.jsonl` and `*.jsonl.gz`, so a transcript or a usage record copied into the repository by mistake is not committed | `.gitignore` | Remove the two lines |
| orchestrator | The invisible-character test also scans `.claude/metrics/` | `test/repository/invisibleCharacters.test.ts` | — |
| orchestrator | The worktree uses the main checkout's `node_modules` through a junction (same lockfile, nothing installed); local only, not committed | `.claude/worktrees/token-metrics/node_modules` | Delete the junction |

## Plan against what was done

- Everything in the approved plan was built: the script and its five commands, the price table, the copies of the transcripts, the reports and the summary, the backfill, the hook changes, and the changes to `CLAUDE.md`, the design, the guide and the README.
- The owner's `cleanupPeriodDays` was raised to 365 (decision D6).
- Found while building and not in the plan:
  - `thinking_tokens` is inside `output_tokens`, so it is shown apart but not charged twice.
  - Side sessions copy their parent's calls, and those keep the parent's session id: the comparison with Claude Code's estimate groups calls by the session that made them. Before that fix one side session showed +947 %.
  - Claude Code's estimate is higher than the transcripts in every session compared (−10 %, −24 %, −91 % for this report against it). A likely cause is calls Claude Code makes for itself that are not written as assistant rows (session titles, the permission classifier); not verified.
- Two messages sent in the layer 1 session at 16:10 and 16:12 UTC, while this loop was open, fall into this loop by time (2 calls, USD 0.32): another session active during a loop is counted in it unless an override moves it. They stay here; their content was not read.
- In layer 1 "one loop at a time" did not hold (pull requests #1 and #2 overlapped it). The owner confirmed the rule is there so that costs do not run away, and attribution now handles overlaps instead of relying on the rule.

## Findings funnel

| Stage | Findings |
|---|---|
| independent review (fresh read-only agent) | 10: 1 high (Windows path forms got around the hook), 4 medium (stored records lost what deleted transcripts held; window times with an offset compared as text; the first row of a message supplied its usage; paths with spaces, `/c/`, `~/` and UNC forms passed into the reports), 1 low-medium (`begin` could record another session), 4 low (a `null` line crashed `collect`; role and model printed unescaped; Glob listed the names in `usage/`; merges only from the local `main`, reused branch names) |
| checked by the orchestrator | 9 confirmed; 1 not a bug today (the rows of a message never differ in the 641 messages read), hardened anyway |
| fixed | 10, each with a test that failed first |
| deferred | 0 |
| found by the orchestrator on real data | 3: the setup report said "not merged yet"; side sessions inflated the comparison; `windows` repeated a loop once per window |

## Test quality

- Written first and seen failing: the metrics tests (the modules did not exist), 4 hook tests (215 old ones passing), and the invisible-character test with a planted character, which passed before `.claude/metrics/` was added to its folders.
- The review found weak tests, all strengthened: the privacy test used only simple paths; the `begin` test had a single session, so any choice passed; the deduplication helper assumed identical rows; the merge test checked only the good direction.
- Metrics tests: 0 → 74. Hook tests: 215 → 220. The tests build synthetic transcripts in a temporary folder and never read real ones.

## Rework

- One round of fixes after the review, done by the orchestrator. No agent ran twice; the usage part below lists the reviewer and the docs-keeper.

<!-- usage-report:start -->
## Usage and cost

PR #4, `feature/token-metrics`: 150 model calls from 2026-11-26 15:31 to 2026-11-26 16:26 UTC, in 2 sessions (33b63d13, d7737c32).

**API-equivalent cost: USD 16.57**: what these tokens would cost on the Claude API at the prices of 2026-11-03; a subscription plan bills differently.

| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |
|---|---|---|---|---|---|---|---|---|---|
| orchestrator | orchestration | 0 | 118 | 250 | 193,036 (65,911) | 380,529 | 35,575,810 | USD 14.02 | 85 % |
| general-purpose | other | 1 | 23 | 48 | 33,829 (19,998) | 210,766 | 2,934,160 | USD 2.32 | 14 % |
| docs-keeper | docs | 1 | 9 | 18 | 9,973 (325) | 42,684 | 234,092 | USD 0.23 | 1 % |

### By model

| Model | Calls | Output | Cache read | Cost | Share |
|---|---|---|---|---|---|
| claude-opus-5-5 | 141 | 226,865 | 38,509,970 | USD 16.34 | 99 % |
| claude-sonnet-5-5 | 9 | 9,973 | 234,092 | USD 0.23 | 1 % |

### Agents

| Start (UTC) | Role | Model | Description | Calls | Cost |
|---|---|---|---|---|---|
| 2026-11-26 16:03 | general-purpose | claude-opus-5-5 | Independent review of metrics script | 23 | USD 2.32 |
| 2026-11-26 16:17 | docs-keeper | claude-sonnet-5-5 | Sync docs for token metrics | 9 | USD 0.23 |

### Extra rounds

None: every role ran once.

### Check against Claude Code's own estimate

Claude Code writes its own running estimate of a session's cost into the transcript; it can be older than the transcript's last call.

- d7737c32: the session spans several loops, so it is not compared.

Generated by `.claude/metrics/usage-report.mjs` on 2026-11-26 16:30 UTC from the Claude Code transcripts.
<!-- usage-report:end -->
