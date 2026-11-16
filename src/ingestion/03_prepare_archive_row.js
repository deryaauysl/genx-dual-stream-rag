// =============================================================================
// Node: "Prepare Archive Row"        (Code node - Run Once for All Items)
// -----------------------------------------------------------------------------
// Receives every session the Ingestion Gate rejected (Internal Operations,
// Sales Discovery, Other, or Client Coaching below the 0.80 confidence bar)
// and shapes it into a flat relational row. No embedding is ever computed here.
// =============================================================================

const MIN_CONFIDENCE = 0.8;

return $input.all().map((item) => {
  const s = item.json;
  const reason = s.meeting_type === 'Client Coaching'
    ? `low_confidence (${s.confidence_score} < ${MIN_CONFIDENCE})`
    : `classified_as_${s.meeting_type.toLowerCase().replace(/\s+/g, '_')}`;

  return {
    json: {
      session_id: s.session_id,
      title: s.title,
      source_created_at: s.source_created_at,
      meeting_type: s.meeting_type,
      confidence_score: s.confidence_score,
      summary: s.summary,
      reject_reason: s.parse_ok === false ? `unparseable_classification: ${s.parse_error}` : reason,
      participants_json: JSON.stringify(s.participants ?? []),
      transcript_json: JSON.stringify(s.transcript ?? []),
      classifier_raw: s.classifier_raw ?? null,
    },
  };
});
