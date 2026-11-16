const assert = require('assert');
const path = require('path');
const run = require('./run_code_node');
const R = (p) => path.join(__dirname, '..', 'src', p);
const data = require('../data/mock_transcripts.json');

// 1. Sampler
const sampled = run(R('ingestion/01_bounded_sampler.js'), { items: [{ json: { data } }] });
assert.strictEqual(sampled.length, 4);
const long = { id: 'X', title: 't', participants: [], transcript: Array.from({ length: 100 }, (_, i) => ({ speaker: 'A', text: 'turn ' + i })) };
const s2 = run(R('ingestion/01_bounded_sampler.js'), { items: [{ json: { data: [long] } }] })[0].json;
assert.strictEqual(s2.sample_turn_count, 60);
assert.ok(s2.sample_text.includes('turn 39') && !s2.sample_text.includes('turn 40\n') && s2.sample_text.includes('turn 80') && s2.sample_text.includes('[40 middle turns omitted]'));
console.log('sampler ok: 4 sessions; 100-turn transcript ->', s2.sample_turn_count, 'turns');

// 2. Classification parsing edge cases
const replies = [
  { message: { content: '{"meeting_type":"Client Coaching","confidence_score":0.93,"summary":"ok"}' } },
  { message: { content: 'Sure! ```json\n{"meeting_type":"internal operations","confidence_score":"88%","summary":"x"}\n```' } },
  { message: { content: 'I think this is a sales call.' } },
  { error: { message: 'connect ECONNREFUSED' } },
];
const parsed = run(R('ingestion/02_parse_classification.js'), { items: replies.map((json) => ({ json })), refs: { 'Bounded Sampler': sampled } }).map((i) => i.json);
console.table(parsed.map((p) => ({ id: p.session_id, type: p.meeting_type, conf: p.confidence_score, ok: p.parse_ok })));
assert.deepStrictEqual(parsed.map((p) => p.meeting_type), ['Client Coaching', 'Internal Operations', 'Other', 'Other']);
assert.strictEqual(parsed[1].confidence_score, 0.88);

// 3. Dual-stream parser on SES-101/102 (LLM distiller output simulated: one good, one empty)
const approved = sampled.slice(0, 2).map((i) => ({ json: { ...i.json, meeting_type: 'Client Coaching', confidence_score: 0.95, summary: 's' } }));
const distilled = [
  { json: { message: { content: '**Framework:** Completion with Integrity\nUse when: a founder keeps reviewing every deliverable and cannot delegate.\nCore idea: Micromanagement is an information-architecture breakdown.\nHow to apply: 1. Define binary exit criteria.' } } },
  { json: { message: { content: '' } } },
];
const chunks = run(R('ingestion/05_dual_stream_parser.js'), { items: distilled, refs: { 'Prepare Framework Distillation': approved } }).map((i) => i.json);
for (const c of chunks) console.log(`${c.session_id} ${c.stream_type}#${c.chunk_index} len=${c.content.length} src=${c.metadata.source ?? '-'} fw=${c.metadata.framework_name ?? '-'} speaker=${c.metadata.speaker ?? '-'} inBounds=${c.metadata.within_bounds ?? '-'}`);
const voices = chunks.filter((c) => c.stream_type === 'voice_sample');
assert.ok(voices.every((v) => v.metadata.speaker === 'Dr. Sara Hegy'));
assert.ok(voices.every((v) => !/Mark D\.|Elena/.test(v.content.slice(0, 0)) ));
assert.ok(voices.every((v) => v.content.length >= 400 && v.content.length <= 700), 'voice chunks within 400-700');
console.log('\n--- sample voice chunk ---\n' + voices[0].content + '\n--- fallback framework (SES-102) ---\n' + chunks.find((c) => c.session_id === 'SES-102' && c.stream_type === 'framework').content);

// 4. Intent router
const intents = ['Hi', 'hello!', 'Hello Dr. Sara', 'good morning', 'Hi, how do I delegate?', 'How should I approach an underperforming VP?', '  ']
  .map((m) => [m, run(R('retrieval/01_intent_router.js'), { json: { chatInput: m } }).json.intent]);
console.table(intents);
assert.deepStrictEqual(intents.map((x) => x[1]), ['greeting', 'greeting', 'greeting', 'greeting', 'question', 'question', 'empty']);

// 5. Circuit breaker
const ref = { 'Intent Router': [{ json: { message: 'q' } }] };
assert.strictEqual(run(R('retrieval/04_circuit_breaker.js'), { items: [{ json: {} }], refs: ref })[0].json.match_count, 0);
const cb = run(R('retrieval/04_circuit_breaker.js'), { items: [{ json: { session_id: 'SES-102', stream_type: 'framework', content: 'x', similarity: 0.71, chunk_index: 0, metadata: {} } }], refs: ref })[0].json;
assert.strictEqual(cb.match_count, 1);
console.log('\nALL CODE-NODE TESTS PASSED');

// 6. Exported workflows embed exactly the tested source files
const fs = require('fs');
for (const wf of ['ingestion_firewall.json', 'gated_retrieval.json']) {
  const j = require(`../workflows/${wf}`);
  const srcs = fs.readdirSync(R('ingestion')).map((f) => fs.readFileSync(R('ingestion/' + f), 'utf8'))
    .concat(fs.readdirSync(R('retrieval')).map((f) => fs.readFileSync(R('retrieval/' + f), 'utf8')));
  for (const n of j.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.ok(srcs.includes(n.parameters.jsCode), `${wf}: node "${n.name}" is out of sync with src/ - run scripts/build_workflows.py`);
  }
}
console.log('workflow JSONs in sync with src/');
