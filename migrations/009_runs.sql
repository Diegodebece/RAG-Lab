-- One row for every question the API answered: the record of what ran. The daily limit of questions does not read it but
-- question_usage, below: a question that used the model counts even when its run was never stored.
-- Layer 5 stores retrieval runs only; layer 6 widens kind and status with its own migration.
CREATE TABLE runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('retrieval')),
    status text NOT NULL CHECK (status IN ('matched', 'no_match')),
    profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
    document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
    index_id uuid REFERENCES document_indexes (id) ON DELETE SET NULL,
    -- what ran: { kind, version, settings }. A configuration without a kind is refused too: the comparison with kind alone
    -- would be NULL for it, and a CHECK lets NULL through.
    configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object' AND configuration ? 'kind' AND configuration ->> 'kind' = kind),
    configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
    -- the question is never stored: its hash pairs the same question across runs, and its length is for the record
    question_hash text NOT NULL CHECK (question_hash ~ '^[0-9a-f]{64}$'),
    question_characters integer NOT NULL CHECK (question_characters BETWEEN 1 AND 1000),
    -- [{ chunkIndex, retrieval: "match" | "neighbor", score? }] in response order; never text
    fragments jsonb NOT NULL CHECK (jsonb_typeof(fragments) = 'array'),
    embedding_tokens integer NOT NULL CHECK (embedding_tokens >= 0),
    -- milliseconds, two decimals; BETWEEN also refuses NaN, which PostgreSQL sorts above every number
    wait_ms double precision NOT NULL CHECK (wait_ms BETWEEN 0 AND 3600000),
    embedding_ms double precision NOT NULL CHECK (embedding_ms BETWEEN 0 AND 3600000),
    retrieval_ms double precision NOT NULL CHECK (retrieval_ms BETWEEN 0 AND 3600000),
    total_ms double precision NOT NULL CHECK (total_ms BETWEEN 0 AND 3600000),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- one user's runs, by time: the foreign key's index
CREATE INDEX runs_user_id_created_at_idx ON runs (user_id, created_at);

-- runs of the same configuration, for the comparisons of later layers
CREATE INDEX runs_configuration_hash_idx ON runs (configuration_hash);

-- the other foreign keys (the SET NULL actions look for the rows that name what was deleted)
CREATE INDEX runs_profile_id_idx ON runs (profile_id);
CREATE INDEX runs_document_id_idx ON runs (document_id);
CREATE INDEX runs_index_id_idx ON runs (index_id);

-- insert-only for the API: a run is a record, never rewritten or given back. The SET NULL and CASCADE actions of the foreign
-- keys run with the rights of the table's owner, so deleting a profile, a document or an index still works.
REVOKE UPDATE, DELETE ON runs FROM rag_lab_api;

-- One row for every embedding the API did for a question, whether the embedding came back or the client hung up while it ran
-- (the model did the work either way), and whether or not the run was stored afterwards. The daily limit of questions counts
-- these rows, so a question cannot be repeated for free by hanging up. A question that never reached the model (a refusal, a
-- wait for the turn that was cancelled, a model server that failed) writes none.
CREATE TABLE question_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    used_at timestamptz NOT NULL DEFAULT now()
);

-- one user's questions of the last day (its first column is the foreign key's)
CREATE INDEX question_usage_user_id_used_at_idx ON question_usage (user_id, used_at);

-- written once and only ever counted
REVOKE UPDATE, DELETE ON question_usage FROM rag_lab_api;
