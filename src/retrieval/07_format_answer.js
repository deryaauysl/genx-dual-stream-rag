// =============================================================================
// Node: "Format Answer"              (Code node - Run Once for Each Item)
// Final output for both the Chat UI (reads `output`) and the webhook caller.
// Sources are appended by code, not by the LLM, so citations are always exact.
// =============================================================================

const ctx = $('Build Persona Prompt').item.json;
const answer = String($json.message?.content ?? '').trim();

const cite = [...ctx.frameworks, ...ctx.voice_samples]
  .map((c) => `${c.session_id} ${c.stream_type} #${c.chunk_index} (sim ${c.similarity})`)
  .join(' | ');

return {
  json: {
    output: `${answer}\n\n— Sources: ${cite}`,
    route: 'persona_answer',
    llm_called: true,
    match_count: ctx.match_count,
    sources: ctx.sources,
    retrieved: [...ctx.frameworks, ...ctx.voice_samples].map(({ content, ...rest }) => rest),
  },
};
