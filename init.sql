-- =============================================================================
-- GenX Leadership Academy - Bounded Dual-Stream RAG
-- Database bootstrap (runs once, on first start of the postgres container)
-- =============================================================================

-- 1. pgvector ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Vector store: only approved Client Coaching sessions ever land here --------
--    Embedding model: bge-m3 (Ollama) -> 1024 dimensions.
CREATE TABLE IF NOT EXISTS knowledge_vault (
    id           BIGSERIAL    PRIMARY KEY,
    session_id   TEXT         NOT NULL,
    stream_type  TEXT         NOT NULL
                 CHECK (stream_type IN ('framework', 'voice_sample')),
    chunk_index  INTEGER      NOT NULL DEFAULT 0,
    content      TEXT         NOT NULL CHECK (length(btrim(content)) > 0),
    metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    embedding    vector(1024) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Makes re-running the ingestion workflow an idempotent UPSERT
    CONSTRAINT knowledge_vault_chunk_uq UNIQUE (session_id, stream_type, chunk_index)
);

-- 3. HNSW index using cosine distance (pairs with the <=> operator) -------------
--    m / ef_construction are the pgvector defaults, written out explicitly.
CREATE INDEX IF NOT EXISTS knowledge_vault_embedding_hnsw_idx
    ON knowledge_vault
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS knowledge_vault_stream_type_idx
    ON knowledge_vault (stream_type);

-- 4. Flat relational archive for rejected sessions ------------------------------
--    Internal ops / sales / low-confidence calls are kept for audit, but this
--    table deliberately has NO vector column: rejected content can never be
--    retrieved by the RAG pipeline.
CREATE TABLE IF NOT EXISTS archived_sessions (
    session_id        TEXT          PRIMARY KEY,
    title             TEXT,
    source_created_at TIMESTAMPTZ,
    meeting_type      TEXT          NOT NULL,
    confidence_score  NUMERIC(4,3)  NOT NULL DEFAULT 0,
    summary           TEXT,
    reject_reason     TEXT          NOT NULL,
    participants      JSONB         NOT NULL DEFAULT '[]'::jsonb,
    transcript        JSONB         NOT NULL DEFAULT '[]'::jsonb,
    classifier_raw    TEXT,
    archived_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
