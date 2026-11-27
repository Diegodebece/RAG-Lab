export type IndexStatus = "queued" | "indexing" | "ready" | "failed";

// An index of a document as the API shows it: the document's text cut in chunks of one size and embedded with one model.
export interface DocumentIndex {
    id: string;
    documentId: string;
    chunkSize: number;
    embeddingModel: string;
    status: IndexStatus;
    chunkCount: number;
    // chunks that already hold a vector; a ready index has all of them
    embeddedCount: number;
    // the tokens the embedding model counted for the chunks embedded so far
    embeddingTokens: number;
    // times the build was tried and a batch kept failing while the model server was up
    attempts: number;
    // why a failed index failed, in words safe to show; null otherwise
    error: string | null;
    // the place in the line of every user's queued indexes (1 = the next one built); null when it is not queued
    queuePosition: number | null;
    createdAt: Date;
    queuedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
}

// How the build of one index ended, for the queue: "done" (ready, failed, or deleted meanwhile), "requeued" (the index went
// back to the queue and the queue should stop until its next round) or "cancelled" (its request was aborted: the worker
// is stopping, or the index or its document was deleted).
export type IndexBuildOutcome = "done" | "requeued" | "cancelled";

// The index the worker took from the queue: what it needs to build it, and whose it is (for the events).
export interface ClaimedIndex {
    id: string;
    documentId: string;
    userId: string;
    chunkSize: number;
    embeddingModel: string;
    chunkCount: number;
}
