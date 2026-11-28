import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEvaluationSet } from "../../src/eval/evaluationSet.js";

// The loader of an evaluation set (D15 and the orchestrator's refinements). The set is a JSON file of cases; every set and text in
// this file is invented, and lives in a folder of os.tmpdir().
//
// The contract this file gives the implementation (src/eval/evaluationSet.ts):
//   loadEvaluationSet(filePath): Promise<{ sha256: string; cases: EvaluationCase[] }>
//     sha256: of the bytes of the file, in lowercase hexadecimal
//     EvaluationCase = { id, question, document, answerable, evidence }, and nothing else:
//       document:   the name of the document, from the file name of indexPath without its extension ("data/eval-1000/foo.json" -> "foo")
//       answerable: false only for a case with unanswerable: true
//       evidence:   the passages: evidence.quote, then each evidence.additional[].quote; [] for an unanswerable case
//     Fields it does not use (expectedAnswer, mustInclude, mustNotInclude, section, page, chapter, offset, ...) are ignored, not refused.
//   It rejects, naming every case by its id and never quoting a question or a passage (they are private data), for: a case without an
//   id (named by its position), indexPath or question, an answerable case without evidence.quote, an indexPath whose document name is
//   unsafe, and an id that is used twice; and for a file that is not JSON or has no list of cases.

let folder = "";
let counter = 0;

before(async () => {
    folder = await mkdtemp(path.join(tmpdir(), "rag-lab-set-"));
});

after(() => rm(folder, { recursive: true, force: true }));

const writeSet = async (content: unknown): Promise<string> => {
    counter += 1;
    const file = path.join(folder, `set-${counter}.json`);
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
    return file;
};

const answerable = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    indexPath: "data/eval-1000/guide-one.json",
    question: `INVENTED-QUESTION-${id}`,
    expectedAnswer: "INVENTED-ANSWER",
    mustInclude: [["x"]],
    mustNotInclude: [],
    evidence: { quote: `INVENTED-QUOTE-${id}`, section: "2.1", page: 4, chapter: 2, offset: 120 },
    ...extra
});

const messageOf = async (file: string): Promise<string> => {
    try {
        await loadEvaluationSet(file);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }

    throw new Error("the set was loaded, and it should have been refused");
};

describe("loadEvaluationSet: what it reads", () => {
    it("reads an answerable case into { id, question, document, answerable, evidence } and nothing else", async () => {
        const file = await writeSet({ version: 1, description: "An invented set.", cases: [answerable("q-1")] });

        const { cases } = await loadEvaluationSet(file);

        assert.deepEqual(cases, [{ id: "q-1", question: "INVENTED-QUESTION-q-1", document: "guide-one", answerable: true, evidence: ["INVENTED-QUOTE-q-1"] }]);
        assert.deepEqual(Object.keys(cases[0]).sort(), ["answerable", "document", "evidence", "id", "question"]);
    });

    it("takes the passages of a case as evidence.quote followed by each additional quote, in order", async () => {
        const file = await writeSet({
            cases: [answerable("q-1", { evidence: { quote: "first passage", additional: [{ quote: "second passage", page: 9 }, { quote: "third passage" }] } })]
        });

        assert.deepEqual((await loadEvaluationSet(file)).cases[0].evidence, ["first passage", "second passage", "third passage"]);
    });

    it("takes a case with an empty list of additional passages, or none, as a case with one passage", async () => {
        const file = await writeSet({
            cases: [
                answerable("q-1", { evidence: { quote: "only one", additional: [] } }),
                answerable("q-2", { evidence: { quote: "again only one" } })
            ]
        });

        assert.deepEqual((await loadEvaluationSet(file)).cases.map((item) => item.evidence), [["only one"], ["again only one"]]);
    });

    it("reads a case with unanswerable: true as not answerable, with no passages, whether or not it has the fields of an answerable one", async () => {
        const file = await writeSet({
            cases: [
                { id: "u-1", indexPath: "data/eval-1000/guide-one.json", question: "An invented question nobody can answer?", mustInclude: [], mustNotInclude: ["x"], unanswerable: true },
                answerable("u-2", { unanswerable: true })
            ]
        });

        const { cases } = await loadEvaluationSet(file);

        assert.deepEqual(cases.map((item) => [item.id, item.answerable, item.evidence]), [["u-1", false, []], ["u-2", false, []]]);
    });

    it("names the document of each case by the file name of its indexPath, without the extension", async () => {
        const file = await writeSet({
            cases: [
                answerable("q-1", { indexPath: "data/eval-1000/guide-one.json" }),
                answerable("q-2", { indexPath: "data\\eval-500\\Guide Two.json" }),
                answerable("q-3", { indexPath: "guide.three.json" })
            ]
        });

        assert.deepEqual((await loadEvaluationSet(file)).cases.map((item) => item.document), ["guide-one", "Guide Two", "guide.three"]);
    });

    it("keeps the cases in the order of the file, and ignores the fields it does not use, the unknown ones included", async () => {
        const file = await writeSet({
            version: 3,
            note: "ignored",
            cases: [answerable("q-b", { foo: { nested: true }, tags: ["x"] }), answerable("q-a"), answerable("q-c")]
        });

        assert.deepEqual((await loadEvaluationSet(file)).cases.map((item) => item.id), ["q-b", "q-a", "q-c"]);
    });

    it("gives the SHA-256 of the bytes of the file, in lowercase hexadecimal", async () => {
        const text = JSON.stringify({ cases: [answerable("q-1")] }, null, 2);
        const file = await writeSet(text);

        const { sha256 } = await loadEvaluationSet(file);

        assert.equal(sha256, createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
        assert.match(sha256, /^[0-9a-f]{64}$/);
    });

    it("accepts a set with no cases", async () => {
        assert.deepEqual((await loadEvaluationSet(await writeSet({ cases: [] }))).cases, []);
    });
});

describe("loadEvaluationSet: what it refuses", () => {
    it("refuses a case without an indexPath, naming the case by its id", async () => {
        const { indexPath: _removed, ...withoutPath } = answerable("q-nopath");

        const message = await messageOf(await writeSet({ cases: [answerable("q-fine"), withoutPath] }));

        assert.ok(message.includes("q-nopath"), message);
        assert.ok(!message.includes("q-fine"), "the sound case is not named");
    });

    it("refuses a case without a question, or with an empty one, naming it", async () => {
        const { question: _removed, ...withoutQuestion } = answerable("q-noquestion");

        for (const bad of [withoutQuestion, answerable("q-emptyquestion", { question: "" })]) {
            const message = await messageOf(await writeSet({ cases: [bad] }));

            assert.ok(message.includes(String(bad.id)), message);
        }
    });

    it("refuses a case without an id, saying which one by its position", async () => {
        const { id: _removed, ...withoutId } = answerable("x");

        const message = await messageOf(await writeSet({ cases: [answerable("q-1"), withoutId] }));

        assert.match(message, /\b2\b/, `the second case: ${message}`);
    });

    it("refuses an answerable case without evidence, with an evidence without a quote, or with an empty quote, naming it", async () => {
        const { evidence: _removed, ...withoutEvidence } = answerable("q-noevidence");
        const cases = [
            withoutEvidence,
            answerable("q-noquote", { evidence: { section: "1" } }),
            answerable("q-emptyquote", { evidence: { quote: "" } }),
            answerable("q-spacesquote", { evidence: { quote: "   " } })
        ];

        for (const bad of cases) {
            const message = await messageOf(await writeSet({ cases: [bad] }));

            assert.ok(message.includes(String(bad.id)), message);
        }
    });

    it("lists every case that is wrong, not only the first", async () => {
        const { indexPath: _removed, ...withoutPath } = answerable("q-nopath");

        const message = await messageOf(await writeSet({ cases: [withoutPath, answerable("q-noquestion", { question: "" }), answerable("q-ok"), answerable("q-noquote", { evidence: {} })] }));

        for (const id of ["q-nopath", "q-noquestion", "q-noquote"]) {
            assert.ok(message.includes(id), `${id} is named: ${message}`);
        }

        assert.ok(!message.includes("q-ok"));
    });

    it("refuses a case whose indexPath gives an unsafe document name, naming the case", async () => {
        for (const indexPath of ["data/eval/..", "data/eval/a..b.json", "C:guide.json", "data/eval/"]) {
            const message = await messageOf(await writeSet({ cases: [answerable("q-unsafe", { indexPath })] }));

            assert.ok(message.includes("q-unsafe"), `${indexPath}: ${message}`);
        }
    });

    it("refuses an id that two cases share, naming it", async () => {
        const message = await messageOf(await writeSet({ cases: [answerable("q-twice"), answerable("q-other"), answerable("q-twice")] }));

        assert.ok(message.includes("q-twice"), message);
    });

    it("never writes a question, an answer or a passage in the message of a refusal", async () => {
        const { indexPath: _removed, ...withoutPath } = answerable("q-nopath");
        const message = await messageOf(await writeSet({ cases: [withoutPath, answerable("q-emptyquote", { evidence: { quote: "" } })] }));

        for (const privateText of ["INVENTED-QUESTION", "INVENTED-ANSWER", "INVENTED-QUOTE"]) {
            assert.ok(!message.includes(privateText), `the message holds ${privateText}: ${message}`);
        }
    });

    it("refuses a file that is not JSON, a JSON value that is not an object, and an object without a list of cases", async () => {
        for (const content of ["{\"cases\": [", "[]", "\"text\"", "null", "{}", "{\"cases\": {}}", "{\"cases\": \"x\"}"]) {
            await assert.rejects(loadEvaluationSet(await writeSet(content)), Error, content);
        }
    });

    it("refuses a case that is not an object", async () => {
        await assert.rejects(loadEvaluationSet(await writeSet({ cases: [5] })));
        await assert.rejects(loadEvaluationSet(await writeSet({ cases: [null] })));
    });

    it("rejects with an error for a file that does not exist", async () => {
        await assert.rejects(loadEvaluationSet(path.join(folder, "no-such-set.json")));
    });
});
