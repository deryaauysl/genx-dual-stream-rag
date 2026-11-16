#!/usr/bin/env bash
# End-to-end verification. Produces the text log used in the README.
#   ./scripts/verify.sh | tee docs/verification_log.txt
set -euo pipefail

N8N=${N8N_URL:-http://localhost:5678}
PSQL="docker exec -i genx-postgres psql -U ${POSTGRES_USER:-genx} -d ${POSTGRES_DB:-genx_rag}"

ask() {
  echo
  echo "=== QUESTION: $1"
  curl -s -X POST "$N8N/webhook/coach-chat" -H 'Content-Type: application/json' \
       -d "$(printf '{"message": %s}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
    | python3 -c '
import json, sys
r = json.load(sys.stdin)
answer = r.pop("output", "")
print(json.dumps(r, indent=2, ensure_ascii=False))
print("--- answer ---")
print(answer)'
}

echo "### $(date -u +%Y-%m-%dT%H:%M:%SZ)  GenX dual-stream RAG verification"
echo
echo "=== 1. Run Workflow A (ingestion & semantic firewall)"
curl -s -X POST "$N8N/webhook/ingest"; echo
echo "Waiting for ingestion to finish (local LLM calls)..."
for _ in $(seq 1 60); do
  sleep 5
  n=$($PSQL -tAc "select (select count(*) from archived_sessions) + (select count(distinct session_id) from knowledge_vault)")
  [ "$n" -ge 4 ] && break
done
sleep 5

echo
echo "=== 2. Database state"
$PSQL < "$(dirname "$0")/verify.sql"

echo
echo "=== 3. Workflow B (gated retrieval)"
ask "Hi"
ask "How should I approach an underperforming VP?"
ask "My founder keeps reviewing every slide deck himself. How do I get him to delegate?"
ask "How do I fix my database index?"
