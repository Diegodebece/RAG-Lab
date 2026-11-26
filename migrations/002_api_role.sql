-- The API runs as the role rag_lab_api (created once by scripts/create-api-role.sql), which reads and changes rows and
-- nothing else: it cannot create, alter, drop or truncate anything, and it cannot change schema_migrations.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rag_lab_api') THEN
        RAISE EXCEPTION 'The role rag_lab_api does not exist: run scripts/create-api-role.sql first (see the README)';
    END IF;
END
$$;

-- nobody but the owner creates objects in the schema (PUBLIC held that right on PostgreSQL 14 and earlier)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rag_lab_api;

-- the server reads the applied migrations at startup; schema_migrations is made by the migration script before any
-- migration runs, so the default privileges below do not reach it
GRANT SELECT ON schema_migrations TO rag_lab_api;

-- the tables and sequences the owner creates from now on (users, and the tables of the next layers) are usable by the
-- API without a new grant; these defaults apply to objects created by the role that runs the migrations
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rag_lab_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rag_lab_api;
