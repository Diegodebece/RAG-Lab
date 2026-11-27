// What happens to an index while it is built. Every event names the index and its owner (each event goes only to its
// userId), and none of them carries the text of a document or a chunk.
export type IndexingEvent =
    | { type: "started"; indexId: string; userId: string }
    | { type: "progress"; indexId: string; userId: string; embeddedCount: number; chunkCount: number }
    | { type: "ready"; indexId: string; userId: string }
    | { type: "failed"; indexId: string; userId: string; error: string };

// everything the live stream can send; the events of questions join it in a later layer
export type LiveEvent = IndexingEvent;
