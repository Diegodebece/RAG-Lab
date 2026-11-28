import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

// The admission of a question (layer 5, reused by layer 6): who may ask, now. Small caps, set before the module loads (limits are
// read once, when their module loads, and each test file is its own process): 2 questions waiting for the model at once, 3
// questions a day, and one second for a question to finish.
process.env.MAX_WAITING_QUESTIONS = "2";
process.env.MAX_QUESTIONS_PER_DAY = "3";
process.env.MAX_QUESTION_SECONDS = "1";

const { closeTestPools, ownerPool, resetTestDatabase } = await import("../db/testDatabase.js");
const { admitQuestionService, createQuestionDeadline } = await import("../../src/v1/services/questionAdmission.service.js");
const { AppError } = await import("../../src/v1/utils/appError.util.js");
const { ModelTimeoutError } = await import("../../src/v1/utils/modelTimeoutError.util.js");
const { countRows, seedQuestionUsage, seedRun, seedUser } = await import("../documentsFixtures.js");

const IN_PROGRESS = "You already have a question in progress, please wait for it to finish";
const BUSY = "The server is busy, please try again in a few minutes";
const DAILY = "You have reached the daily limit of questions, please try again later";

before(resetTestDatabase);

beforeEach(() => ownerPool.query("TRUNCATE users CASCADE"));

// the state of admission is in memory, shared by the tests of this file: whatever a test admitted is released, so the next one
// starts with nobody in progress and nobody waiting
const tickets: { release: () => void }[] = [];

afterEach(() => {
    for (const ticket of tickets.splice(0)) {
        ticket.release();
    }
});

after(closeTestPools);

type Ticket = Awaited<ReturnType<typeof admitQuestionService>>;

const admit = async (userId: string): Promise<Ticket> => {
    const ticket = await admitQuestionService(userId);
    tickets.push(ticket);
    return ticket;
};

const isRefusal = (status: number, message: string) => (error: unknown): boolean =>
    error instanceof AppError && error.status === status && error.message === message;

// ago(25) is a moment 25 hours ago
const ago = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

describe("admitQuestionService: one question at a time for each user", () => {
    it("admits a user with nothing in progress, and answers 409 to a second question of the same user while the first is not released", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        await admit(ana);

        await assert.rejects(admitQuestionService(ana), isRefusal(409, IN_PROGRESS));
    });

    it("admits another user while the first is in progress", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");

        await admit(ana);

        await admit(bob);
        await assert.rejects(admitQuestionService(ana), isRefusal(409, IN_PROGRESS), "ana is still in progress");
    });

    it("keeps the user in progress after started(): the question runs until it is released", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        const ticket = await admit(ana);
        ticket.started();

        await assert.rejects(admitQuestionService(ana), isRefusal(409, IN_PROGRESS));
    });

    it("lets the user ask again once the question is released", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        (await admit(ana)).release();

        await admit(ana);
    });

    it("decides at once, when requests arrive together: of ten admissions of one user started in the same tick, exactly one is admitted", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => admitQuestionService(ana)));

        for (const outcome of outcomes) {
            if (outcome.status === "fulfilled") {
                tickets.push(outcome.value);
            }
        }

        assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
        assert.ok(outcomes.filter((outcome) => outcome.status === "rejected").every((outcome) => isRefusal(409, IN_PROGRESS)(outcome.reason)));
    });
});

describe("admitQuestionService: the questions waiting for the model (2 here)", () => {
    it("answers 503 busy to a third question while two are waiting, and admits it once one has started", { timeout: 15_000 }, async () => {
        const [ana, bob, cara] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com")];

        const first = await admit(ana);
        await admit(bob);

        await assert.rejects(admitQuestionService(cara), isRefusal(503, BUSY));

        first.started();
        await admit(cara);
    });

    it("does not count a refused question as one in progress: the user who was told it is busy can ask when there is room", { timeout: 15_000 }, async () => {
        const [ana, bob, cara] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com")];

        const first = await admit(ana);
        await admit(bob);
        await assert.rejects(admitQuestionService(cara), isRefusal(503, BUSY));
        first.started();

        // a leaked slot of cara's would answer 409 here
        await admit(cara);
    });

    it("counts a question as waiting until started() and not after: a started question does not take a place in the line", { timeout: 15_000 }, async () => {
        const users = [await seedUser("a@example.com"), await seedUser("b@example.com"), await seedUser("c@example.com"), await seedUser("d@example.com")];

        for (const user of users.slice(0, 3)) {
            (await admit(user)).started();
        }

        // three questions are running and none is waiting, so two more can wait
        const fourth = await seedUser("e@example.com");
        await admit(users[3]);
        await admit(fourth);
        await assert.rejects(admitQuestionService(await seedUser("f@example.com")), isRefusal(503, BUSY));
    });

    it("frees both slots when a question is released after it ran: users can be admitted again, far more times than the cap of 2", { timeout: 20_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        for (let round = 0; round < 6; round++) {
            const ticket = await admit(ana);
            ticket.started();
            ticket.release();
        }

        // nothing leaked: two can wait, and the third is refused for the cap, not for a slot of ana's
        const [bob, cara] = [await seedUser("bob@example.com"), await seedUser("cara@example.com")];
        await admit(ana);
        await admit(bob);
        await assert.rejects(admitQuestionService(cara), isRefusal(503, BUSY));
    });

    it("frees both slots when a question is released without ever starting (an error or a client that left while it waited)", { timeout: 20_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        for (let round = 0; round < 6; round++) {
            (await admit(ana)).release();
        }

        const [bob, cara] = [await seedUser("bob@example.com"), await seedUser("cara@example.com")];
        await admit(ana);
        await admit(bob);
        await assert.rejects(admitQuestionService(cara), isRefusal(503, BUSY), "two waiting is the cap: nothing was left over from the six rounds");
    });

    it("does not give a place back twice: released after started(), it is not counted as leaving the line again", { timeout: 15_000 }, async () => {
        const [ana, bob, cara, dan] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com"), await seedUser("dan@example.com")];

        const ticket = await admit(ana);
        ticket.started();
        ticket.release();

        await admit(bob);
        await admit(cara);
        await assert.rejects(admitQuestionService(dan), isRefusal(503, BUSY), "two are waiting: a third place would mean the counter went below zero");
    });

    it("treats a second release() of the same question as nothing: it does not free another question's place", { timeout: 15_000 }, async () => {
        const [ana, bob, cara, dan] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com"), await seedUser("dan@example.com")];

        const ticket = await admit(ana);
        ticket.release();
        ticket.release();

        await admit(bob);
        await admit(cara);
        await assert.rejects(admitQuestionService(dan), isRefusal(503, BUSY), "two are waiting: a second release must not have opened a third place");
    });

    it("answers 409 for a user in progress before it looks at the line", { timeout: 15_000 }, async () => {
        const [ana, bob] = [await seedUser("ana@example.com"), await seedUser("bob@example.com")];

        await admit(ana);
        await admit(bob);

        await assert.rejects(admitQuestionService(ana), isRefusal(409, IN_PROGRESS), "the line is full, and the message is still the user's own");
    });
});

// The day's count reads question_usage (round 2, finding F6): a row for every embedding done for a question, whether or not its run
// was stored afterwards. It does not read runs: a question that was embedded and then lost (a client that hung up during the
// embedding) still counts, and a seeded run alone does not.
describe("admitQuestionService: the questions of the day (3 here)", () => {
    it("answers 429 when the user has 3 counted questions in the last 24 hours, and admits at 2", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        await seedQuestionUsage(ana, 1, 1);
        await seedQuestionUsage(ana, 1, 12);
        await admit(ana).then((ticket) => ticket.release());

        await seedQuestionUsage(ana, 1, 23.9);

        await assert.rejects(admitQuestionService(ana), isRefusal(429, DAILY));
    });

    it("does not count questions older than 24 hours, and counts the ones from 23 hours ago", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        for (const hours of [25, 30, 100]) {
            await seedQuestionUsage(ana, 1, hours);
        }

        await admit(ana).then((ticket) => ticket.release());

        for (const hours of [23, 22, 21]) {
            await seedQuestionUsage(ana, 1, hours);
        }

        await assert.rejects(admitQuestionService(ana), isRefusal(429, DAILY));
    });

    it("does not count another user's questions", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");
        const bob = await seedUser("bob@example.com");

        await seedQuestionUsage(bob, 5);

        await admit(ana);
        await assert.rejects(admitQuestionService(bob), isRefusal(429, DAILY));
    });

    it("counts question_usage and not runs: three stored runs and no usage is not a day's limit", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        for (let run = 0; run < 3; run++) {
            await seedRun(ana);
        }

        await admit(ana);
    });

    it("stores nothing itself: admitting adds no run and no usage row (the search writes the usage when the embedding is done)", { timeout: 15_000 }, async () => {
        const ana = await seedUser("ana@example.com");

        await seedQuestionUsage(ana, 2);
        const runsBefore = await countRows("runs");
        const usageBefore = await countRows("question_usage");

        (await admit(ana)).release();

        assert.equal(await countRows("runs"), runsBefore);
        assert.equal(await countRows("question_usage"), usageBefore);
    });

    it("frees the user's slot and the place in the line when it refuses with 429", { timeout: 15_000 }, async () => {
        const [ana, bob, cara] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com")];

        await seedQuestionUsage(ana, 3);

        for (let attempt = 0; attempt < 4; attempt++) {
            await assert.rejects(admitQuestionService(ana), isRefusal(429, DAILY), `attempt ${attempt + 1}: always the daily limit, never 409 or 503`);
        }

        // four refusals did not take the two places of the line
        await admit(bob);
        await admit(cara);

        // and ana's slot is free: once a day has passed for her questions she is admitted
        await ownerPool.query("UPDATE question_usage SET used_at = now() - interval '2 days' WHERE user_id = $1", [ana]);
        tickets.splice(0).forEach((ticket) => ticket.release());
        await admit(ana);
    });

    // the order of the checks is the plan's: the user's own question in progress (409), the line (503), and then the day (429), which
    // is the only one that waits for the database
    it("answers 503 busy, and not the daily limit, to a user over her day when the line is full: the line is checked first", { timeout: 15_000 }, async () => {
        const [ana, bob, cara] = [await seedUser("ana@example.com"), await seedUser("bob@example.com"), await seedUser("cara@example.com")];

        await seedQuestionUsage(cara, 3);

        await admit(ana);
        await admit(bob);

        // the line is full, and cara is over her day: the line is checked first, and its answer is the 503
        await assert.rejects(admitQuestionService(cara), isRefusal(503, BUSY));

        // with room in the line, the same user hears about her day
        tickets.splice(0).forEach((ticket) => ticket.release());
        await assert.rejects(admitQuestionService(cara), isRefusal(429, DAILY));
    });
});

describe("createQuestionDeadline", () => {
    it("starts with about MAX_QUESTION_SECONDS (1 second here) left, and the time left goes down", { timeout: 15_000 }, async () => {
        const deadline = createQuestionDeadline();
        const first = deadline.timeLeft();

        assert.ok(first > 0 && first <= 1000, `${first} milliseconds left`);

        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.ok(deadline.timeLeft() < first, "less time is left a moment later");
    });

    it("throws ModelTimeoutError (504) when no time is left", { timeout: 15_000 }, async () => {
        const deadline = createQuestionDeadline();

        await new Promise((resolve) => setTimeout(resolve, 1100));

        assert.throws(() => deadline.timeLeft(), (error: unknown) => error instanceof ModelTimeoutError && error.status === 504);
    });
});
