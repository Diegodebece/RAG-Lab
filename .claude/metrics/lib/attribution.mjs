// Which loop (pull request) each model call belongs to.
//
// A loop runs from its begin marker (`usage-report.mjs begin <branch>`) to the merge of its branch. Rules, first
// match wins; an agent is decided once, at its first call, and all its calls follow:
//   1. override:agent    overrides.agents[agentId]
//   2. override:session  overrides.sessions[sessionId]
//   3. session           the latest begin marker of the call's session, while that loop is open
//   4. override:window   one of overrides.windows contains the call's time
//   5. time              one loop's window contains it
// When several windows contain the time, the worktree the call ran in (.claude/worktrees/<name>) decides
// ("+cwd"); otherwise the call is "ambiguous". Outside every window it is "unattributed". Nothing is forced.

const isBefore = (a, b) => a < b;

const contains = (window, time) => !isBefore(time, window.from) && (window.to === null || isBefore(time, window.to));

// The pull request merges of the history: lines of "<hash>\t<ISO date>\t<subject>".
export const parseMerges = (gitLog) => {
    const merges = [];
    for (const line of gitLog.split(/\r?\n/)) {
        const [, date, subject] = line.split("\t");
        const match = subject?.match(/^Merge pull request #(\d+) from [^/\s]+\/(\S+)$/);
        if (match) {
            merges.push({ pr: Number(match[1]), branch: match[2], mergedAt: new Date(date).toISOString() });
        }
    }
    return merges;
};

// A time in UTC ISO form, so times compare as text; an invalid one is refused, never guessed.
const utc = (value, what) => {
    const time = new Date(value);
    if (typeof value !== "string" || Number.isNaN(time.getTime())) {
        throw new Error(`Invalid time in ${what}: ${JSON.stringify(value)}`);
    }
    return time.toISOString();
};

// One window per run of a branch: from its first begin marker to the first merge after it. A begin marker after
// that merge (the branch name used again) starts a new window.
export const buildWindows = ({ markers, merges, overrides }) => {
    const beginsByBranch = new Map();
    for (const marker of markers) {
        if (marker.type === "begin") {
            const list = beginsByBranch.get(marker.branch) ?? [];
            list.push(utc(marker.at, `the begin marker of ${marker.branch}`));
            beginsByBranch.set(marker.branch, list);
        }
    }
    const windows = [];
    for (const [branch, begins] of beginsByBranch) {
        const mergesOfBranch = merges
            .filter((merge) => merge.branch === branch)
            .map((merge) => ({ ...merge, mergedAt: utc(merge.mergedAt, `the merge of ${branch}`) }))
            .sort((a, b) => (isBefore(a.mergedAt, b.mergedAt) ? -1 : 1));
        let current = null;
        for (const at of begins.sort()) {
            if (current && (current.to === null || isBefore(at, current.to))) {
                continue;
            }
            const merge = mergesOfBranch.find((candidate) => isBefore(at, candidate.mergedAt));
            current = { bucket: branch, from: at, to: merge?.mergedAt ?? null, pr: merge?.pr ?? null, source: "marker" };
            windows.push(current);
        }
    }
    for (const window of overrides.windows ?? []) {
        windows.push({
            bucket: window.bucket,
            from: utc(window.from, `the override window of ${window.bucket}`),
            to: window.to === undefined || window.to === null ? null : utc(window.to, `the override window of ${window.bucket}`),
            pr: window.pr ?? null,
            source: "override"
        });
    }
    return windows.sort((a, b) => (isBefore(a.from, b.from) ? -1 : isBefore(b.from, a.from) ? 1 : 0));
};

// The pull request a loop was merged in: the one of its latest window, so a branch name used again does not
// inherit an old number.
export const pullRequestOf = (bucket, windows) => windows.filter((window) => window.bucket === bucket).at(-1)?.pr ?? null;

// Pairs of loops that were open at the same time, as [earlier, later] bucket names.
export const findOverlaps = (windows) => {
    const pairs = [];
    for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
            const [a, b] = [windows[i], windows[j]];
            const aBeforeEndOfB = b.to === null || isBefore(a.from, b.to);
            const bBeforeEndOfA = a.to === null || isBefore(b.from, a.to);
            if (aBeforeEndOfB && bBeforeEndOfA) {
                pairs.push([a.bucket, b.bucket]);
            }
        }
    }
    return pairs;
};

const worktreeName = (cwd) => cwd?.match(/^\.claude\/worktrees\/([^/]+)/i)?.[1]?.toLowerCase() ?? null;

const pickWindow = (candidates, call, rule) => {
    if (candidates.length === 1) {
        return { bucket: candidates[0].bucket, rule, candidates: [] };
    }
    const name = worktreeName(call.cwd);
    const byWorktree = name === null ? [] : candidates.filter((window) => {
        const bucket = window.bucket.toLowerCase();
        return bucket === name || bucket.endsWith(`/${name}`);
    });
    if (byWorktree.length === 1) {
        return { bucket: byWorktree[0].bucket, rule: `${rule}+cwd`, candidates: [] };
    }
    return { bucket: null, rule: "ambiguous", candidates: [...new Set(candidates.map((window) => window.bucket))].sort() };
};

const decide = (call, { windows, markers, overrides }) => {
    if (call.agentId && overrides.agents?.[call.agentId]) {
        return { bucket: overrides.agents[call.agentId], rule: "override:agent", candidates: [] };
    }
    if (overrides.sessions?.[call.sessionId]) {
        return { bucket: overrides.sessions[call.sessionId], rule: "override:session", candidates: [] };
    }
    const sessionMarker = markers
        .filter((marker) => marker.type === "begin" && marker.sessionId === call.sessionId)
        .map((marker) => ({ ...marker, at: utc(marker.at, `the begin marker of ${marker.branch}`) }))
        .filter((marker) => !isBefore(call.timestamp, marker.at))
        .sort((a, b) => (isBefore(a.at, b.at) ? -1 : 1))
        .at(-1);
    if (sessionMarker) {
        const window = windows.find((candidate) =>
            candidate.source === "marker" && candidate.bucket === sessionMarker.branch && contains(candidate, call.timestamp));
        if (window) {
            return { bucket: window.bucket, rule: "session", candidates: [] };
        }
    }
    const open = windows.filter((window) => contains(window, call.timestamp));
    const overrideWindows = open.filter((window) => window.source === "override");
    if (overrideWindows.length > 0) {
        return pickWindow(overrideWindows, call, "override:window");
    }
    if (open.length > 0) {
        return pickWindow(open, call, "time");
    }
    return { bucket: null, rule: "unattributed", candidates: [] };
};

// Map of call id to { bucket, rule, candidates }.
export const attribute = (calls, context) => {
    const firstOfAgent = new Map();
    for (const call of calls) {
        if (call.agentId) {
            const first = firstOfAgent.get(call.agentId);
            if (!first || isBefore(call.timestamp, first.timestamp)) {
                firstOfAgent.set(call.agentId, call);
            }
        }
    }
    const agentDecisions = new Map();
    for (const [agentId, first] of firstOfAgent) {
        agentDecisions.set(agentId, decide(first, context));
    }
    return new Map(calls.map((call) => [call.id, call.agentId ? agentDecisions.get(call.agentId) : decide(call, context)]));
};
