import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

let work = "";
let repository = "";
let outside = "";

before(async () => {
    work = await mkdtemp(path.join(tmpdir(), "rag-lab-datapaths-"));
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
