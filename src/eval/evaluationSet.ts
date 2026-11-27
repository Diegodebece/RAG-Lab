import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { documentNameForIndexPath } from "./dataPaths.js";

// An evaluation set is a JSON file of cases, in the shape of the sets of RAG1: the evaluation questions with their expected answers and
// the passage of the document that holds the evidence. The harness uses only what retrieval needs and ignores the rest (the expected
// answer, the phrases the answer must include, the page and the section), so a set of RAG1 loads as it is.
//
// Questions and passages are private data. A refusal here names the cases by their ids and never quotes a question, an answer or a passage.

export interface EvaluationCase {
    id: string;
    question: string;
    // the name of the document: the file name of the case's indexPath without its extension
    document: string;
    // false only for a case that says unanswerable: true
    answerable: boolean;
    // the passages of the evidence: evidence.quote, then each additional quote; empty for an unanswerable case
    evidence: string[];
}

export interface LoadedEvaluationSet {
    // of the bytes of the file, so a result can say which set it ran
    sha256: string;
    cases: EvaluationCase[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// the quotes of an answerable case, or the problem with its evidence
const readEvidence = (evidence: unknown): { quotes: string[] } | { problem: string } => {
    if (!isRecord(evidence) || !isText(evidence.quote)) {
        return { problem: "has no evidence.quote" };
    }

    const quotes = [evidence.quote];

    if (evidence.additional !== undefined) {
        if (!Array.isArray(evidence.additional)) {
            return { problem: "has an evidence.additional that is not a list" };
        }

        for (const extra of evidence.additional) {
            if (!isRecord(extra) || !isText(extra.quote)) {
                return { problem: "has an additional passage without a quote" };
            }

            quotes.push(extra.quote);
        }
    }

    return { quotes };
};

// Reads the set at `filePath`. Rejects, with every problem listed and each case named by its id (or by its position when it has none),
// for a file that is not JSON, one without a list of cases, a case without an id, an indexPath or a question, an answerable case
// without a quote, an indexPath that does not give a safe document name, and an id that two cases share.
export const loadEvaluationSet = async (filePath: string): Promise<LoadedEvaluationSet> => {
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let parsed: unknown;

    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
        // the message of a JSON syntax error can quote the text around the mistake, which may be a question
        throw new Error("The evaluation set is not valid JSON");
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
        throw new Error("The evaluation set must be a JSON object with a list of cases");
    }

    const problems: string[] = [];
    const cases: EvaluationCase[] = [];
    const seen = new Set<string>();

    for (const [position, raw] of (parsed.cases as unknown[]).entries()) {
        if (!isRecord(raw)) {
            problems.push(`case ${position + 1} is not an object`);
            continue;
        }

        if (!isText(raw.id)) {
            problems.push(`case ${position + 1} has no id`);
            continue;
        }

        const id = raw.id;

        if (seen.has(id)) {
            problems.push(`id ${id} is used by more than one case`);
            continue;
        }

        seen.add(id);

        let document = "";

        if (!isText(raw.indexPath)) {
            problems.push(`case ${id} has no indexPath`);
        } else {
            try {
                document = documentNameForIndexPath(raw.indexPath);
            } catch {
                problems.push(`case ${id} has an indexPath that does not give a safe document name`);
            }
        }

        if (!isText(raw.question)) {
            problems.push(`case ${id} has no question`);
        }

        const answerable = raw.unanswerable !== true;
        let evidence: string[] = [];

        if (answerable) {
            const read = readEvidence(raw.evidence);

            if ("problem" in read) {
                problems.push(`case ${id} ${read.problem}`);
            } else {
                evidence = read.quotes;
            }
        }

        if (document !== "" && isText(raw.question) && (!answerable || evidence.length > 0)) {
            cases.push({ id, question: raw.question, document, answerable, evidence });
        }
    }

    if (problems.length > 0) {
        throw new Error(`The evaluation set has problems: ${problems.join("; ")}`);
    }

    return { sha256, cases };
};
