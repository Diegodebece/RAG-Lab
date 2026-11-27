-- The documents users upload: the cleaned text is stored once, and every index of it (one per chunk size and embedding
-- model) is built from it. The API writes a document once and never changes it.
CREATE TABLE documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
    text text NOT NULL CHECK (text <> ''),
    -- in UTF-16 code units, the unit of the limits (the length of a JavaScript string)
    character_count integer NOT NULL CHECK (character_count > 0),
    -- the SHA-256 of the stored text, in lowercase hexadecimal
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- one copy of the same text per user; the index also serves the lookups by user (the foreign key's column is its first one)
CREATE UNIQUE INDEX documents_user_id_content_hash_unique ON documents (user_id, content_hash);

-- the default privileges of 002 grant UPDATE on every column; a document is never changed after it is stored, and its owner
-- must never change
REVOKE UPDATE ON documents FROM rag_lab_api;
