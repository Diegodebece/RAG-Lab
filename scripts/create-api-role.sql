-- The API's database role: it reads and changes rows, nothing else. Run once as the owner (rag_lab), after
-- creating rag_lab_test; then set its password with \password rag_lab_api. Its rights on tables come from
-- migrations/002_api_role.sql, so the test database gets them again on every reset.
CREATE ROLE rag_lab_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE rag_lab, rag_lab_test FROM PUBLIC;
GRANT CONNECT ON DATABASE rag_lab, rag_lab_test TO rag_lab_api;
