-- The profiles of each user: a name and only the settings the user changed. A setting that is not stored here comes
-- from the default profile when the configuration is resolved, so a profile does not repeat the defaults.
CREATE TABLE profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    -- the version of the settings' definition the stored settings were written for; the app writes it, there is no default
    version integer NOT NULL CHECK (version >= 1),
    settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- the default privileges of 002 grant UPDATE on every column; the API must never change the owner of a profile, its id or
-- its creation time, so it may update only the columns the service changes
REVOKE UPDATE ON profiles FROM rag_lab_api;
GRANT UPDATE (name, settings, version, updated_at) ON profiles TO rag_lab_api;

-- one name per user, whatever its capitalization; the index also serves the lookups by user (the foreign key's column
-- is its first one)
CREATE UNIQUE INDEX profiles_user_id_name_unique ON profiles (user_id, lower(name));
