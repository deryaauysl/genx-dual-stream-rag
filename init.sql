CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_vault (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (stream_type IN ('framework', 'voice_sample')),
  content     TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  embedding   vector(1024)
);

CREATE INDEX IF NOT EXISTS knowledge_vault_embedding_idx
  ON knowledge_vault
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS archived_sessions (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  title           TEXT,
  meeting_type    TEXT,
  confidence_score FLOAT,
  summary         TEXT,
  raw_transcript  JSONB DEFAULT '[]',
  archived_at     TIMESTAMP DEFAULT NOW()
);
