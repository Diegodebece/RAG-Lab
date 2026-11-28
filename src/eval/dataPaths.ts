import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

// The one module of the harness that decides which paths it may touch: the data folder (RAG_LAB_DATA_DIR), which is private and lives
// outside the repository, and the names the files inside it may have. Nothing in the harness builds a path of its own.

// whether `inner` is `outer` or inside it, on paths that are already absolute and real
const isInside = (outer: string, inner: string): boolean => {
    const relative = path.relative(outer, inner);

    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// whether the folder holds a `.git`: a folder (a checkout) or a file (a worktree's pointer to its checkout). Anything but "it is not
// there" is an error, so a folder that cannot be looked into is never taken for one that is clean.
const holdsGit = async (folder: string): Promise<boolean> => {
    try {
        await lstat(path.join(folder, ".git"));

        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }

        throw error;
    }
};

// The absolute path of the data folder. A folder that is missing, is not a folder, is the repository or is inside it is refused: what
// the harness reads and writes is private and must never end up in a commit. Both paths are resolved to their real place first, so a
// link or a "..", or a drive written another way, does not get past the check. The repository the harness runs from can be a worktree
// inside another checkout, and the data folder can sit in that other checkout while being outside the worktree: so the check does not
// stop at the repository it was given. It walks up from the real path of the data folder, the folder itself included, and refuses
// the first ancestor that holds a `.git`, as a folder or as a file.
export const assertDataDirectory = async (dataDirectory: string, repositoryRoot: string): Promise<string> => {
    const real = await realpath(path.resolve(dataDirectory));

    if (!(await stat(real)).isDirectory()) {
        throw new Error("The data folder is not a folder");
    }

    if (isInside(await realpath(path.resolve(repositoryRoot)), real)) {
        throw new Error("The data folder is the repository or is inside it: private data must stay outside the repository");
    }

    for (let folder = real; ; folder = path.dirname(folder)) {
        if (await holdsGit(folder)) {
            throw new Error("The data folder is inside a git checkout: private data must stay outside every repository");
        }

        if (path.dirname(folder) === folder) {
            break;
        }
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

// The real path of a folder of the results, which must be inside the data folder: a link there (a junction or a symlink) that leads
// out of it is refused, so nothing is ever written where it points.
const assertStillInside = async (realDataDirectory: string, folder: string): Promise<string> => {
    const real = await realpath(folder);

    if (!isInside(realDataDirectory, real)) {
        throw new Error("A folder of the results leads out of the data folder (a link): nothing is written there");
    }

    return real;
};

// Makes one folder of the results below `realDataDirectory`, one level, after checking the folder is not a link that leaves the data
// folder: a folder that is there is checked and used, and one that is not is made and checked again. `mustBeNew` is for the sweep's own
// folder, which is never reused: a folder that exists, a link included, is refused as it is.
const ensureResultsFolder = async (realDataDirectory: string, folder: string, mustBeNew: boolean): Promise<void> => {
    if (!mustBeNew) {
        try {
            await assertStillInside(realDataDirectory, folder);

            return;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
    }

    // not recursive: it fails when the folder is already there, and a link there (even a dangling one) is "there"
    await mkdir(folder);
    await assertStillInside(realDataDirectory, folder);
};

// Makes <data>/results/retrieval/<UTC yyyymmddThhmmssZ>-<set> and returns its absolute path. A folder that exists is refused and left as
// it is: a sweep never overwrites another. `dataDirectory` is the real path assertDataDirectory returned. Each level is looked at
// before anything is made below it, and again after it is made: a link in the data folder that leads out of it (to a repository, say)
// is refused with nothing made in the place it points to.
export const createSweepFolder = async (dataDirectory: string, setName: string, startedAt: Date): Promise<string> => {
    const safeName = assertSafeName(setName, "set name");
    const realDataDirectory = await realpath(dataDirectory);
    const results = path.join(realDataDirectory, "results");
    const retrieval = path.join(results, "retrieval");
    const folder = path.join(retrieval, `${toStamp(startedAt)}-${safeName}`);

    await ensureResultsFolder(realDataDirectory, results, false);
    await ensureResultsFolder(realDataDirectory, retrieval, false);
    await ensureResultsFolder(realDataDirectory, folder, true);

    return path.resolve(folder);
};
