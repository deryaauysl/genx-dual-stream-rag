// =============================================================================
// Node: "Bounded Sampler"            (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// Input : output of "Parse JSON File" -> one item whose json.data is the array
//         of sessions from data/mock_transcripts.json. (Also tolerates one item
//         per session, in case the file is fed in a different way.)
// Output: ONE item per session, carrying
//           - the full session (needed later by the dual-stream parser)
//           - a bounded sample: first 40 turns + last 20 turns
//           - a ready-to-send Ollama /api/chat request for the classifier
// =============================================================================

const HEAD_TURNS = 40;
const TAIL_TURNS = 20;
const LLM_MODEL = $env.LLM_MODEL || 'llama3.2';

// ---- 1. Collect sessions regardless of how the file was unwrapped ----------
const sessions = [];
for (const item of $input.all()) {
  const j = item.json ?? {};
  if (Array.isArray(j.data)) sessions.push(...j.data);
  else if (Array.isArray(j.sessions)) sessions.push(...j.sessions);
  else if (Array.isArray(j.transcript)) sessions.push(j);
}

if (sessions.length === 0) {
  throw new Error('Bounded Sampler: no sessions found. Expected a JSON array of sessions with a "transcript" array.');
}

// ---- 2. Helpers -------------------------------------------------------------
/**
 * First HEAD + last TAIL turns. If the transcript is short enough that the two
 * windows would overlap, the whole transcript is returned once (no duplicates).
 */
function boundedSample(turns, head = HEAD_TURNS, tail = TAIL_TURNS) {
  if (turns.length <= head + tail) {
    return { turns: turns.slice(), truncated: false, omitted: 0 };
  }
  return {
    turns: [...turns.slice(0, head), ...turns.slice(-tail)],
    truncated: true,
    omitted: turns.length - head - tail,
  };
}

function roleOf(speaker, participants) {
  const p = participants.find((x) => x.name === speaker);
  if (!p) return 'unknown';
  return p.is_team_member ? 'GenX team member' : 'external guest';
}

function renderTurns(turns, participants, truncated, omitted) {
  const lines = [];
  turns.forEach((t, i) => {
    if (truncated && i === HEAD_TURNS) lines.push(`... [${omitted} middle turns omitted] ...`);
    lines.push(`[${t.timestamp ?? '--:--:--'}] ${t.speaker} (${roleOf(t.speaker, participants)}): ${String(t.text ?? '').trim()}`);
  });
  return lines.join('\n');
}

// ---- 3. Classifier prompt (strict JSON via Ollama structured outputs) ------
const CLASSIFIER_SYSTEM = [
  'You are the ingestion gatekeeper for the GenX Leadership Academy coaching knowledge base.',
  'Read the meeting sample and decide which kind of meeting it is.',
  '',
  'Categories:',
  '- "Client Coaching": a coach works with an external client on leadership, wellbeing, delegation, team dynamics, feedback or personal performance.',
  '- "Internal Operations": GenX team members talk among themselves about engineering, tooling, CRM, sprints, deployments, admin or internal process.',
  '- "Sales Discovery": a conversation about buying coaching services: pricing, budget, retainers, contracts, pilots, proposals or scope of work.',
  '- "Other": anything else, or not enough signal to decide.',
  '',
  'confidence_score is your probability (0.0 to 1.0) that meeting_type is correct.',
  'summary is one or two sentences describing what the meeting was about.',
  'Answer with a single JSON object: {"meeting_type": "...", "confidence_score": 0.0, "summary": "..."}',
].join('\n');

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    meeting_type: {
      type: 'string',
      enum: ['Client Coaching', 'Internal Operations', 'Sales Discovery', 'Other'],
    },
    confidence_score: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['meeting_type', 'confidence_score', 'summary'],
};

// ---- 4. Emit one item per session --------------------------------------------
return sessions.map((s) => {
  const participants = Array.isArray(s.participants) ? s.participants : [];
  const transcript = Array.isArray(s.transcript) ? s.transcript : [];
  const sample = boundedSample(transcript);
  const sampleText = renderTurns(sample.turns, participants, sample.truncated, sample.omitted);

  const participantLine = participants
    .map((p) => `${p.name} (${p.is_team_member ? 'GenX team member' : 'external guest'})`)
    .join(', ');

  return {
    json: {
      session_id: s.id,
      title: s.title ?? '',
      source_created_at: s.created_at ?? null,
      participants,
      transcript,
      turn_count: transcript.length,
      sample_turn_count: sample.turns.length,
      sample_truncated: sample.truncated,
      sample_text: sampleText,
      classifier_request: {
        model: LLM_MODEL,
        stream: false,
        format: CLASSIFIER_SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM },
          {
            role: 'user',
            content: `Meeting title: ${s.title ?? '(none)'}\nParticipants: ${participantLine}\n\nTranscript sample (${sample.turns.length} of ${transcript.length} turns):\n${sampleText}`,
          },
        ],
      },
    },
  };
});
