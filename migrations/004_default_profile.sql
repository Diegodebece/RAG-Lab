-- The default profile: the settings every question uses when a profile or a request does not say otherwise. One row,
-- written here. The values are RAG Web's, so a question asked through RAG Lab starts from the configuration whose
-- results are already known. `singleton` is always true and the primary key, so a second row is impossible.
CREATE TABLE default_profile (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    -- the version of the settings' definition (see config/configuration.config.ts); a new version needs a migration
    version integer NOT NULL CHECK (version >= 1),
    settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO default_profile (version, settings) VALUES (
    1,
    '{
        "chunkSize": 1000,
        "embeddingModel": "qwen3-embedding:0.6b",
        "retrievalMode": "vector",
        "topK": 3,
        "minScore": 0.3,
        "neighborWindow": 1,
        "smallModel": "qwen3.5:4b",
        "temperature": 0,
        "maxTokens": 1024,
        "answerLanguage": "en",
        "answerMode": "baseline"
    }'::jsonb
);

-- the default privileges of 002 grant all four rights; the API only reads the default, and a migration changes it
REVOKE INSERT, UPDATE, DELETE ON default_profile FROM rag_lab_api;
