import { pool } from "../config/db.config.js";
import { INDEXING_POLL_INTERVAL_MS, STUCK_INDEX_BUILD_SECONDS } from "../config/indexing.config.js";
import type { ClaimedIndex } from "../types/documentIndexes.type.js";
import { runIndexBuildService } from "./indexing.service.js";

// The indexing queue: the rows of document_indexes with the status "queued" are the line, and one worker builds one index at
// a time, the one that has waited longest first. This file decides which index runs and when; the work of one index is in
// indexing.service.ts.

// the reason the worker gives when it aborts the build in flight because it is stopping, as opposed to an index or a
// document that was deleted
const STOP_REASON = "The indexing worker is stopping";
const DELETED_REASON = "The index or its document was deleted";

interface RunningBuild {
    controller: AbortController;
    // null until the queue has claimed an index for this run
    indexId: string | null;
    documentId: string | null;
}

// the build this process is running, if any
let running: RunningBuild | null = null;
let draining: Promise<void> | null = null;
let stopRequested = false;
let workerStarted = false;
let pollTimer: NodeJS.Timeout | null = null;

// Takes the index that has waited longest and marks it as indexing. SKIP LOCKED keeps two workers (if there ever were two)
// from taking the same index. The owner is read in the same statement, for the events.
const claimNextIndex = async (): Promise<ClaimedIndex | null> => {
    const { rows } = await pool.query<ClaimedIndex>(
        `UPDATE document_indexes SET status = 'indexing', started_at = now()
         WHERE id = (
             SELECT id FROM document_indexes WHERE status = 'queued'
             ORDER BY queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, document_id AS "documentId",
                   (SELECT user_id FROM documents WHERE documents.id = document_indexes.document_id) AS "userId",
                   chunk_size AS "chunkSize", embedding_model AS "embeddingModel", chunk_count AS "chunkCount"`
    );

    return rows[0] ?? null;
};

// Builds queued indexes one at a time until the queue is empty, a build was put back in the queue (the model server is away,
// or a batch failed and the index waits for its next try) or the worker is stopped. Calls made while it runs share the same
// run, so an index is never built twice in parallel.
export const processQueuedIndexesService = async (): Promise<void> => {
    if (draining) {
        return draining;
    }

    // a stop asked for before this run is not about it
    stopRequested = false;

    draining = (async () => {
        try {
            while (!stopRequested) {
                const slot: RunningBuild = { controller: new AbortController(), indexId: null, documentId: null };
                running = slot;

                try {
                    const claimed = await claimNextIndex();

                    if (!claimed) {
                        return;
                    }

                    slot.indexId = claimed.id;
                    slot.documentId = claimed.documentId;

                    // a stop that came while the index was being claimed aborted the signal already: the build puts the
                    // index back in the queue without sending anything
                    if ((await runIndexBuildService(claimed, slot.controller.signal)) === "requeued") {
                        return;
                    }
                } finally {
                    running = null;
                }
            }
        } finally {
            draining = null;
        }
    })();

    return draining;
};

// The queue runs in the background: an error (for example the database going away) is logged, the index stays as it was,
// and the next poll or the next restart picks it up again.
const runQueueInBackground = async (): Promise<void> => {
    try {
        await processQueuedIndexesService();
    } catch (error) {
        console.error(`The indexing queue stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
};

// Called after an index was queued. An idle worker takes it at once; while it is busy, or before server.ts starts the
// worker, the index waits. Tests and scripts that import the app never start indexing on their own.
export const notifyIndexQueuedService = (): void => {
    if (workerStarted && !draining) {
        void runQueueInBackground();
    }
};

// Aborts the request of the build this process is running when it is the one named, by its index or by its document: the
// API calls it after it deleted the index or the document, so the model server stops working on chunks nobody wants.
// Does nothing when another index (or none) is being built.
export const abortIndexBuildService = (target: { indexId: string } | { documentId: string }): void => {
    if (!running) {
        return;
    }

    const matches = "indexId" in target ? running.indexId === target.indexId : running.documentId === target.documentId;

    if (matches) {
        running.controller.abort(DELETED_REASON);
    }
};

// An error after an index was claimed (the database failing in the middle, for example) can leave it "indexing": it would
// never be built again while the API lives, and its owner could not start another build. This puts such indexes back in the
// queue, keeping their vectors: every index that is still "indexing" a minute after it started and is not the one this
// process runs (one API process builds one index at a time). Returns how many it moved.
export const requeueStuckIndexBuildsService = async (): Promise<number> => {
    const { rowCount } = await pool.query(
        `UPDATE document_indexes SET status = 'queued', started_at = NULL
         WHERE status = 'indexing' AND id IS DISTINCT FROM $1::uuid AND started_at < now() - make_interval(secs => $2)`,
        [running?.indexId ?? null, STUCK_INDEX_BUILD_SECONDS]
    );

    return rowCount ?? 0;
};

// Every INDEXING_POLL_INTERVAL_MS: put stuck builds back, then start the worker if it is idle.
const pollQueue = async (): Promise<void> => {
    try {
        const requeued = await requeueStuckIndexBuildsService();

        if (requeued > 0) {
            console.log(`Requeued ${requeued} stuck index build(s)`);
        }
    } catch (error) {
        console.error(`Could not look for stuck index builds: ${error instanceof Error ? error.message : String(error)}`);
    }

    notifyIndexQueuedService();
};

export const startIndexingWorkerService = (): void => {
    if (workerStarted) {
        return;
    }

    workerStarted = true;
    notifyIndexQueuedService();
    // the timer does not keep the process alive; the server's own listener does
    pollTimer = setInterval(() => void pollQueue(), INDEXING_POLL_INTERVAL_MS);
    pollTimer.unref();
};

// Stops the worker and waits until the build in flight has ended: its request to the model server is aborted, and its index
// goes back to the queue (not "failed") with the vectors it has stored, to be continued at the next start. Safe to call when
// the worker is idle or was never started, and more than once.
export const stopIndexingWorkerService = async (): Promise<void> => {
    workerStarted = false;

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    if (!draining) {
        return;
    }

    stopRequested = true;
    running?.controller.abort(STOP_REASON);

    try {
        await draining;
    } catch {
        // the run reports its own errors; the stop only waits for it to end
    }
};

// Run once at startup, before the worker: an index that was being built when the API stopped goes back to the queue, keeping
// its vectors and tokens, and the attempts it had (an interrupted build is not a failed attempt). Returns how many.
export const recoverIndexBuildsService = async (): Promise<number> => {
    const { rowCount } = await pool.query("UPDATE document_indexes SET status = 'queued', started_at = NULL WHERE status = 'indexing'");

    return rowCount ?? 0;
};
