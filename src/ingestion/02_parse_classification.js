// =============================================================================
// Node: "Parse & Validate Classification"   (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// Input : responses of the "Classification Agent" HTTP node (Ollama /api/chat).
//         That node has "On Error: Continue", so an item may be an error object.
// Output: the original session + a normalised, always-valid classification:
//           meeting_type     one of the 4 allowed labels
//           confidence_score number clamped to [0, 1]
//           summary          string
//         Anything malformed degrades to { "Other", 0 } -> it gets ARCHIVED,
//         never ingested. The gate fails closed.
// =============================================================================

const ALLOWED = ['Client Coaching', 'Internal Operations', 'Sales Discovery', 'Other'];

/** Pull the first JSON object out of an LLM reply (handles ```json fences / chatter). */
function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

/** Map near-misses ("client coaching session", "SALES") onto the allowed labels. */
function normaliseType(value) {
  const v = String(value ?? '').toLowerCase().trim();
  const exact = ALLOWED.find((a) => a.toLowerCase() === v);
  if (exact) return exact;
  if (v.includes('coach')) return 'Client Coaching';
  if (v.includes('internal') || v.includes('operation')) return 'Internal Operations';
  if (v.includes('sales') || v.includes('discovery')) return 'Sales Discovery';
  return 'Other';
}

/** Accept 0.92, "0.92", "92%", 92 -> 0.92. Garbage -> 0. */
function normaliseConfidence(value) {
  let n = typeof value === 'string' ? parseFloat(value.replace('%', '')) : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) n = n / 100;
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

const out = [];
$input.all().forEach((item, i) => {
  const session = $('Bounded Sampler').itemMatching(i).json;
  const res = item.json ?? {};

  const raw = res?.message?.content ?? res?.response ?? null;
  const parsed = res.error ? null : extractJson(raw);

  let classification;
  if (parsed && typeof parsed === 'object') {
    classification = {
      meeting_type: normaliseType(parsed.meeting_type),
      confidence_score: normaliseConfidence(parsed.confidence_score),
      summary: String(parsed.summary ?? '').trim(),
      parse_ok: true,
    };
  } else {
    classification = {
      meeting_type: 'Other',
      confidence_score: 0,
      summary: '',
      parse_ok: false,
      parse_error: res.error ? `LLM call failed: ${res.error.message ?? JSON.stringify(res.error)}` : 'Could not parse classifier output as JSON',
    };
  }

  // Drop the large request payload, keep everything the next nodes need.
  const { classifier_request, ...rest } = session;
  out.push({
    json: {
      ...rest,
      ...classification,
      classifier_raw: typeof raw === 'string' ? raw : JSON.stringify(raw ?? res),
    },
    pairedItem: { item: i },
  });
});

return out;
