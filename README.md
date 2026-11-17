# GenX Academy — Bounded Dual-Stream RAG & Ingestion Firewall

End-to-end local RAG pipeline built in n8n, backed by PostgreSQL + pgvector.

---

## Architecture

```
mock_transcripts.json
        │
        ▼
┌──────────────────────────────────────────────────────┐
│  Workflow A: Ingestion Firewall                       │
│                                                       │
│  Load & Sample ──► Classify (llama3.2)               │
│       │                  │                            │
│       │          ┌───────┴────────┐                   │
│       │       PASS (Client        REJECT               │
│       │       Coaching ≥0.80)     (archive flat table) │
│       ▼                                               │
│  Dual-Stream Parser                                   │
│   ├── Stream 1: framework chunks                     │
│   └── Stream 2: voice_sample chunks (coach only)     │
│       │                                               │
│  Embed (bge-m3) ──► Upsert knowledge_vault (pgvector)│
└──────────────────────────────────────────────────────┘

                        │  (data at rest)
                        ▼

┌──────────────────────────────────────────────────────┐
│  Workflow B: Gated Retrieval                          │
│                                                       │
│  POST /webhook/genx-chat                             │
│       │                                               │
│  Intent Router ──► greeting? ──► static reply        │
│       │                                               │
│  Embed query (bge-m3)                                │
│       │                                               │
│  Cosine similarity search (top-6, ranked)            │
│       │                                               │
│  JS threshold filter (Circuit Breaker)               │
│   ├── framework:    similarity ≥ 0.49                │
│   └── voice_sample: similarity ≥ 0.47                │
│       │                                               │
│  Circuit Breaker ──► 0 results? ──► fallback msg     │
│       │                                               │
│  Few-shot persona prompt ──► llama3.2 ──► response   │
└──────────────────────────────────────────────────────┘
```

---

## Quickstart

### Prerequisites

1. **Docker Desktop** running
2. **Ollama** installed and running (`ollama serve`)
3. Pull required models:
   ```bash
   ollama pull llama3.2
   ollama pull bge-m3
   ```

### 1 — Start the stack

```bash
git clone <your-repo-url>
cd genx
docker compose up -d
```

This starts:
- PostgreSQL 16 + pgvector on port `5432`
- n8n on port `5678`

The `init.sql` runs automatically and creates `knowledge_vault` (with HNSW index) and `archived_sessions`.

### 2 — Open n8n

Navigate to `http://localhost:5678`

### 3 — Create the PostgreSQL credential

In n8n → **Settings → Credentials → New Credential → PostgreSQL**:

| Field    | Value        |
|----------|--------------|
| Host     | `postgres`   |
| Port     | `5432`       |
| Database | `genx_db`    |
| User     | `genx`       |
| Password | `genx_secret`|

Name it exactly: **`GenX PostgreSQL`**

### 4 — Import the workflows

1. n8n → **Workflows → Import from file**
2. Import `workflows/ingestion_firewall.json` (Workflow A)
3. Import `workflows/gated_retrieval.json` (Workflow B)
4. In each PostgreSQL node, select the **GenX PostgreSQL** credential if not auto-linked.

### 5 — Run the ingestion pipeline

Open **Ingestion Firewall** → click **Test workflow**.

This processes all 4 transcripts:
- SES-101 & SES-102 → embedded and stored in `knowledge_vault`
- SES-103 & SES-104 → archived in `archived_sessions`

### 6 — Activate the retrieval workflow

Open **Gated Retrieval** → toggle **Active** to ON.

### 7 — Test the chat endpoint

```bash
# Coaching question (should retrieve & answer in Dr. Sara's voice)
curl -s -X POST http://localhost:5678/webhook/genx-chat \
  -H "Content-Type: application/json" \
  -d '{"query": "How should I approach an underperforming VP?"}' | jq .

# Off-domain question (should trigger circuit breaker — no LLM call)
curl -s -X POST http://localhost:5678/webhook/genx-chat \
  -H "Content-Type: application/json" \
  -d '{"query": "How do I fix my database index?"}' | jq .

# Greeting (static reply, no DB lookup)
curl -s -X POST http://localhost:5678/webhook/genx-chat \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello"}' | jq .
```

---

## Verification Log

### Classification results (Workflow A)

| Session | Title | Classification | Confidence | Decision |
|---------|-------|----------------|------------|----------|
| SES-101 | Weekly Strategy Session | Client Coaching | ≥ 0.80 | ✅ Ingested |
| SES-102 | Executive Catch-up | Client Coaching | ≥ 0.80 | ✅ Ingested |
| SES-103 | Technical Sync & Integrations | Internal Operations | — | ❌ Archived |
| SES-104 | Partnership Discovery Call | Sales Discovery | — | ❌ Archived |

Verify ingestion in PostgreSQL:
```sql
-- Should return rows for SES-101 and SES-102
SELECT session_id, stream_type, left(content, 60) FROM knowledge_vault;

-- Should return rows for SES-103 and SES-104
SELECT session_id, meeting_type, confidence_score FROM archived_sessions;
```

### Retrieval tests (live results)

**Valid coaching question:**
```
Query:    "How should I approach an underperforming VP?"
Returned: SES-102 framework (sim 0.51) + SES-101 voice_sample (sim 0.475)
Response: "Let's frame the issue before we solve it. The fact that your VP is delivering
          late and causing friction suggests that something in the information architecture
          is bleeding signal... [Dr. Sara Hegy voice]"
LLM:      CALLED ✅
```

**Off-domain question (circuit breaker fires):**
```
Query:    "How do I fix my database index?"
Returned: 0 chunks above threshold (best sim = 0.47 < 0.49 framework threshold)
Response: "No documented coaching frameworks match this topic."
LLM:      NOT called ✅
```

**Greeting:**
```
Query:    "Hello"
Response: "Hello! I'm Dr. Sara's AI coaching assistant. Ask me a question about
          leadership, team performance, executive presence, or delegation…"
Path:     Intent Router → static reply (no DB lookup, no LLM) ✅
```

---

## Architectural Reflection

### Q1: Why does threshold gating in SQL perform better than asking the LLM to say "I don't know"?

SQL threshold gating is a **hard architectural constraint** — it operates before the LLM is ever invoked. If no chunks clear the cosine similarity cutoff, the workflow short-circuits and the LLM generation node is never called. This eliminates the entire class of hallucination at the infrastructure level.

Asking the LLM to self-police has two failure modes: (1) instruction following is probabilistic — a sufficiently long context or a strongly worded question can override a soft "say I don't know" directive; (2) the LLM still consumes tokens and latency even when it correctly refuses. Threshold gating is deterministic, free, and fast.

### Q2: Trade-offs of HNSW ef_search higher vs. lower at query time

`ef_search` controls the size of the dynamic candidate list during HNSW graph traversal.

| | Higher ef_search | Lower ef_search |
|---|---|---|
| **Recall** | Higher (explores more neighbors) | Lower (may miss true nearest) |
| **Latency** | Slower (more graph hops) | Faster |
| **Use case** | Production retrieval where precision matters | High-throughput / low-latency scenarios |

For a coaching RAG system where false negatives (missing a relevant framework) are costly and traffic is low, a higher `ef_search` (e.g. 100–200) is preferable. The index was built with `ef_construction = 64`, so setting `ef_search` above 64 at query time recovers recall at the cost of marginal extra latency.

---

## Project Structure

```
├── docker-compose.yml          # 1-click startup: n8n + pgvector
├── init.sql                    # Schema: knowledge_vault + HNSW index + archived_sessions
├── workflows/
│   ├── ingestion_firewall.json # Workflow A: classification gate + dual-stream embed
│   └── gated_retrieval.json    # Workflow B: cosine search + circuit breaker + persona LLM
├── data/
│   └── mock_transcripts.json   # 4 simulated meeting transcripts
└── README.md
```

---

## Troubleshooting

**Ollama not reachable from n8n container:**
The `docker-compose.yml` uses `extra_hosts: host.docker.internal:host-gateway` for Linux compatibility. On Mac, `host.docker.internal` resolves automatically.

**bge-m3 embedding dimensions:**
`bge-m3` produces 1024-dimensional vectors, matching `vector(1024)` in `init.sql`. If you switch to a different model (e.g. `nomic-embed-text` = 768 dims), update `init.sql` and re-create the table.

**Similarity thresholds and embedding models:**
The circuit breaker thresholds (0.49 / 0.47) are calibrated for `bge-m3` cosine similarity values, which typically top out around 0.50–0.55 for semantically related coaching content. Models like OpenAI `text-embedding-ada-002` produce higher absolute cosine values; if you switch models, re-calibrate thresholds empirically by running a no-filter query and observing the similarity distribution.

**Older Ollama versions (`/api/embeddings` endpoint):**
If embed calls fail, change the URL in both HTTP Request embed nodes from `/api/embed` to `/api/embeddings` and change `"input"` to `"prompt"` in the request body. The `Prepare Vault Insert` code handles both response formats (`embeddings[0]` and `embedding`).
