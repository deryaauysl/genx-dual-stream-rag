// =============================================================================
// Node: "Static Greeting"            (Code node - Run Once for Each Item)
// No DB lookup, no embedding, no LLM call.
// =============================================================================

const output = $json.intent === 'empty'
  ? 'Ask me a leadership question and I will answer from Dr. Sara Hegy\'s documented coaching frameworks.'
  : 'Hi! I\'m the GenX coaching assistant. I answer from Dr. Sara Hegy\'s documented coaching frameworks. '
    + 'Try asking: "How should I approach an underperforming VP?"';

return { json: { output, route: 'greeting', llm_called: false, db_queried: false } };
