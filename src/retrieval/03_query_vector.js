// =============================================================================
// Node: "Validate Query Vector"      (Code node - Run Once for Each Item)
// Turns the Ollama /api/embed response into a pgvector literal for $1.
// =============================================================================

const EXPECTED_DIM = 1024;
const vec = $json.embeddings?.[0] ?? $json.embedding;

if (!Array.isArray(vec) || vec.length !== EXPECTED_DIM || !vec.every(Number.isFinite)) {
  throw new Error(`Query embedding invalid: expected ${EXPECTED_DIM} dims, got ${Array.isArray(vec) ? vec.length : typeof vec}.`);
}

return {
  json: {
    message: $('Intent Router').item.json.message,
    query_vector: `[${vec.join(',')}]`,
  },
};
