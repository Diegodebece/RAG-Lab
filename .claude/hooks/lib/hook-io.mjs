// Input and output of a Claude Code PreToolUse hook: the tool call arrives as JSON on stdin, and the decision
// leaves as JSON on stdout. Exiting without output lets the call go on to the normal permission check.

export const readInput = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const decide = (decision, reason) => {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason
        }
    }));
    process.exit(0);
};

export const deny = (reason) => decide("deny", reason);

// "ask" forces a permission prompt, so the owner approves the call even in auto mode.
export const ask = (reason) => decide("ask", reason);

export const allow = () => process.exit(0);

// Runs a hook body; any unexpected error denies the call instead of letting it through.
export const runHook = async (body) => {
    let input;
    try {
        input = await readInput();
    } catch {
        deny("The tool call could not be read by the hook.");
    }
    try {
        await body(input);
    } catch (error) {
        deny(`The hook failed (${error instanceof Error ? error.message : String(error)}), so the call is blocked.`);
    }
    allow();
};
