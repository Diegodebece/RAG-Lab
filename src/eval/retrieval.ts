import "dotenv/config";
import { parseArgs } from "node:util";
import { SETTING_CAPS } from "../v1/config/configuration.config.js";
import { describeError } from "../v1/utils/describeError.util.js";
import { runRetrievalSweep } from "./retrievalHarness.js";

// npm run eval:retrieval -- --set=<name> [--sizes=300,500] [--questions=q1,q2] [--repeat=1] [--check] [--build-timeout-minutes=60]
//
// The entry point of the retrieval harness and the only file of src/eval/ with side effects: it loads .env, reads the arguments and
// the environment, runs the sweep and sets the exit code (0 done, 1 refused or stopped, 2 done with failed questions). The harness
// itself takes every input as an option (retrievalHarness.ts).
//
// The environment: RAG_LAB_DATA_DIR (the private data folder, outside the repository), RAG_LAB_EVAL_API_URL (default
// http://127.0.0.1:3000), and RAG_LAB_EVAL_EMAIL and RAG_LAB_EVAL_PASSWORD, the harness account (not needed by --check). The password
// is never printed. The flags avoid the names that the agents' command hook refuses (--output, --eval, --print, --import, --require,
// --prefix, --loader).

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_MINUTES = 60;

const wholeNumber = (text: string, what: string): number => {
    if (!/^\d+$/.test(text)) {
        throw new Error(`${what} must be a whole number`);
    }

    return Number(text);
};

const run = async (): Promise<number> => {
    const { values } = parseArgs({
        options: {
            set: { type: "string" },
            sizes: { type: "string" },
            questions: { type: "string" },
            repeat: { type: "string" },
            check: { type: "boolean" },
            "build-timeout-minutes": { type: "string" }
        },
        allowPositionals: false,
        strict: true
    });

    if (values.set === undefined || values.set === "") {
        console.error("Usage: npm run eval:retrieval -- --set=<name> [--sizes=300,500] [--questions=q1,q2] [--repeat=1] [--check] [--build-timeout-minutes=60]");
        return 1;
    }

    const dataDirectory = process.env.RAG_LAB_DATA_DIR;

    if (dataDirectory === undefined || dataDirectory === "") {
        console.error("RAG_LAB_DATA_DIR is not set: it is the private data folder, outside the repository, with eval/sets, eval/documents and results");
        return 1;
    }

    const check = values.check === true;
    const email = process.env.RAG_LAB_EVAL_EMAIL ?? "";
    const password = process.env.RAG_LAB_EVAL_PASSWORD ?? "";

    if (!check && (email === "" || password === "")) {
        console.error("RAG_LAB_EVAL_EMAIL and RAG_LAB_EVAL_PASSWORD are not set: they are the harness account (see .env.example)");
        return 1;
    }

    const sizes = values.sizes === undefined ? [...SETTING_CAPS.chunkSize.allowed] : values.sizes.split(",").map((size) => wholeNumber(size.trim(), "A chunk size"));
    const questionIds = values.questions === undefined ? undefined : values.questions.split(",").map((id) => id.trim()).filter((id) => id !== "");
    const minutes = values["build-timeout-minutes"] === undefined ? DEFAULT_MINUTES : wholeNumber(values["build-timeout-minutes"], "The build timeout");

    const outcome = await runRetrievalSweep({
        apiUrl: process.env.RAG_LAB_EVAL_API_URL || DEFAULT_API_URL,
        email,
        password,
        dataDirectory,
        setName: values.set,
        sizes,
        ...(questionIds === undefined ? {} : { questionIds }),
        repeat: values.repeat === undefined ? 1 : wholeNumber(values.repeat, "The repeat count"),
        check,
        buildTimeoutMs: minutes * 60_000
    });

    if (outcome.message !== null) {
        console.error(`The sweep did not run to the end: ${outcome.message}`);
    }

    if (outcome.folder !== null) {
        console.log(`Results are in ${outcome.folder}`);
    }

    return outcome.exitCode;
};

try {
    process.exitCode = await run();
} catch (error) {
    console.error(`The sweep could not start: ${describeError(error)}`);
    process.exitCode = 1;
}
