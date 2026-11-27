// The constants of indexing: what the code relies on and the user never changes. The limits on how much a user may
// index are in limits.config.ts, and the chunk sizes and models a user may choose are in configuration.config.ts.

// the dimensions of the vectors the embedding model returns and the chunks table stores (vector(1024) in migration 007);
// changing the embedding model for one with other dimensions needs a migration
export const EMBEDDING_DIMENSIONS = 1024;

// the largest number a float4 holds (the type pgvector stores each dimension in); a vector with a larger one cannot be stored
export const FLOAT4_MAX = 3.4028234663852886e38;

// chunks sent to the embedding model in one request; each answer is stored before the next batch starts, so a
// stopped build keeps what it embedded
export const EMBEDDING_BATCH_SIZE = 10;

// how often the worker looks for queued builds when nothing has woken it, in milliseconds (a new build wakes it at once)
export const INDEXING_POLL_INTERVAL_MS = 10_000;

// a build in the "indexing" state for longer than this, that the worker is not running, is put back in the queue
export const STUCK_INDEX_BUILD_SECONDS = 60;

// times a build is tried while Ollama is up and a batch keeps failing, before the index is marked as failed
export const MAX_INDEXING_ATTEMPTS = 3;

// how long the check of what the model server has installed may take after a batch failed, in milliseconds (the health
// check's value): a server that does not answer this quickly is counted as away
export const MODEL_PROBE_TIMEOUT_MS = 2000;

// the longest filename of a document, in characters (the documents table checks the same number)
export const FILENAME_MAX_LENGTH = 255;
