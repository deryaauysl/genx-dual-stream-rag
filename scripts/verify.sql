-- Verification queries for the README "Verification Log".
-- Run:  docker exec -i genx-postgres psql -U genx -d genx_rag < scripts/verify.sql

\echo '--- 1. knowledge_vault: only approved coaching sessions, two streams each ---'
SELECT session_id, stream_type, chunk_index, length(content) AS chars,
       metadata->>'framework_name' AS framework, metadata->>'source' AS fw_source,
       vector_dims(embedding) AS dims
FROM knowledge_vault
ORDER BY session_id, stream_type, chunk_index;

\echo '--- 2. archived_sessions: rejected by the classification gate (no vectors) ---'
SELECT session_id, meeting_type, confidence_score, reject_reason
FROM archived_sessions
ORDER BY session_id;

\echo '--- 3. Firewall check: rejected sessions present in the vector store (expect 0 rows) ---'
SELECT kv.session_id FROM knowledge_vault kv JOIN archived_sessions a USING (session_id);

\echo '--- 4. HNSW index definition ---'
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'knowledge_vault' AND indexdef ILIKE '%hnsw%';

\echo '--- 5. Query plan uses the HNSW index (seq scan disabled only because the table is tiny) ---'
SET enable_seqscan = off;
EXPLAIN (COSTS OFF)
SELECT id FROM knowledge_vault
ORDER BY embedding <=> (SELECT embedding FROM knowledge_vault LIMIT 1)
LIMIT 2;
RESET enable_seqscan;
