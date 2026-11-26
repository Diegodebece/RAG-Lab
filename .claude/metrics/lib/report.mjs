// Summaries and markdown for the process reports in docs/process/. They hold numbers, roles and the agents'
// descriptions only: never a path, a user folder, a session title or the text of a message.

import { priceCall } from "./pricing.mjs";

const STEPS = {
    "orchestrator": "orchestration",
    "planner": "plan",
    "test-writer": "tests",
    "implementer": "code",
    "code-auditor": "audit",
    "owasp-auditor": "audit",
    "finding-verifier": "verification",
    "docs-keeper": "docs",
    "experiment-runner": "experiment",
    "lab-reporter": "experiment",
    "analyst": "experiment"
};

// How far Claude Code's own estimate may be from this report's before the report points it out.
const CROSS_CHECK_TOLERANCE = 0.05;

const emptyTotals = () => ({ calls: 0, input: 0, output: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, cost: 0, complete: true });

const addCall = (totals, call, priced) => {
    totals.calls++;
    totals.input += call.input;
    totals.output += call.output;
    totals.thinking += call.thinking;
    totals.cacheWrite += call.cacheWrite5m + call.cacheWrite1h;
    totals.cacheRead += call.cacheRead;
    totals.cost += priced.cost ?? 0;
    totals.complete &&= priced.complete;
};

const byTimestamp = (a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

export const summarizeBucket = ({ calls, attributions, bucket, prices, costStates = {} }) => {
    const priced = new Map(calls.map((call) => [call.id, priceCall(call, prices)]));
    const inBucket = calls.filter((call) => attributions.get(call.id)?.bucket === bucket).sort(byTimestamp);
    const totals = emptyTotals();
    const roles = new Map();
    const models = new Map();
    const agents = new Map();
    const noteCounts = new Map();

    for (const call of inBucket) {
        const price = priced.get(call.id);
        addCall(totals, call, price);
        for (const note of price.notes) {
            noteCounts.set(note, (noteCounts.get(note) ?? 0) + 1);
        }
        const role = roles.get(call.role) ?? { role: call.role, step: STEPS[call.role] ?? "other", agentIds: new Set(), ...emptyTotals() };
        addCall(role, call, price);
        if (call.agentId) {
            role.agentIds.add(call.agentId);
        }
        roles.set(call.role, role);
        const model = models.get(call.model) ?? { model: call.model, ...emptyTotals() };
        addCall(model, call, price);
        models.set(call.model, model);
        if (call.agentId) {
            const agent = agents.get(call.agentId) ?? {
                agentId: call.agentId, role: call.role, description: call.agentDescription, model: call.model, start: call.timestamp, calls: 0, cost: 0
            };
            agent.calls++;
            agent.cost += price.cost ?? 0;
            agents.set(call.agentId, agent);
        }
    }

    const share = (cost) => (totals.cost > 0 ? cost / totals.cost : 0);
    const byCost = (a, b) => b.cost - a.cost;
    const byRole = [...roles.values()].map(({ agentIds, ...role }) => ({ ...role, launches: agentIds.size, share: share(role.cost) })).sort(byCost);
    const byModel = [...models.values()].map((model) => ({ ...model, share: share(model.cost) })).sort(byCost);
    const agentList = [...agents.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    const extraRounds = [];
    for (const role of byRole) {
        const launched = agentList.filter((agent) => agent.role === role.role);
        if (launched.length > 1) {
            const extra = launched.slice(1);
            extraRounds.push({ role: role.role, launches: launched.length, extra: extra.length, extraCost: extra.reduce((sum, agent) => sum + agent.cost, 0) });
        }
    }

    // A call belongs to the session that made it (its sessionId; an agent's calls carry the session that launched
    // it), not to the side or resumed sessions whose transcripts copied it.
    const sessions = [...new Set(inBucket.map((call) => call.sessionId))].sort();
    const crossCheck = [];
    for (const session of sessions) {
        const estimate = costStates[session];
        if (!estimate) {
            continue;
        }
        const ofSession = calls.filter((call) => call.sessionId === session);
        if (ofSession.some((call) => attributions.get(call.id)?.bucket !== bucket)) {
            crossCheck.push({ session, spans: true });
            continue;
        }
        const ours = ofSession.reduce((sum, call) => sum + (priced.get(call.id).cost ?? 0), 0);
        const difference = estimate.totalCostUSD > 0 ? (ours - estimate.totalCostUSD) / estimate.totalCostUSD : null;
        crossCheck.push({
            session, ours, claudeCode: estimate.totalCostUSD, difference,
            flagged: difference === null || Math.abs(difference) > CROSS_CHECK_TOLERANCE
        });
    }

    const notes = [...noteCounts].map(([note, count]) => `${note} (${count} call${count === 1 ? "" : "s"})`);
    return {
        bucket, totals, byRole, byModel, agents: agentList, extraRounds, crossCheck, sessions, notes,
        from: inBucket[0]?.timestamp ?? null, to: inBucket.at(-1)?.timestamp ?? null
    };
};

const number = (value) => value.toLocaleString("en-US");
const money = (value) => `$${value.toFixed(2)}`;
const percent = (value) => `${Math.round(value * 100)} %`;
const shortId = (id) => String(id).slice(0, 8);
const minute = (timestamp) => (timestamp ? timestamp.slice(0, 16).replace("T", " ") : "");

// Forms of a path that can name a private folder or a user: a drive letter, a backslash (Windows and UNC paths),
// a home folder (~/), a Git Bash drive (/c/) and the users' folders (/Users/, /home/).
const PATH_PATTERN = /[A-Za-z]:[\\/]|\\|~[\\/]|(^|[\s("'`])\/[A-Za-z]\/|\/(Users|home)\//i;
const HIDDEN_DESCRIPTION = "(hidden: it named a path)";

// An agent's description, written by the orchestrator. One that names a path is hidden whole, because a path with
// spaces cannot be cut out reliably; table pipes are escaped.
const safeText = (text) => {
    const value = String(text ?? "").replace(/\r?\n/g, " ");
    return PATH_PATTERN.test(value) ? HIDDEN_DESCRIPTION : value.replace(/\|/g, "\\|");
};

// A role or model id comes from the transcripts, which a model wrote: only a plain name is printed.
const safeName = (name) => (/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(String(name ?? "")) ? name : "(invalid name)");

export const renderUsageSection = (summary, { prices, pr, generatedAt, withoutPullRequest = false }) => {
    const { totals } = summary;
    const status = withoutPullRequest ? "work without a pull request" : "no pull request merged yet";
    const loop = pr ? `PR #${pr}, \`${summary.bucket}\`` : `\`${summary.bucket}\` (${status})`;
    const lines = [
        "## Usage and cost",
        "",
        `${loop}: ${number(totals.calls)} model calls from ${minute(summary.from)} to ${minute(summary.to)} UTC, in ${summary.sessions.length} session${summary.sessions.length === 1 ? "" : "s"} (${summary.sessions.map(shortId).join(", ") || "none"}).`,
        "",
        `**API-equivalent cost: ${money(totals.cost)}**: what these tokens would cost on the Claude API at the prices of ${prices.pricesAsOf}; a subscription plan bills differently.`
    ];
    if (!totals.complete) {
        // a note names the model, which comes from the transcripts
        lines.push("", `**The cost is incomplete**: ${summary.notes.map(safeText).join("; ")}.`);
    }
    lines.push(
        "",
        "| Role | Step | Launches | Calls | Input | Output (thinking) | Cache write | Cache read | Cost | Share |",
        "|---|---|---|---|---|---|---|---|---|---|",
        ...summary.byRole.map((row) =>
            `| ${safeName(row.role)} | ${row.step} | ${row.launches} | ${number(row.calls)} | ${number(row.input)} | ${number(row.output)} (${number(row.thinking)}) | ${number(row.cacheWrite)} | ${number(row.cacheRead)} | ${money(row.cost)} | ${percent(row.share)} |`),
        "",
        "### By model",
        "",
        "| Model | Calls | Output | Cache read | Cost | Share |",
        "|---|---|---|---|---|---|",
        ...summary.byModel.map((row) => `| ${safeName(row.model)} | ${number(row.calls)} | ${number(row.output)} | ${number(row.cacheRead)} | ${money(row.cost)} | ${percent(row.share)} |`),
        "",
        "### Agents",
        ""
    );
    if (summary.agents.length === 0) {
        lines.push("No agent ran in this loop.");
    } else {
        lines.push(
            "| Start (UTC) | Role | Model | Description | Calls | Cost |",
            "|---|---|---|---|---|---|",
            ...summary.agents.map((agent) =>
                `| ${minute(agent.start)} | ${safeName(agent.role)} | ${safeName(agent.model)} | ${safeText(agent.description)} | ${number(agent.calls)} | ${money(agent.cost)} |`)
        );
    }
    lines.push("", "### Extra rounds", "");
    if (summary.extraRounds.length === 0) {
        lines.push("None: every role ran once.");
    } else {
        lines.push(
            "Launches of a role after its first, such as a second test-writer after the audit.",
            "",
            "| Role | Launches | Extra | Cost of the extra rounds |",
            "|---|---|---|---|",
            ...summary.extraRounds.map((row) => `| ${safeName(row.role)} | ${row.launches} | ${row.extra} | ${money(row.extraCost)} |`)
        );
    }
    lines.push("", "### Check against Claude Code's own estimate", "");
    if (summary.crossCheck.length === 0) {
        lines.push("No session of this loop has a cost estimate from Claude Code.");
    } else {
        lines.push("Claude Code writes its own running estimate of a session's cost into the transcript; it can be older than the transcript's last call.", "");
        for (const check of summary.crossCheck) {
            if (check.spans) {
                lines.push(`- ${shortId(check.session)}: the session spans several loops, so it is not compared.`);
            } else {
                const difference = check.difference === null ? "" : ` (${check.difference >= 0 ? "+" : ""}${percent(check.difference)})`;
                const flag = check.flagged ? ` **More than ${percent(CROSS_CHECK_TOLERANCE)} apart.**` : "";
                lines.push(`- ${shortId(check.session)}: this report ${money(check.ours)}, Claude Code ${money(check.claudeCode)}${difference}.${flag}`);
            }
        }
    }
    lines.push("", `Generated by \`.claude/metrics/usage-report.mjs\` on ${minute(generatedAt)} UTC from the Claude Code transcripts.`);
    return lines.join("\n");
};

const TEMPLATE = (title) => [
    title,
    "",
    "> Written by the orchestrator, except the part between the usage-report markers, which `node .claude/metrics/usage-report.mjs report` generates.",
    "",
    "## Decisions the AI took without asking",
    "",
    "## Plan against what was done",
    "",
    "## Findings funnel",
    "",
    "| Stage | Findings |",
    "|---|---|",
    "| code-auditor | |",
    "| owasp-auditor | |",
    "| confirmed by the finding-verifier | |",
    "| fixed | |",
    "| deferred | |",
    "",
    "## Test quality",
    "",
    "## Rework",
    ""
].join("\n");

// Puts `section` between the <!-- name:start --> and <!-- name:end --> markers, keeping the rest of the file.
export const replaceBetweenMarkers = (existing, section, { name, title = "# Process report" }) => {
    const start = `<!-- ${name}:start -->`;
    const end = `<!-- ${name}:end -->`;
    const block = `${start}\n${section}\n${end}`;
    if (existing === null || existing === undefined) {
        return `${TEMPLATE(title)}\n${block}\n`;
    }
    const startIndex = existing.indexOf(start);
    const endIndex = existing.indexOf(end);
    if (startIndex !== -1 && endIndex > startIndex) {
        return existing.slice(0, startIndex) + block + existing.slice(endIndex + end.length);
    }
    return `${existing.trimEnd()}\n\n${block}\n`;
};

// One row per loop, in the order they started: { bucket, pr, from, calls, output, cacheRead, cost, complete, orchestratorShare }.
export const renderSummaryTable = (rows) => {
    const sorted = [...rows].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    return [
        "| Loop | Started (UTC) | Calls | Output | Cache read | API-equivalent cost | Orchestrator share |",
        "|---|---|---|---|---|---|---|",
        ...sorted.map((row) => {
            const loop = row.pr ? `#${row.pr} \`${row.bucket}\`` : `\`${row.bucket}\``;
            const cost = `${money(row.cost)}${row.complete ? "" : " (incomplete)"}`;
            return `| ${loop} | ${minute(row.from)} | ${number(row.calls)} | ${number(row.output)} | ${number(row.cacheRead)} | ${cost} | ${percent(row.orchestratorShare)} |`;
        })
    ].join("\n");
};
