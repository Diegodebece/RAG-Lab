import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    assertDataDirectory,
    assertSafeName,
    createSweepFolder,
    documentFilePath,
    documentNameForIndexPath,
    setFilePath
} from "../../src/eval/dataPaths.js";

// The harness reads the evaluation sets and documents from the data folder (RAG_LAB_DATA_DIR), which is private and lives outside the
// repository, and writes its results there. This is the one module that decides which paths it may touch.
//
// The contract this file gives the implementation (src/eval/dataPaths.ts; named exports):
//   assertDataDirectory(dataDirectory, repositoryRoot): Promise<string>   the absolute path, or a rejection when the folder is missing,
//                                                                          is not a folder, is the repository or is inside it
//   assertSafeName(name, what): string                                     the name, or a throw when it is empty or has "..", a separator,
//                                                                          a drive letter or is an absolute path
//   documentNameForIndexPath(indexPath): string                            "data/eval-1000/foo.json" -> "foo", after the same name checks
//   setFilePath(dataDirectory, setName): string                            <data>/eval/sets/<name>.json
//   documentFilePath(dataDirectory, documentName): string                  <data>/eval/documents/<name>.txt
//   createSweepFolder(dataDirectory, setName, startedAt): Promise<string>  <data>/results/retrieval/<yyyymmddThhmmssZ>-<set>, made now,
//                                                                          and a rejection (nothing overwritten) when it already exists
// Every folder is made in os.tmpdir(): the tests never touch RAG_LAB_DATA_DIR.
//
// Round 2 (the audit's findings F1 and F2), the contracts these tests pick:
//   assertDataDirectory also refuses a data folder that is inside ANY git checkout, not only the repository it was given: it walks up
//     from the real path of the folder, itself included, and refuses the first folder that holds `.git`, whether a folder (a checkout)
//     or a file (a worktree). A name that only starts like it (.github, .gitignore) is not a checkout.
//   createSweepFolder(dataDirectory, setName, startedAt) takes the real path assertDataDirectory returned. After each folder it makes
//     (results, retrieval, the sweep's own) it takes the real path of the folder and refuses, with a rejection, when it is not inside
//     the data folder: a link in the data folder that points out of it (a junction or a symlink) is never followed into a place where
//     something is written. Nothing at all is made inside the place a link points to: the folders above the link are the last ones made.
//     A link that points to another place inside the data folder is fine.

let work = "";
let repository = "";
let outside = "";

before(async () => {
    // the real path of the temporary folder, so that what the tests compare is not a short name or a link of this computer
    work = await realpath(await mkdtemp(path.join(tmpdir(), "rag-lab-datapaths-")));
    repository = path.join(work, "repo");
    outside = path.join(work, "data");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
});

after(() => rm(work, { recursive: true, force: true }));

describe("assertDataDirectory", () => {
    it("accepts a folder outside the repository and returns its absolute path", async () => {
        assert.equal(path.resolve(await assertDataDirectory(outside, repository)), path.resolve(outside));
        assert.ok(path.isAbsolute(await assertDataDirectory(outside, repository)));
    });

    it("accepts a folder next to the repository whose name starts with the repository's name: a prefix is not being inside", async () => {
        const sibling = path.join(work, "repo-data");
        await mkdir(sibling, { recursive: true });

        assert.equal(path.resolve(await assertDataDirectory(sibling, repository)), path.resolve(sibling));
    });

    it("refuses the repository itself, also written with a trailing separator", async () => {
        await assert.rejects(assertDataDirectory(repository, repository));
        await assert.rejects(assertDataDirectory(`${repository}${path.sep}`, repository));
    });

    it("refuses a folder inside the repository, however deep, and one that gets there through '..'", async () => {
        await assert.rejects(assertDataDirectory(path.join(repository, "src"), repository));

        const deep = path.join(repository, "a", "b", "c");
        await mkdir(deep, { recursive: true });
        await assert.rejects(assertDataDirectory(deep, repository));
        await assert.rejects(assertDataDirectory(path.join(outside, "..", "repo", "src"), repository));
    });

    it("refuses a folder that is missing, and a path that is a file", async () => {
        await assert.rejects(assertDataDirectory(path.join(work, "no-such-folder"), repository));

        const file = path.join(work, "a-file.txt");
        await writeFile(file, "not a folder");
        await assert.rejects(assertDataDirectory(file, repository));
    });

    // F1: the repository the harness is told about is the one it runs from, which can be a worktree under the main checkout (the
    // checkout's own .claude/worktrees/<name>): a data folder in the main checkout is outside the worktree, and still in a repository
    it("refuses a folder inside a git checkout that is not the repository it was given: an ancestor holds a .git folder", async () => {
        const checkout = path.join(work, "another-checkout");
        await mkdir(path.join(checkout, ".git"), { recursive: true });
        await mkdir(path.join(checkout, "private", "deeper"), { recursive: true });

        await assert.rejects(assertDataDirectory(path.join(checkout, "private"), repository), "a folder of the checkout");
        await assert.rejects(assertDataDirectory(path.join(checkout, "private", "deeper"), repository), "a folder deeper in it");
    });

    it("refuses a folder in the main checkout when the repository given is a worktree under it, whose .git is a file", async () => {
        const main = path.join(work, "main-checkout");
        const worktree = path.join(main, ".claude", "worktrees", "w");
        await mkdir(path.join(main, ".git"), { recursive: true });
        await mkdir(worktree, { recursive: true });
        await writeFile(path.join(worktree, ".git"), "gitdir: ../../../.git/worktrees/w\n");
        await mkdir(path.join(main, "private"), { recursive: true });

        await assert.rejects(assertDataDirectory(path.join(main, "private"), worktree), "main/private, with the worktree as the repository");
    });

    it("refuses a folder inside a worktree on its own: an ancestor holds a .git that is a file", async () => {
        const worktree = path.join(work, "lonely-worktree");
        await mkdir(path.join(worktree, "private"), { recursive: true });
        await writeFile(path.join(worktree, ".git"), "gitdir: /somewhere/else/.git/worktrees/lonely\n");

        await assert.rejects(assertDataDirectory(path.join(worktree, "private"), repository));
    });

    it("refuses a data folder that itself holds a .git", async () => {
        const data = path.join(work, "data-with-git");
        await mkdir(path.join(data, ".git"), { recursive: true });

        await assert.rejects(assertDataDirectory(data, repository));
    });

    it("refuses a link to a folder inside a git checkout: the real path is the one that is checked", async () => {
        const checkout = path.join(work, "linked-checkout");
        await mkdir(path.join(checkout, ".git"), { recursive: true });
        await mkdir(path.join(checkout, "private"), { recursive: true });
        const link = path.join(work, "link-to-private");
        await symlink(path.join(checkout, "private"), link, "junction");

        await assert.rejects(assertDataDirectory(link, repository));
    });

    it("does not take a folder or a file that only starts like .git (.github, .gitignore) for a checkout", async () => {
        const parent = path.join(work, "not-a-checkout");
        await mkdir(path.join(parent, ".github"), { recursive: true });
        await writeFile(path.join(parent, ".gitignore"), "node_modules\n");
        await mkdir(path.join(parent, "private"), { recursive: true });

        assert.equal(path.resolve(await assertDataDirectory(path.join(parent, "private"), repository)), path.join(parent, "private"));
    });
});

describe("assertSafeName", () => {
    it("returns a plain name unchanged, with dots, dashes and digits in it", () => {
        for (const name of ["guide", "guide-one", "set_2", "set.v2", "A1", "eval-1000"]) {
            assert.equal(assertSafeName(name, "set"), name);
        }
    });

    it("refuses an empty name, '..', and a name that contains '..'", () => {
        for (const name of ["", "..", "a..b", "..a", "a..", "../x", "x/.."]) {
            assert.throws(() => assertSafeName(name, "set"), JSON.stringify(name));
        }
    });

    it("refuses a name with a separator of either kind", () => {
        for (const name of ["a/b", "a\\b", "/a", "\\a", "a/", "dir/guide"]) {
            assert.throws(() => assertSafeName(name, "document"), JSON.stringify(name));
        }
    });

    it("refuses a drive letter, an absolute path of either system and a network path", () => {
        for (const name of ["C:", "C:guide", "c:\\guide", "D:/guide", "/etc/passwd", "\\\\server\\share"]) {
            assert.throws(() => assertSafeName(name, "document"), JSON.stringify(name));
        }
    });

    it("says what kind of name it refused", () => {
        assert.throws(() => assertSafeName("..", "set name"), /set name/);
    });
});

describe("documentNameForIndexPath", () => {
    it("takes the file name of the path without its extension: 'data/eval-1000/foo.json' is 'foo'", () => {
        assert.equal(documentNameForIndexPath("data/eval-1000/foo.json"), "foo");
        assert.equal(documentNameForIndexPath("data\\eval-1000\\foo.json"), "foo");
        assert.equal(documentNameForIndexPath("foo.json"), "foo");
        assert.equal(documentNameForIndexPath("data/eval/guide.v2.json"), "guide.v2");
        assert.equal(documentNameForIndexPath("data/eval/no-extension"), "no-extension");
    });

    it("refuses a path whose file name is empty, is '..', holds '..' or starts with a drive letter", () => {
        for (const indexPath of ["", "data/eval/", "data/eval/..", "data/..", "data/eval/a..b.json", "C:guide.json"]) {
            assert.throws(() => documentNameForIndexPath(indexPath), JSON.stringify(indexPath));
        }
    });
});

describe("the files of a set and of a document", () => {
    it("puts a set in eval/sets as <name>.json and a document in eval/documents as <name>.txt, under the data folder", () => {
        assert.equal(setFilePath(outside, "invented"), path.join(outside, "eval", "sets", "invented.json"));
        assert.equal(documentFilePath(outside, "guide"), path.join(outside, "eval", "documents", "guide.txt"));
    });

    it("refuses an unsafe name before it makes a path", () => {
        assert.throws(() => setFilePath(outside, "../secrets"));
        assert.throws(() => setFilePath(outside, "a/b"));
        assert.throws(() => documentFilePath(outside, "..\\guide"));
        assert.throws(() => documentFilePath(outside, "C:guide"));
        assert.throws(() => documentFilePath(outside, ""));
    });
});

describe("createSweepFolder", () => {
    const startedAt = new Date(Date.UTC(2026, 10, 27, 9, 5, 3));

    it("makes results/retrieval/<UTC yyyymmddThhmmssZ>-<set> under the data folder and returns its absolute path", async () => {
        const folder = await createSweepFolder(outside, "invented", startedAt);

        assert.equal(path.resolve(folder), path.join(outside, "results", "retrieval", "20261127T090503Z-invented"));
        assert.ok(path.isAbsolute(folder));
        await writeFile(path.join(folder, "probe.txt"), "it is a folder");
    });

    it("never overwrites a folder: the same second and the same set is refused, and what the first sweep wrote is untouched", async () => {
        const first = await createSweepFolder(outside, "twice", startedAt);
        await writeFile(path.join(first, "manifest.json"), "{\"kept\": true}");

        await assert.rejects(createSweepFolder(outside, "twice", startedAt));

        assert.equal(await readFile(path.join(first, "manifest.json"), "utf8"), "{\"kept\": true}");
    });

    it("lets another set, or another second, have a folder of its own", async () => {
        const one = await createSweepFolder(outside, "other-set", startedAt);
        const two = await createSweepFolder(outside, "another-set", startedAt);
        const three = await createSweepFolder(outside, "other-set", new Date(startedAt.getTime() + 1000));

        assert.equal(new Set([one, two, three]).size, 3);
    });

    it("writes the time in UTC whatever the time zone of the computer, with two digits for each part", async () => {
        const folder = await createSweepFolder(outside, "zeros", new Date(Date.UTC(2027, 0, 2, 3, 4, 5)));

        assert.equal(path.basename(folder), "20270102T030405Z-zeros");
    });

    it("refuses an unsafe set name", async () => {
        for (const setName of ["..", "../x", "a/b", "C:x", ""]) {
            await assert.rejects(createSweepFolder(outside, setName, new Date(Date.UTC(2030, 0, 1))), JSON.stringify(setName));
        }
    });
});

// F2: the data folder is checked once, and what is inside it is not: a link there (a junction or a symlink, made by the owner, by a
// tool, or by someone with access to the folder) can point into the repository, and the sweep would write its results there.
describe("createSweepFolder: a link inside the data folder that points out of it (F2)", () => {
    const startedAt = new Date(Date.UTC(2026, 10, 27, 9, 5, 3));

    // a fake repository to point at, with the folder the link goes to; and a data folder of its own, checked as the entry point does
    const makeScene = async (name: string) => {
        const fakeRepository = path.join(work, `${name}-repository`);
        const target = path.join(fakeRepository, "inside");
        await mkdir(path.join(fakeRepository, ".git"), { recursive: true });
        await mkdir(target, { recursive: true });
        const data = path.join(work, `${name}-data`);
        await mkdir(data, { recursive: true });

        return { target, data, realData: await assertDataDirectory(data, repository) };
    };

    it("rejects, and makes nothing inside the folder the link points to, when results is a link out of the data folder", async () => {
        const { target, data, realData } = await makeScene("results-link");
        await symlink(target, path.join(data, "results"), "junction");

        await assert.rejects(createSweepFolder(realData, "invented", startedAt));

        assert.deepEqual(await readdir(target), [], "nothing was made where the link points");
    });

    it("rejects, and makes nothing inside the folder the link points to, when results/retrieval is a link out of the data folder", async () => {
        const { target, data, realData } = await makeScene("retrieval-link");
        await mkdir(path.join(data, "results"), { recursive: true });
        await symlink(target, path.join(data, "results", "retrieval"), "junction");

        await assert.rejects(createSweepFolder(realData, "invented", startedAt));

        assert.deepEqual(await readdir(target), [], "nothing was made where the link points");
    });

    it("rejects when the folder of the sweep itself is a link out of the data folder, which was put there first", async () => {
        const { target, data, realData } = await makeScene("sweep-link");
        await mkdir(path.join(data, "results", "retrieval"), { recursive: true });
        await symlink(target, path.join(data, "results", "retrieval", "20261127T090503Z-invented"), "junction");

        await assert.rejects(createSweepFolder(realData, "invented", startedAt));

        assert.deepEqual(await readdir(target), [], "nothing was written where the link points");
    });

    it("still makes the folder when a link points to another place inside the data folder: only a way out is refused", async () => {
        const { data, realData } = await makeScene("inside-link");
        const elsewhere = path.join(data, "elsewhere");
        await mkdir(elsewhere, { recursive: true });
        await symlink(elsewhere, path.join(data, "results"), "junction");

        const folder = await createSweepFolder(realData, "invented", startedAt);

        assert.equal((await readdir(path.join(elsewhere, "retrieval"))).length, 1, "the sweep folder is where the link leads, inside the data folder");
        assert.equal(path.basename(folder), "20261127T090503Z-invented");
    });
});
