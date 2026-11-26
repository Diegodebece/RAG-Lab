// A small, conservative parser for the shell commands that the Bash and PowerShell tools run. It is not a full
// shell grammar: it splits a command into simple commands at every operator either shell uses, so a guard can
// look at each one. When in doubt it splits more, never less.

// Operators that end a simple command in Bash or PowerShell, longest first.
const SEPARATORS = ["&&", "||", "$(", ";", "|", "&", "\n", "\r", "`", "(", ")", "{", "}"];

// Programs that run their quoted argument as another command line.
const LAUNCHERS = new Set([
    "bash", "sh", "zsh", "dash", "cmd", "powershell", "pwsh", "iex", "invoke-expression", "eval",
    "start-process", "wsl", "xargs", "env", "sudo"
]);

// The program a token names, also when written as a path or with a Windows extension:
// `C:\Program Files\Git\cmd\git.exe` -> "git".
export const programName = (token) =>
    token.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

// Splits a command line into simple commands. Each one is a list of tokens { text, quoted }; quotes are removed
// and a quoted part joins the unquoted text next to it (`--message="a b"` is one token).
const splitOnce = (command) => {
    const segments = [];
    let tokens = [];
    let text = "";
    let quoted = false;
    let inToken = false;

    const endToken = () => {
        if (inToken) {
            tokens.push({ text, quoted });
        }
        text = "";
        quoted = false;
        inToken = false;
    };
    const endSegment = () => {
        endToken();
        if (tokens.length > 0) {
            segments.push(tokens);
        }
        tokens = [];
    };

    let index = 0;
    while (index < command.length) {
        const char = command[index];

        if (char === "'" || char === "\"") {
            let end = index + 1;
            while (end < command.length && command[end] !== char) {
                // Bash escapes a double quote inside double quotes with a backslash
                end += char === "\"" && command[end] === "\\" ? 2 : 1;
            }
            text += command.slice(index + 1, end).replace(/\\"/g, "\"");
            quoted = true;
            inToken = true;
            index = end + 1;
            continue;
        }

        const separator = SEPARATORS.find((candidate) => command.startsWith(candidate, index));
        if (separator) {
            endSegment();
            index += separator.length;
            continue;
        }

        if (/\s/.test(char)) {
            endToken();
        } else {
            text += char;
            inToken = true;
        }
        index++;
    }

    endSegment();
    return segments;
};

// Splits a command line into simple commands, and also parses the quoted arguments of programs that run them
// as commands (`bash -c "git push"`, `powershell -Command "..."`), recursively.
export const splitCommands = (command, depth = 0) => {
    const segments = splitOnce(command);

    if (depth >= 3) {
        return segments;
    }

    const nested = [];
    for (const tokens of segments) {
        const launcherIndex = tokens.findIndex((token) => LAUNCHERS.has(programName(token.text)));
        if (launcherIndex === -1) {
            continue;
        }
        for (const token of tokens.slice(launcherIndex + 1)) {
            if (token.quoted) {
                nested.push(...splitCommands(token.text, depth + 1));
            }
        }
    }

    return [...segments, ...nested];
};

// The index of the first token that names one of the programs, or -1.
export const findProgram = (tokens, names) =>
    tokens.findIndex((token) => names.has(programName(token.text)));
