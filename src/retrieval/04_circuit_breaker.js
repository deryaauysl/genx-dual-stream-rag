// =============================================================================
// Node: "Zero-Match Circuit Breaker"  (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// "Gated Vector Search" has "Always Output Data" ON, so when no row clears the
// thresholds it emits one empty item instead of stopping the workflow.
// This node collapses the rows into a single decision item:
//     match_count === 0  ->  IF node routes to the static fallback (no LLM call)
//     match_count  >  0  ->  context is handed to persona synthesis
// =============================================================================

const rows = $input.all()
  .map((i) => i.json)
  .filter((r) => r && typeof r.content === 'string' && r.content.trim() !== '');

const pick = (type) => rows
  .filter((r) => r.stream_type === type)
  .sort((a, b) => Number(b.similarity) - Number(a.similarity))
  .map((r) => ({
    session_id: r.session_id,
    stream_type: r.stream_type,
    chunk_index: r.chunk_index,
    similarity: Math.round(Number(r.similarity) * 1000) / 1000,
    content: r.content,
    framework_name: r.metadata?.framework_name ?? null,
  }));

const frameworks = pick('framework');
const voiceSamples = pick('voice_sample');

return [{
  json: {
    message: $('Intent Router').first().json.message,
    match_count: frameworks.length + voiceSamples.length,
    frameworks,
    voice_samples: voiceSamples,
    sources: [...new Set(rows.map((r) => r.session_id))],
  },
}];
