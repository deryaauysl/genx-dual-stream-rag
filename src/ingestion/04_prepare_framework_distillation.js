// =============================================================================
// Node: "Prepare Framework Distillation"   (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// For every APPROVED coaching session, build an Ollama /api/chat request that
// condenses the full transcript into a dense framework note (Stream 1).
// The note follows a fixed, positively-phrased template, including a
// "Use when" line written in the words a leader would use when asking,
// which makes the note easy to match against real questions.
// =============================================================================

const LLM_MODEL = $env.LLM_MODEL || 'llama3.2';

const DISTILLER_SYSTEM = [
  'You turn an executive-coaching session into a dense framework note for a coaching knowledge base.',
  'Build the note only from ideas the coach actually expressed in the transcript.',
  '',
  'Write plain text in exactly this layout:',
  'Framework: <the name the coach used, or a short descriptive name>',
  'Use when: <the leadership situations it applies to, in the plain words a leader would use when asking for help>',
  'Core idea: <two or three sentences>',
  'How to apply: <three to five short numbered steps>',
  'Key question: <the diagnostic question or signature line the coach used>',
  '',
  'Keep the whole note under 900 characters.',
].join('\n');

return $input.all().map((item) => {
  const s = item.json;
  const transcriptText = (s.transcript ?? [])
    .map((t) => `${t.speaker}: ${String(t.text ?? '').trim()}`)
    .join('\n');

  return {
    json: {
      ...s,
      distiller_request: {
        model: LLM_MODEL,
        stream: false,
        options: { temperature: 0.2 },
        messages: [
          { role: 'system', content: DISTILLER_SYSTEM },
          {
            role: 'user',
            content: `Session ${s.session_id} - "${s.title}"\nClassifier summary: ${s.summary}\n\nFull transcript:\n${transcriptText}`,
          },
        ],
      },
    },
  };
});
