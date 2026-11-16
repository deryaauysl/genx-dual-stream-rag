// =============================================================================
// Node: "Fallback Response"          (Code node - Run Once for Each Item)
// Reached only when zero chunks cleared the similarity gate.
// The persona LLM node is never executed on this path.
// =============================================================================

return {
  json: {
    output: 'No documented coaching frameworks match this topic.',
    route: 'circuit_breaker',
    llm_called: false,
    match_count: 0,
  },
};
