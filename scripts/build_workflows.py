#!/usr/bin/env python3
"""
Builds workflows/ingestion_firewall.json and workflows/gated_retrieval.json
from the JavaScript / SQL sources in src/.

The JSON files are committed, so you never NEED to run this. It exists so the
Code-node logic lives in normal .js files (readable, diffable, unit-tested by
tests/code_nodes.test.js) and the exported workflows can't drift from them.

    python3 scripts/build_workflows.py
"""
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "workflows"

PG_CRED = {"postgres": {"id": "GxPgvectorCred01", "name": "GenX pgvector"}}
NS = uuid.UUID("6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b")


def nid(name):
    return str(uuid.uuid5(NS, name))


def code(rel):
    return (SRC / rel).read_text()


def node(name, ntype, version, pos, params, **extra):
    n = {"parameters": params, "id": nid(name), "name": name, "type": ntype,
         "typeVersion": version, "position": pos}
    n.update(extra)
    return n


def code_node(name, rel, pos, each=False, **extra):
    params = {"jsCode": code(rel)}
    if each:
        params["mode"] = "runOnceForEachItem"
    return node(name, "n8n-nodes-base.code", 2, pos, params, **extra)


def ollama_http(name, pos, path, body_expr, timeout_ms, **extra):
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": "POST",
        "url": "={{ ($env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434') + '" + path + "' }}",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": body_expr,
        "options": {"timeout": timeout_ms},
    }, **extra)


def embed_http(name, pos, text_expr):
    return ollama_http(
        name, pos, "/api/embed",
        "={{ JSON.stringify({ model: $env.EMBED_MODEL || 'bge-m3', input: " + text_expr + " }) }}",
        120000, retryOnFail=True, maxTries=3, waitBetweenTries=2000)


def cond(left, op_type, op, right=None, cid=None):
    c = {"id": cid or nid(left + op + str(right)), "leftValue": left,
         "operator": {"type": op_type, "operation": op}}
    if right is not None:
        c["rightValue"] = right
    else:
        c["operator"]["singleValue"] = True
    return c


def conditions(conds, combinator="and"):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": conds, "combinator": combinator}


def switch_rule(key, conds, combinator="and"):
    return {"conditions": conditions(conds, combinator), "renameOutput": True, "outputKey": key}


def connect(conns, src, dst, out_idx=0):
    outs = conns.setdefault(src, {"main": []})["main"]
    while len(outs) <= out_idx:
        outs.append([])
    outs[out_idx].append({"node": dst, "type": "main", "index": 0})


def sticky(name, pos, text, w, h, color=None):
    p = {"content": text, "height": h, "width": w}
    if color:
        p["color"] = color
    return node(name, "n8n-nodes-base.stickyNote", 1, pos, p)


def workflow(wid, name, nodes, conns, active):
    return {"id": wid, "name": name, "active": active, "nodes": nodes, "connections": conns,
            "settings": {"executionOrder": "v1", "saveManualExecutions": True},
            "pinData": {}, "tags": [], "meta": {"templateCredsSetupCompleted": True}}


# =============================================================================
# Workflow A - Ingestion & Semantic Firewall
# =============================================================================
UPSERT_SQL = """-- Upsert one chunk. Re-running ingestion is idempotent:
--   * stale chunks with a higher index (from an older, longer run) are purged
--   * a session that was archived earlier is removed from the archive
WITH purge_stale AS (
    DELETE FROM knowledge_vault
    WHERE session_id = $1 AND stream_type = $2 AND chunk_index >= $7
), purge_archive AS (
    DELETE FROM archived_sessions WHERE session_id = $1
)
INSERT INTO knowledge_vault (session_id, stream_type, chunk_index, content, metadata, embedding)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector(1024))
ON CONFLICT (session_id, stream_type, chunk_index) DO UPDATE
SET content    = EXCLUDED.content,
    metadata   = EXCLUDED.metadata,
    embedding  = EXCLUDED.embedding,
    updated_at = now()
RETURNING id, session_id, stream_type, chunk_index, length(content) AS chars;"""

ARCHIVE_SQL = """-- Rejected sessions: flat relational row, no embedding is ever generated.
-- If the session had been ingested by an earlier run, its vectors are purged.
WITH purge_vectors AS (
    DELETE FROM knowledge_vault WHERE session_id = $1
)
INSERT INTO archived_sessions
    (session_id, title, source_created_at, meeting_type, confidence_score,
     summary, reject_reason, participants, transcript, classifier_raw)
VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
ON CONFLICT (session_id) DO UPDATE
SET title = EXCLUDED.title,
    meeting_type = EXCLUDED.meeting_type,
    confidence_score = EXCLUDED.confidence_score,
    summary = EXCLUDED.summary,
    reject_reason = EXCLUDED.reject_reason,
    participants = EXCLUDED.participants,
    transcript = EXCLUDED.transcript,
    classifier_raw = EXCLUDED.classifier_raw,
    archived_at = now()
RETURNING session_id, meeting_type, confidence_score, reject_reason;"""

a_nodes = [
    sticky("Note: Overview A", [-80, -260],
           "## Workflow A - Ingestion & Semantic Firewall\n"
           "1. Read `/data/mock_transcripts.json` -> **Bounded Sampler** (first 40 + last 20 turns)\n"
           "2. **Classification Agent** (llama3.2, strict JSON schema) -> **Parse & Validate** (fails closed)\n"
           "3. **Ingestion Gate** (Switch): only `Client Coaching` with confidence >= 0.80 passes\n"
           "4. Rejected -> `archived_sessions` (flat table, **no embeddings**)\n"
           "5. Approved -> **Framework Distiller** + **Dual-Stream Parser** -> bge-m3 -> `knowledge_vault` upsert",
           760, 200),
    node("Start Ingestion (Manual)", "n8n-nodes-base.manualTrigger", 1, [0, 100], {}),
    node("Start Ingestion (Webhook)", "n8n-nodes-base.webhook", 2, [0, 300],
         {"httpMethod": "POST", "path": "ingest", "responseMode": "onReceived", "options": {}},
         webhookId=nid("webhook-ingest")),
    node("Read Transcripts File", "n8n-nodes-base.readWriteFile", 1, [240, 200],
         {"operation": "read", "fileSelector": "/data/mock_transcripts.json", "options": {}}),
    node("Parse JSON File", "n8n-nodes-base.extractFromFile", 1, [460, 200],
         {"operation": "fromJson", "options": {}}),
    code_node("Bounded Sampler", "ingestion/01_bounded_sampler.js", [680, 200]),
    ollama_http("Classification Agent", [900, 200], "/api/chat",
                "={{ JSON.stringify($json.classifier_request) }}", 180000,
                onError="continueRegularOutput", retryOnFail=True, maxTries=2, waitBetweenTries=2000),
    code_node("Parse & Validate Classification", "ingestion/02_parse_classification.js", [1120, 200]),
    node("Ingestion Gate", "n8n-nodes-base.switch", 3.2, [1340, 180], {
        "rules": {"values": [
            switch_rule("Pass: Client Coaching >= 0.80", [
                cond("={{ $json.meeting_type }}", "string", "equals", "Client Coaching"),
                cond("={{ $json.confidence_score }}", "number", "gte", 0.8),
            ]),
            switch_rule("Reject: Internal Operations", [
                cond("={{ $json.meeting_type }}", "string", "equals", "Internal Operations"),
            ]),
            switch_rule("Reject: Sales Discovery", [
                cond("={{ $json.meeting_type }}", "string", "equals", "Sales Discovery"),
            ]),
        ]},
        "options": {"fallbackOutput": "extra", "renameFallbackOutput": "Reject: Other / low confidence"},
    }),
    # --- reject branch
    code_node("Prepare Archive Row", "ingestion/03_prepare_archive_row.js", [1600, 460]),
    node("Archive Rejected Session", "n8n-nodes-base.postgres", 2.6, [1820, 460], {
        "operation": "executeQuery",
        "query": ARCHIVE_SQL,
        "options": {"queryReplacement":
                    "={{ [$json.session_id, $json.title, $json.source_created_at, $json.meeting_type, "
                    "$json.confidence_score, $json.summary, $json.reject_reason, $json.participants_json, "
                    "$json.transcript_json, $json.classifier_raw] }}"},
    }, credentials=PG_CRED),
    # --- pass branch
    code_node("Prepare Framework Distillation", "ingestion/04_prepare_framework_distillation.js", [1600, 40]),
    ollama_http("Framework Distiller (LLM)", [1820, 40], "/api/chat",
                "={{ JSON.stringify($json.distiller_request) }}", 300000,
                onError="continueRegularOutput", retryOnFail=True, maxTries=2, waitBetweenTries=2000),
    code_node("Dual-Stream Parser", "ingestion/05_dual_stream_parser.js", [2040, 40]),
    embed_http("Embed Chunk (bge-m3)", [2260, 40], "$json.content"),
    code_node("Prepare Vector Row", "ingestion/06_prepare_vector_row.js", [2480, 40]),
    node("Upsert to knowledge_vault", "n8n-nodes-base.postgres", 2.6, [2700, 40], {
        "operation": "executeQuery",
        "query": UPSERT_SQL,
        "options": {"queryReplacement":
                    "={{ [$json.session_id, $json.stream_type, $json.chunk_index, $json.content, "
                    "$json.metadata_json, $json.embedding_literal, $json.chunk_total] }}"},
    }, credentials=PG_CRED),
]

a_conns = {}
connect(a_conns, "Start Ingestion (Manual)", "Read Transcripts File")
connect(a_conns, "Start Ingestion (Webhook)", "Read Transcripts File")
connect(a_conns, "Read Transcripts File", "Parse JSON File")
connect(a_conns, "Parse JSON File", "Bounded Sampler")
connect(a_conns, "Bounded Sampler", "Classification Agent")
connect(a_conns, "Classification Agent", "Parse & Validate Classification")
connect(a_conns, "Parse & Validate Classification", "Ingestion Gate")
connect(a_conns, "Ingestion Gate", "Prepare Framework Distillation", 0)
for i in (1, 2, 3):
    connect(a_conns, "Ingestion Gate", "Prepare Archive Row", i)
connect(a_conns, "Prepare Archive Row", "Archive Rejected Session")
connect(a_conns, "Prepare Framework Distillation", "Framework Distiller (LLM)")
connect(a_conns, "Framework Distiller (LLM)", "Dual-Stream Parser")
connect(a_conns, "Dual-Stream Parser", "Embed Chunk (bge-m3)")
connect(a_conns, "Embed Chunk (bge-m3)", "Prepare Vector Row")
connect(a_conns, "Prepare Vector Row", "Upsert to knowledge_vault")

# =============================================================================
# Workflow B - Gated Retrieval & Persona Synthesis
# =============================================================================
b_nodes = [
    sticky("Note: Overview B", [-80, -300],
           "## Workflow B - Gated Retrieval & Persona Synthesis\n"
           "1. **Intent Router** (regex) answers greetings statically: no DB, no LLM\n"
           "2. Question -> bge-m3 embedding -> **Gated Vector Search** (raw SQL, `1 - (embedding <=> q)`)\n"
           "   frameworks >= 0.70 LIMIT 2, voice samples >= 0.65 LIMIT 2\n"
           "3. **Zero-Match Circuit Breaker**: 0 rows -> static fallback, LLM never called\n"
           "4. Otherwise -> few-shot **Persona Synthesis** in Dr. Sara's voice + exact source citations",
           760, 220),
    node("Chat Trigger", "@n8n/n8n-nodes-langchain.chatTrigger", 1.1, [0, 100],
         {"options": {"responseMode": "lastNode"}}, webhookId=nid("chat-trigger")),
    node("Webhook (POST /coach-chat)", "n8n-nodes-base.webhook", 2, [0, 300],
         {"httpMethod": "POST", "path": "coach-chat", "responseMode": "lastNode", "options": {}},
         webhookId=nid("webhook-coach-chat")),
    code_node("Intent Router", "retrieval/01_intent_router.js", [240, 200], each=True),
    node("Route Intent", "n8n-nodes-base.switch", 3.2, [460, 200], {
        "rules": {"values": [
            switch_rule("Greeting", [
                cond("={{ $json.intent }}", "string", "equals", "greeting"),
                cond("={{ $json.intent }}", "string", "equals", "empty"),
            ], combinator="or"),
            switch_rule("Question", [cond("={{ $json.intent }}", "string", "equals", "question")]),
        ]},
        "options": {},
    }),
    code_node("Static Greeting", "retrieval/02_static_greeting.js", [700, 40], each=True),
    embed_http("Embed Query (bge-m3)", [700, 300], "$json.message"),
    code_node("Validate Query Vector", "retrieval/03_query_vector.js", [920, 300], each=True),
    node("Gated Vector Search", "n8n-nodes-base.postgres", 2.6, [1140, 300], {
        "operation": "executeQuery",
        "query": code("retrieval/gated_search.sql"),
        "options": {"queryReplacement": "={{ [$json.query_vector] }}"},
    }, credentials=PG_CRED, alwaysOutputData=True),
    code_node("Zero-Match Circuit Breaker", "retrieval/04_circuit_breaker.js", [1360, 300]),
    node("Any Chunk Passed Gate?", "n8n-nodes-base.if", 2.2, [1580, 300], {
        "conditions": conditions([cond("={{ $json.match_count }}", "number", "gt", 0)]),
        "options": {},
    }),
    code_node("Fallback Response", "retrieval/05_fallback.js", [1820, 480], each=True),
    code_node("Build Persona Prompt", "retrieval/06_build_persona_prompt.js", [1820, 200], each=True),
    ollama_http("Persona Synthesis (LLM)", [2040, 200], "/api/chat",
                "={{ JSON.stringify($json.persona_request) }}", 300000),
    code_node("Format Answer", "retrieval/07_format_answer.js", [2260, 200], each=True),
]

b_conns = {}
connect(b_conns, "Chat Trigger", "Intent Router")
connect(b_conns, "Webhook (POST /coach-chat)", "Intent Router")
connect(b_conns, "Intent Router", "Route Intent")
connect(b_conns, "Route Intent", "Static Greeting", 0)
connect(b_conns, "Route Intent", "Embed Query (bge-m3)", 1)
connect(b_conns, "Embed Query (bge-m3)", "Validate Query Vector")
connect(b_conns, "Validate Query Vector", "Gated Vector Search")
connect(b_conns, "Gated Vector Search", "Zero-Match Circuit Breaker")
connect(b_conns, "Zero-Match Circuit Breaker", "Any Chunk Passed Gate?")
connect(b_conns, "Any Chunk Passed Gate?", "Build Persona Prompt", 0)
connect(b_conns, "Any Chunk Passed Gate?", "Fallback Response", 1)
connect(b_conns, "Build Persona Prompt", "Persona Synthesis (LLM)")
connect(b_conns, "Persona Synthesis (LLM)", "Format Answer")

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for fname, wf in [
        ("ingestion_firewall.json", workflow("GxIngestFirewl01", "A - Ingestion & Semantic Firewall", a_nodes, a_conns, True)),
        ("gated_retrieval.json", workflow("GxGatedRetrvl001", "B - Gated Retrieval & Persona Synthesis", b_nodes, b_conns, True)),
    ]:
        (OUT / fname).write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote workflows/{fname} ({len(wf['nodes'])} nodes)")
