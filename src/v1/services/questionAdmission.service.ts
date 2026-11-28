import { performance } from "node:perf_hooks";
import { pool } from "../config/db.config.js";
import { MAX_QUESTION_SECONDS, MAX_QUESTIONS_PER_DAY, MAX_WAITING_QUESTIONS } from "../config/limits.config.js";
import { AppError } from "../utils/appError.util.js";
import { ModelTimeoutError } from "../utils/modelTimeoutError.util.js";

// Who may ask a question now, and how long a question may take (adapted from RAG Web's questions.service.ts). Layer 5's search uses
// it, and layer 6's answers will: both are a question that waits for the model's turn.

const IN_PROGRESS_MESSAGE = "You already have a question in progress, please wait for it to finish";
const BUSY_MESSAGE = "The server is busy, please try again in a few minutes";
const DAILY_MESSAGE = "You have reached the daily limit of questions, please try again later";

// Users with a question in progress, from admission until it is released: one at a time per user, so nobody fills the line alone,
// and the count of the day below cannot be passed by a user's own questions that run at once. In memory, like the model's line: both
// empty when the API restarts, and valid for one process only (layer 13 revisits it for more).
const usersInProgress = new Set<string>();

// Questions admitted that have not yet started (they wait for the model's turn, or for the daily count). Only questions: the
// indexing batches have their own cap.
let questionsWaiting = 0;

export interface QuestionTicket {
    // the question stopped waiting: its turn came, or it left the line. Frees its place in the line; its user stays in progress.
    started: () => void;
    // the question is over, whatever happened to it. Frees the place in the line (if still held) and the user; calling it again does nothing.
    release: () => void;
}

// Decides whether a question may start now. The first three steps run with nothing awaited in between, so requests that arrive in
// the same moment cannot all pass: the user's own question in progress (409), the line (503), and then the user and the place are
// taken. Then it counts the user's questions of the last 24 hours, the rows of question_usage (one is written when an embedding is
// done, so a failure of the model server costs the user nothing, and a client that hangs up during the embedding is still counted)
// and refuses at the limit (429). A refusal leaves nothing taken. The caller releases the ticket in a `finally`, on every path.
export const admitQuestionService = async (userId: string): Promise<QuestionTicket> => {
    if (usersInProgress.has(userId)) {
        throw new AppError(409, IN_PROGRESS_MESSAGE);
    }

    if (questionsWaiting >= MAX_WAITING_QUESTIONS) {
        throw new AppError(503, BUSY_MESSAGE);
    }

    usersInProgress.add(userId);
    questionsWaiting += 1;

    let waiting = true;
    let released = false;

    const started = (): void => {
        if (waiting) {
            waiting = false;
            questionsWaiting -= 1;
        }
    };

    const release = (): void => {
        if (released) {
            return;
        }

        released = true;
        started();
        usersInProgress.delete(userId);
    };

    try {
        const { rows } = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM question_usage WHERE user_id = $1 AND used_at > now() - interval '24 hours'",
            [userId]
        );

        if (rows[0].count >= MAX_QUESTIONS_PER_DAY) {
            throw new AppError(429, DAILY_MESSAGE);
        }
    } catch (error) {
        release();
        throw error;
    }

    return { started, release };
};

// Counts one question against the user's day. The caller writes it when the embedding is done, or when the client hung up after
// the request was sent to the model: the model did the work either way. The row stays whatever happens to the run afterwards.
export const recordQuestionUsageService = async (userId: string): Promise<void> => {
    await pool.query("INSERT INTO question_usage (user_id) VALUES ($1)", [userId]);
};

export interface QuestionDeadline {
    // milliseconds left before MAX_QUESTION_SECONDS; none left is the 504 a model that is too slow gives
    timeLeft: () => number;
}

// The time one question has in all, from the moment it is created: waiting for the turn and the model's work share it, so each
// step gets only what is left.
export const createQuestionDeadline = (): QuestionDeadline => {
    const deadline = performance.now() + MAX_QUESTION_SECONDS * 1000;

    return {
        timeLeft: (): number => {
            const remaining = Math.floor(deadline - performance.now());

            if (remaining <= 0) {
                throw new ModelTimeoutError();
            }

            return remaining;
        }
    };
};
