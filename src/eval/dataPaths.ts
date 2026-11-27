import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

// The one module of the harness that decides which paths it may touch: the data folder (RAG_LAB_DATA_DIR), which is private and lives
// outside the repository, and the names the files inside it may have. Nothing in the harness builds a path of its own.

// whether `inner` is `outer` or inside it, on paths that are already absolute and real
const isInside = (outer: string, inner: string): boolean => {
    const relative = path.relative(outer, inner);

    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// The absolute path of the data folder. A folder that is missing, is not a folder, is the repository or is inside it is refused: what
// the harness reads and writes is private and must never end up in a commit. Both paths are resolved to their real place first, so a
// link or a "..", or a drive written another way, does not get past the check.
export const assertDataDirectory = async (dataDirectory: string, repositoryRoot: string): Promise<string> => {
    const real = await realpath(path.resolve(dataDirectory));

    if (!(await stat(real)).isDirectory()) {
        throw new Error("The data folder is not a folder");
    }

    if (isInside(await realpath(path.resolve(repositoryRoot)), real)) {
        throw new Error("The data folder is the repository or is inside it: private data must stay outside the repository");
    }

    return real;
};

// the characters that cannot be in a file name made of one plain component: the control characters (written as code points, so this
// file holds no invisible character)
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}]`);

// The name, or a throw when it could leave its folder or name something else: empty, with "..", with a separator of either system, a
// drive letter or any colon (an absolute path, and on Windows a stream of a file), a control character, or an end that Windows drops
// (a trailing dot or space). `what` says which kind of name it was, for the message; the message never repeats the name.
export const assertSafeName = (name: string, what: string): string => {
    const unsafe = name === ""
        || name.includes("..")
        || name.includes("/")
        || name.includes("\\")
        || name.includes(":")
        || CONTROL_CHARACTERS.test(name)
        || name.endsWith(".")
        || name.endsWith(" ")
        || name.startsWith(" ")
        || path.isAbsolute(name);

    if (unsafe) {
        throw new Error(`The ${what} is not a plain file name: it must not be empty, and must not have "..", a separator, a drive letter or a colon`);
    }

    return name;
};

// The name of the document a case belongs to: the file name of its indexPath without its extension ("data/eval-1000/foo.json" is
// "foo"), after the same checks as every name.
export const documentNameForIndexPath = (indexPath: string): string => {
    const base = indexPath.split(/[/\\]/).at(-1) ?? "";

    assertSafeName(base, "document name");

    const dot = base.lastIndexOf(".");
    const name = dot > 0 ? base.slice(0, dot) : base;

    return assertSafeName(name, "document name");
};

export const setFilePath = (dataDirectory: string, setName: string): string =>
    path.join(dataDirectory, "eval", "sets", `${assertSafeName(setName, "set name")}.json`);

export const documentFilePath = (dataDirectory: string, documentName: string): string =>
    path.join(dataDirectory, "eval", "documents", `${assertSafeName(documentName, "document name")}.txt`);

const twoDigits = (value: number): string => String(value).padStart(2, "0");

// the time as yyyymmddThhmmssZ, in UTC whatever the time zone of the computer
const toStamp = (time: Date): string =>
    `${time.getUTCFullYear()}${twoDigits(time.getUTCMonth() + 1)}${twoDigits(time.getUTCDate())}T${twoDigits(time.getUTCHours())}${twoDigits(time.getUTCMinutes())}${twoDigits(time.getUTCSeconds())}Z`;

// Makes <data>/results/retrieval/<UTC yyyymmddThhmmssZ>-<set> and returns its absolute path. A folder that exists is refused and left as
// it is: a sweep never overwrites another.
export const createSweepFolder = async (dataDirectory: string, setName: string, startedAt: Date): Promise<string> => {
    const safeName = assertSafeName(setName, "set name");
    const parent = path.join(dataDirectory, "results", "retrieval");

    await mkdir(parent, { recursive: true });

    const folder = path.join(parent, `${toStamp(startedAt)}-${safeName}`);

    // not recursive: it fails when the folder is already there
    await mkdir(folder);

    return path.resolve(folder);
};
