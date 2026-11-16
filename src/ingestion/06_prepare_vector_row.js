// =============================================================================
// Node: "Prepare Vector Row"         (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// Pairs each Ollama /api/embed response with its chunk and validates the
// vector before it touches the database: right dimension, finite numbers.
// A bad embedding stops the run loudly instead of silently corrupting the vault.
// =============================================================================

const EXPECTED_DIM = 1024; // bge-m3; must match vector(1024) in init.sql

return $input.all().map((item, i) => {
  const chunk = $('Dual-Stream Parser').itemMatching(i).json;
  const vec = item.json?.embeddings?.[0] ?? item.json?.embedding;

  if (!Array.isArray(vec) || vec.length !== EXPECTED_DIM || !vec.every(Number.isFinite)) {
    throw new Error(
      `Embedding for ${chunk.session_id}/${chunk.stream_type}#${chunk.chunk_index} is invalid ` +
      `(got ${Array.isArray(vec) ? vec.length : typeof vec} dims, expected ${EXPECTED_DIM}). ` +
      'Check that EMBED_MODEL is bge-m3 and Ollama is reachable.',
    );
  }

  return {
    json: {
      session_id: chunk.session_id,
      stream_type: chunk.stream_type,
      chunk_index: chunk.chunk_index,
      chunk_total: chunk.chunk_total,
      content: chunk.content,
      metadata_json: JSON.stringify({ ...chunk.metadata, embed_model: item.json?.model ?? 'bge-m3' }),
      embedding_literal: `[${vec.join(',')}]`, // pgvector text format
    },
    pairedItem: { item: i },
  };
});
