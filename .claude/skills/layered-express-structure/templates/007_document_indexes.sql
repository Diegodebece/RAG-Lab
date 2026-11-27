-- One index per document, chunk size and embedding model. The row is also the indexing queue: its status says whether it
-- waits, is being built, is ready or failed.
-- The list of chunk sizes and models the API accepts is in the code (configuration.config.ts), so it can widen without a
-- migration; here only what can never be right is refused.
CREATE TABLE document_indexes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    chunk_size integer NOT NULL CHECK (chunk_size >= 2),
    embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'indexing', 'ready', 'failed')),
    chunk_count integer NOT NULL CHECK (chunk_count > 0),
    embedded_count integer NOT NULL DEFAULT 0 CHECK (embedded_count BETWEEN 0 AND chunk_count),
    embedding_tokens integer NOT NULL DEFAULT 0 CHECK (embedding_tokens >= 0),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    error text CHECK (char_length(error) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CHECK (status <> 'ready' OR embedded_count = chunk_count),
    -- also the index of the lookups by document (its first column is the foreign key)
    UNIQUE (document_id, chunk_size, embedding_model)
);

-- finds the next build of the queue
CREATE INDEX document_indexes_status_queued_at_idx ON document_indexes (status, queued_at, id);

-- the default privileges of 002 grant UPDATE on every column; only what a build changes may be updated, never the document,
-- the size, the model or the number of chunks of an index
REVOKE UPDATE ON document_indexes FROM rag_lab_api;
GRANT UPDATE (status, embedded_count, embedding_tokens, attempts, error, queued_at, started_at, finished_at) ON document_indexes TO rag_lab_api;

-- The pieces of an index and their vectors. The rows are written when the build is queued, without a vector; the build
-- fills the vectors in. There is no vector index: retrieval compares the chunks of one index, a few hundred rows.
CREATE TABLE chunks (
    index_id uuid NOT NULL REFERENCES document_indexes (id) ON DELETE CASCADE,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    text text NOT NULL CHECK (text <> ''),
    embedding vector(1024),
    PRIMARY KEY (index_id, chunk_index)
);

-- a chunk gets its vector and nothing else; the chunks of a deleted index go with it through the foreign key's cascade
REVOKE UPDATE, DELETE ON chunks FROM rag_lab_api;
GRANT UPDATE (embedding) ON chunks TO rag_lab_api;
