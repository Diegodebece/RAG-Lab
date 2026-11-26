-- Layer 1 creates no tables: only the pgvector extension the later layers store embeddings with.
-- Ids need no extension: gen_random_uuid() is built into PostgreSQL 13 and later.
CREATE EXTENSION IF NOT EXISTS vector;
