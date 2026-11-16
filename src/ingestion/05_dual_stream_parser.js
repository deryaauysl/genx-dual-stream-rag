// =============================================================================
// Node: "Dual-Stream Parser"         (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// Input : responses of "Framework Distiller (LLM)", paired with the approved
//         sessions from "Prepare Framework Distillation".
// Output: ONE item per chunk to embed, for both streams:
//
//   Stream 1  framework     dense conceptual takeaway of the coaching framework
//                           (LLM-distilled; extractive fallback if the LLM
//                           output is empty/unusable)
//   Stream 2  voice_sample  the coach's verbatim turns only, in 400-700 char
//                           chunks. Sentence boundaries are never cut, turns
//                           are separated by a blank line to keep the rhythm.
// =============================================================================

const MIN_CHARS = 400;
const MAX_CHARS = 700;
const IDEAL_CHARS = 550;

// ---------------------------------------------------------------------------
// Speaker filtering
// ---------------------------------------------------------------------------
/** The coach = the GenX team member who speaks the most in the session. */
function identifyCoach(session) {
  const team = new Set((session.participants ?? []).filter((p) => p.is_team_member).map((p) => p.name));
  const words = {};
  for (const t of session.transcript ?? []) {
    words[t.speaker] = (words[t.speaker] ?? 0) + String(t.text ?? '').split(/\s+/).length;
  }
  const ranked = Object.entries(words).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return ranked.find((n) => team.has(n)) ?? ranked.find((n) => /^dr\.?\s/i.test(n)) ?? ranked[0];
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Sentence splitting (protects "Dr.", "e.g." etc. from false splits)
// ---------------------------------------------------------------------------
const ABBREV = /\b(Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\./gi;
function splitSentences(text) {
  const protectedText = text.replace(ABBREV, (m) => m.replace(/\./g, '\u0000'));
  return protectedText
    .split(/(?<=[.!?]['"’”]?)\s+(?=['"‘“]?[A-Z0-9])/)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter(Boolean)
    .flatMap((s) => (s.length <= MAX_CHARS ? [s] : hardSplit(s)));
}
/** Only for a single sentence longer than MAX_CHARS: cut at word boundaries. */
function hardSplit(s) {
  const parts = [];
  let rest = s;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', MAX_CHARS);
    if (cut < MIN_CHARS) cut = MAX_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------------------------------------------------------------------------
// Voice chunking: optimal partition of sentence units into 400-700 char chunks
// ---------------------------------------------------------------------------
/** units: [{ text, turnIdx, timestamp }] -> joined text (blank line between turns) */
function joinUnits(units) {
  let out = '';
  units.forEach((u, k) => {
    if (k > 0) out += u.turnIdx === units[k - 1].turnIdx ? ' ' : '\n\n';
    out += u.text;
  });
  return out;
}

function chunkCost(len) {
  if (len >= MIN_CHARS && len <= MAX_CHARS) return ((len - IDEAL_CHARS) / 100) ** 2;
  const miss = len < MIN_CHARS ? MIN_CHARS - len : len - MAX_CHARS;
  return 1e6 + miss * miss; // out-of-bounds chunks only if nothing else is possible
}

/** Dynamic programming over sentence boundaries -> minimal total cost. */
function partition(units) {
  const n = units.length;
  const best = new Array(n + 1).fill(Infinity);
  const prev = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const len = joinUnits(units.slice(j, i)).length;
      if (len > MAX_CHARS && i - j > 1) break; // longer windows only get longer
      const c = best[j] + chunkCost(len);
      if (c < best[i]) { best[i] = c; prev[i] = j; }
    }
  }
  const ranges = [];
  for (let i = n; i > 0; i = prev[i]) ranges.unshift([prev[i], i]);
  return ranges;
}

/**
 * If a chunk is still below MIN_CHARS (total coach text did not divide cleanly
 * at sentence boundaries), borrow whole neighbouring sentences as overlap:
 * first the preceding ones, then the following ones, never exceeding MAX_CHARS.
 */
function applyOverlap(units, ranges) {
  const len = (s, e) => joinUnits(units.slice(s, e)).length;
  return ranges.map(([start, end]) => {
    let s = start;
    let e = end;
    while (s > 0 && len(s, e) < MIN_CHARS && len(s - 1, e) <= MAX_CHARS) s--;
    while (e < units.length && len(s, e) < MIN_CHARS && len(s, e + 1) <= MAX_CHARS) e++;
    return { start: s, end: e, overlap_units: (start - s) + (e - end) };
  });
}

function buildVoiceChunks(session, coach) {
  const turns = (session.transcript ?? [])
    .map((t, idx) => ({ ...t, idx }))
    .filter((t) => t.speaker === coach && clean(t.text));

  const units = turns.flatMap((t) =>
    splitSentences(clean(t.text)).map((text) => ({ text, turnIdx: t.idx, timestamp: t.timestamp })));
  if (units.length === 0) return [];

  return applyOverlap(units, partition(units)).map(({ start, end, overlap_units }) => {
    const slice = units.slice(start, end);
    const content = joinUnits(slice);
    return {
      content,
      speaker: coach,
      timestamps: [...new Set(slice.map((u) => u.timestamp))],
      turn_count: new Set(slice.map((u) => u.turnIdx)).size,
      char_count: content.length,
      within_bounds: content.length >= MIN_CHARS && content.length <= MAX_CHARS,
      overlap_sentences: overlap_units,
    };
  });
}

// ---------------------------------------------------------------------------
// Framework stream
// ---------------------------------------------------------------------------
function cleanDistilled(text) {
  return String(text ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function frameworkName(text) {
  const fromNote = text.match(/^\s*Framework:\s*(.+)$/im);
  if (fromNote) return fromNote[1].trim().replace(/[."]+$/, '');
  const fromTalk = text.match(/(?:framework called|we run the|we use the)\s+(?:the\s+)?([A-Z][\w-]*(?:\s+(?:[A-Z][\w-]*|and|with|of)){0,5})/);
  return fromTalk ? fromTalk[1].trim() : null;
}

/** Fallback if the LLM output is unusable: stitch the coach's teaching turns. */
function extractiveFramework(session, coach) {
  const coachTurns = (session.transcript ?? []).filter((t) => t.speaker === coach).map((t) => clean(t.text));
  const clientTurns = (session.transcript ?? []).filter((t) => t.speaker !== coach).map((t) => clean(t.text));
  const name = frameworkName(coachTurns.join(' ')) ?? `${session.title} coaching approach`;
  // Client's opening problem, minus a leading greeting sentence ("Hi Dr. Sara.")
  const problem = splitSentences(clientTurns[0] ?? session.summary ?? '')
    .filter((s, idx) => !(idx === 0 && /^(hi|hey|hello)\b/i.test(s))).join(' ');
  const keyQuestion = coachTurns.flatMap(splitSentences).find((s) => s.includes('?'))
    ?? coachTurns[coachTurns.length - 1] ?? '';
  return [
    `Framework: ${name}`,
    `Use when: ${problem}`,
    `Core idea: ${coachTurns.slice(0, 2).join(' ')}`,
    `Key question: ${keyQuestion}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const out = [];
$input.all().forEach((item, i) => {
  const session = $('Prepare Framework Distillation').itemMatching(i).json;
  const coach = identifyCoach(session);

  const distilled = cleanDistilled(item.json?.message?.content);
  const useLlm = !item.json?.error && distilled.length >= 120 && /framework:/i.test(distilled);
  const frameworkText = useLlm ? distilled : extractiveFramework(session, coach);

  const shared = {
    title: session.title,
    session_date: session.source_created_at,
    coach,
    client: (session.participants ?? []).filter((p) => !p.is_team_member).map((p) => p.name),
    meeting_type: session.meeting_type,
    classifier_confidence: session.confidence_score,
    classifier_summary: session.summary,
  };

  // Stream 1: framework
  const frameworks = [{
    content: frameworkText,
    metadata: { ...shared, framework_name: frameworkName(frameworkText), source: useLlm ? 'llm_distilled' : 'extractive_fallback', char_count: frameworkText.length },
  }];

  // Stream 2: voice_sample
  const voices = buildVoiceChunks(session, coach).map(({ content, ...meta }) => ({
    content,
    metadata: { ...shared, ...meta },
  }));

  const emit = (stream_type, arr) => arr.forEach((c, idx) => out.push({
    json: {
      session_id: session.session_id,
      stream_type,
      chunk_index: idx,
      chunk_total: arr.length,
      content: c.content,
      metadata: c.metadata,
    },
    pairedItem: { item: i },
  }));

  emit('framework', frameworks);
  emit('voice_sample', voices);
});

return out;
