-- The accounts. There is no self-registration: the first admin comes from `npm run create-admin`, and admins create
-- the rest. The role and the status are read from here on every request, so a change applies at once.
CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL CHECK (char_length(email) <= 254),
    -- "scrypt$N$r$p$salt$hash", see utils/password.util.ts; never returned by the API
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    -- a token is valid only while its version is this one: logout, a password change and disabling an account raise it
    token_version integer NOT NULL DEFAULT 0 CHECK (token_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- one account per email, whatever its capitalization
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
