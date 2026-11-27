-- One row for every index build the API accepts. The daily limits count these rows, so deleting a document or an index
-- does not give a build back.
CREATE TABLE index_build_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    accepted_at timestamptz NOT NULL DEFAULT now()
);

-- one user's builds of the last day (its first column is the foreign key's)
CREATE INDEX index_build_usage_user_id_accepted_at_idx ON index_build_usage (user_id, accepted_at);

-- every user's builds of the last day
CREATE INDEX index_build_usage_accepted_at_idx ON index_build_usage (accepted_at);

-- written once and only ever counted
REVOKE UPDATE, DELETE ON index_build_usage FROM rag_lab_api;
