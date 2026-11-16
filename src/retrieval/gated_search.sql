-- Gated vector search. $1 = query embedding as a pgvector literal '[0.1, ...]'
-- Similarity = 1 - cosine distance (<=>). Each stream has its own hard cutoff
-- and its own LIMIT, so a strong framework match cannot crowd out voice samples
-- (and vice versa). Anything under the bar never leaves the database.
WITH q AS (
    SELECT $1::vector(1024) AS v
),
frameworks AS (
    SELECT kv.id, kv.session_id, kv.stream_type, kv.chunk_index, kv.content, kv.metadata,
           1 - (kv.embedding <=> q.v) AS similarity
    FROM knowledge_vault kv, q
    WHERE kv.stream_type = 'framework'
      AND 1 - (kv.embedding <=> q.v) >= 0.70
    ORDER BY kv.embedding <=> q.v
    LIMIT 2
),
voice_samples AS (
    SELECT kv.id, kv.session_id, kv.stream_type, kv.chunk_index, kv.content, kv.metadata,
           1 - (kv.embedding <=> q.v) AS similarity
    FROM knowledge_vault kv, q
    WHERE kv.stream_type = 'voice_sample'
      AND 1 - (kv.embedding <=> q.v) >= 0.65
    ORDER BY kv.embedding <=> q.v
    LIMIT 2
)
SELECT * FROM frameworks
UNION ALL
SELECT * FROM voice_samples;
