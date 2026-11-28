import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// No error object goes to the log. console.error(message, error) prints the whole object, and an error from the database carries
// the failing statement, its parameters and the row (which can be the text of a document) in its fields. What the log gets is a
// string: written out, or made by describeError(error), which is the name, the code and the message of the error and nothing more.
//
// The rule, for every call of console.error, console.warn, console.log, console.info, console.debug, console.trace, console.dir,
// process.stdout.write and process.stderr.write in the .ts files of src/: it takes exactly one
// argument, and that argument is a string literal, a template literal, a describeError(...) call, or several of those joined with +.
// (A template literal may interpolate whatever it likes: it is already text.) A reference to one of the four that is not a call, such
// as `.catch(console.error)`, is refused too: it would hand the error object to the log. And describeError is defined in one place,
// utils/describeError.util.ts: a second copy was the one in server.ts that printed only the message.
const ROOT = path.join(import.meta.dirname, "..", "..");

const listSourceFiles = async (folder: string): Promise<string[]> => {
    const files: string[] = [];
    const entries: Dirent[] = await readdir(folder, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(folder, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await listSourceFiles(full)));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            files.push(full);
        }
    }

    return files;
};

// ---- a small reader of TypeScript text: enough to cut the arguments of a call, no more ----

// the index just after the string that starts at `start` ("..." or '...'), reading backslash escapes
const afterQuoted = (source: string, start: number): number => {
    const quote = source[start];
    let position = start + 1;

    while (position < source.length && source[position] !== quote) {
        position += source[position] === "\\" ? 2 : 1;
    }

    return position + 1;
};

// the index just after the `${ ... }` expression whose opening brace was read, at `start` (the first character inside it)
const afterInterpolation = (source: string, start: number): number => {
    let braces = 1;
    let position = start;

    while (position < source.length && braces > 0) {
        const character = source[position];

        if (character === "\"" || character === "'") {
            position = afterQuoted(source, position);
        } else if (character === "`") {
            position = afterTemplate(source, position);
        } else {
            braces += character === "{" ? 1 : character === "}" ? -1 : 0;
            position += 1;
        }
    }

    return position;
};

// the index just after the template literal that starts at `start`, with the expressions inside it
const afterTemplate = (source: string, start: number): number => {
    let position = start + 1;

    while (position < source.length && source[position] !== "`") {
        if (source[position] === "\\") {
            position += 2;
        } else if (source[position] === "$" && source[position + 1] === "{") {
            position = afterInterpolation(source, position + 2);
        } else {
            position += 1;
        }
    }

    return position + 1;
};

// The text of each argument of the call whose "(" is at `open`, cut at the commas outside every bracket, string and template; and
// the index just after the closing ")". A trailing comma is not an argument.
const readCall = (source: string, open: number): { args: string[]; end: number } => {
    const args: string[] = [];
    let depth = 0;
    let start = open + 1;
    let position = open + 1;

    while (position < source.length) {
        const character = source[position];

        if (character === "\"" || character === "'") {
            position = afterQuoted(source, position);
        } else if (character === "`") {
            position = afterTemplate(source, position);
        } else if (character === "/" && source[position + 1] === "/") {
            position = source.indexOf("\n", position) === -1 ? source.length : source.indexOf("\n", position);
        } else if (character === "/" && source[position + 1] === "*") {
            position = source.indexOf("*/", position) === -1 ? source.length : source.indexOf("*/", position) + 2;
        } else if (character === "(" || character === "[" || character === "{") {
            depth += 1;
            position += 1;
        } else if (character === ")" || character === "]" || character === "}") {
            if (depth === 0) {
                const last = source.slice(start, position);

                if (last.trim() !== "" || args.length === 0) {
                    args.push(last);
                }

                return { args, end: position + 1 };
            }

            depth -= 1;
            position += 1;
        } else if (character === "," && depth === 0) {
            args.push(source.slice(start, position));
            start = position + 1;
            position += 1;
        } else {
            position += 1;
        }
    }

    return { args: [...args, source.slice(start)], end: source.length };
};

// the pieces of an expression joined by + outside every bracket, string and template
const splitOnPlus = (expression: string): string[] => {
    const pieces: string[] = [];
    let depth = 0;
    let start = 0;
    let position = 0;

    while (position < expression.length) {
        const character = expression[position];

        if (character === "\"" || character === "'") {
            position = afterQuoted(expression, position);
        } else if (character === "`") {
            position = afterTemplate(expression, position);
        } else {
            if (character === "(" || character === "[" || character === "{") {
                depth += 1;
            } else if (character === ")" || character === "]" || character === "}") {
                depth -= 1;
            } else if (character === "+" && depth === 0) {
                pieces.push(expression.slice(start, position));
                start = position + 1;
            }

            position += 1;
        }
    }

    pieces.push(expression.slice(start));
    return pieces.map((piece) => piece.trim());
};

const isStringLiteral = (piece: string): boolean => (piece.startsWith("\"") || piece.startsWith("'")) && afterQuoted(piece, 0) === piece.length;

const isTemplateLiteral = (piece: string): boolean => piece.startsWith("`") && afterTemplate(piece, 0) === piece.length;

// describeError( ... ) and nothing after the closing parenthesis
const isDescribeErrorCall = (piece: string): boolean => piece.startsWith("describeError(") && readCall(piece, "describeError".length).end === piece.length;

// the source with its comments replaced by spaces (line breaks kept, so the lines still count), so that a comment that talks about
// console.error(message, error) is not taken for a call
const blankComments = (source: string): string => {
    let output = "";
    let position = 0;

    while (position < source.length) {
        const character = source[position];
        let next = position + 1;

        if (character === "\"" || character === "'") {
            next = afterQuoted(source, position);
            output += source.slice(position, next);
        } else if (character === "`") {
            next = afterTemplate(source, position);
            output += source.slice(position, next);
        } else if (character === "/" && source[position + 1] === "/") {
            next = source.indexOf("\n", position) === -1 ? source.length : source.indexOf("\n", position);
            output += " ".repeat(next - position);
        } else if (character === "/" && source[position + 1] === "*") {
            next = source.indexOf("*/", position) === -1 ? source.length : source.indexOf("*/", position) + 2;
            output += source.slice(position, next).replace(/[^\n]/g, " ");
        } else {
            output += character;
        }

        position = next;
    }

    return output;
};

// whether an argument is text that cannot be an error object
const isTextArgument = (argument: string): boolean => {
    const pieces = splitOnPlus(argument);

    return pieces.every((piece) => isStringLiteral(piece) || isTemplateLiteral(piece) || isDescribeErrorCall(piece));
};

interface Problem {
    line: number;
    call: string;
    reason: string;
}

// Everything that writes to the log or to the terminal (finding T3 of round 2): the four console methods of the rule, the other ones that
// print what they are given (debug, trace, dir) and a direct write to the standard output or error. All of them follow the same rule.
const LOG_CALL = /\b(?:console\.(?:error|warn|log|info|debug|trace|dir)|process\.(?:stdout|stderr)\.write)\b/g;

// every use of those in the source that breaks the rule, and how many calls there were
const checkSource = (original: string): { problems: Problem[]; calls: number } => {
    const source = blankComments(original);
    const problems: Problem[] = [];
    let calls = 0;

    for (const found of source.matchAll(LOG_CALL)) {
        const line = source.slice(0, found.index).split("\n").length;
        const after = found.index + found[0].length;
        const next = source.slice(after).match(/^\s*\(/);

        if (!next) {
            problems.push({ line, call: found[0], reason: "used without calling it: it would be given the error object" });
            continue;
        }

        calls += 1;
        const { args, end } = readCall(source, after + next[0].length - 1);
        const call = source.slice(found.index, end).replace(/\s+/g, " ");

        if (args.length !== 1) {
            problems.push({ line, call, reason: `takes ${args.length} arguments, not one` });
        } else if (!isTextArgument(args[0])) {
            problems.push({ line, call, reason: "its argument is not a string literal, a template literal or a describeError(...) call" });
        }
    }

    return { problems, calls };
};

describe("the scan for error objects in the log: the scan itself", () => {
    it("accepts a string literal, a template literal with interpolations and a describeError call, each as the one argument", () => {
        const source = [
            "console.error(\"Cannot start: a, b (c)\");",
            "console.log('single quotes, with a \\' inside');",
            "console.warn(`Cannot start: ${describeError(error)}. Check ${a.b(\"x\", `n${1}`)} (the url).`);",
            "console.info(describeError(error));",
            "console.error(describeError(new Error(\"a, b\")));"
        ].join("\n");

        assert.deepEqual(checkSource(source), { problems: [], calls: 5 });
    });

    it("accepts several pieces joined with +, over several lines, when each is text", () => {
        const source = "console.error(\n    `Cannot start: ${problems.join(\"\\n- \")}\\n`\n    + \"Create the role (see the README).\"\n);";

        assert.deepEqual(checkSource(source), { problems: [], calls: 1 });
    });

    it("refuses a second argument that is an error object, whatever the first one is", () => {
        const { problems } = checkSource("console.error(\"Could not roll back\", rollbackError);\nconsole.error(`x`, error);");

        assert.deepEqual(problems.map((problem) => [problem.line, problem.reason]), [
            [1, "takes 2 arguments, not one"],
            [2, "takes 2 arguments, not one"]
        ]);
    });

    it("refuses an argument that is not text: an error object, a conditional that can be one, a variable, a call that is not describeError", () => {
        const { problems } = checkSource([
            "console.error(error);",
            "console.error(failure instanceof AppError ? `Could not: ${failure.message}` : failure);",
            "console.log(message);",
            "console.warn(String(error));",
            "console.error(describeError(error) + error);",
            "console.error(describeErrorLater(error));"
        ].join("\n"));

        assert.deepEqual(problems.map((problem) => problem.line), [1, 2, 3, 4, 5, 6]);
    });

    it("refuses a call with no argument and a console method that is passed around without being called", () => {
        const { problems } = checkSource("console.log();\npromise.catch(console.error);");

        assert.deepEqual(problems.map((problem) => problem.line), [1, 2]);
        assert.match(problems[1].reason, /without calling it/);
    });

    it("does not read a comma inside a string, a template, a call or a list as the end of the argument", () => {
        const source = "console.error(`a, ${[1, 2].join(\", \")} b, ${describeError(error)}`);\nconsole.error(\"a, b\" + \", c\");";

        assert.deepEqual(checkSource(source), { problems: [], calls: 2 });
    });

    it("does not take a comment that talks about a call for a call", () => {
        const source = "// console.error(message, error) prints the whole object\n/* console.log(error)\n   console.warn(a, b) */\nconsole.error(\"fine\"); // console.info(error)\n";

        assert.deepEqual(checkSource(source), { problems: [], calls: 1 });
    });

    // T3: the scan used to read four console methods only, so a debug, a trace, a dir or a direct write to a stream could print an error object
    it("reads console.debug, console.trace, console.dir, process.stdout.write and process.stderr.write like the other four", () => {
        const accepted = [
            "console.debug(\"text\");",
            "console.trace(`text ${describeError(error)}`);",
            "console.dir(describeError(error));",
            "process.stdout.write(\"a line\\n\");",
            "process.stderr.write(`text ${a}\\n`);"
        ].join("\n");

        assert.deepEqual(checkSource(accepted), { problems: [], calls: 5 });

        const { problems, calls } = checkSource([
            "console.debug(error);",
            "console.trace(\"a\", error);",
            "console.dir(error, { depth: 5 });",
            "process.stdout.write(JSON.stringify(error));",
            "process.stderr.write(error.stack);",
            "stream.on(\"error\", process.stderr.write);"
        ].join("\n"));

        assert.equal(calls, 5, "the sixth is not a call");
        assert.deepEqual(problems.map((problem) => problem.line), [1, 2, 3, 4, 5, 6]);
        assert.match(problems[5].reason, /without calling it/);
    });

    it("does not take a longer name that starts like one of them for a call: console.debugging, process.stdout.writer, and a stream of its own", () => {
        assert.deepEqual(checkSource("mylogger.console.debugging(x);\nthing.process.stdout.writer(y);\nconst out = streams.stdout.write(z);"), { problems: [], calls: 0 });
    });

    it("tells the line of each problem", () => {
        const { problems } = checkSource("const a = 1;\n\nconsole.error(\"fine\");\nconsole.error(\"bad\", error);\n");

        assert.deepEqual(problems.map((problem) => problem.line), [4]);
    });
});

describe("the log", () => {
    it("never gets an error object: every console call (error, warn, log, info, debug, trace, dir) and every write to stdout or stderr in src/ takes one argument that is text", async () => {
        const files = await listSourceFiles(path.join(ROOT, "src"));
        const problems: string[] = [];
        let calls = 0;

        // the scan found the files it is meant to read, so a pass is not a scan of nothing
        for (const expected of ["server.ts", "createAdmin.ts", "migrate.ts", "pool.config.ts", "events.service.ts", "error.middleware.ts", "indexing.service.ts"]) {
            assert.ok(files.some((file) => path.basename(file) === expected), `the scan did not find ${expected}`);
        }

        for (const file of files) {
            const checked = checkSource(await readFile(file, "utf8"));
            calls += checked.calls;
            problems.push(...checked.problems.map((problem) => `${path.relative(ROOT, file)}:${problem.line}: ${problem.call} ${problem.reason}`));
        }

        assert.ok(calls >= 25, `the scan found only ${calls} calls`);
        assert.deepEqual(problems, [], "write the log line with describeError(error) from utils/describeError.util.ts");
    });

    it("has one describeError, in utils/describeError.util.ts, and no copy of it in another file", async () => {
        const files = await listSourceFiles(path.join(ROOT, "src"));
        const definitions: string[] = [];

        for (const file of files) {
            const source = await readFile(file, "utf8");

            if (/\b(?:const|let|var|function)\s+describeError\b/.test(source)) {
                definitions.push(path.relative(ROOT, file).split(path.sep).join("/"));
            }
        }

        assert.deepEqual(definitions, ["src/v1/utils/describeError.util.ts"]);
    });
});
