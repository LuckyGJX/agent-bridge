#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:9876}"
OPENCLAW_BASE_URL="${OPENCLAW_BASE_URL:-http://127.0.0.1:18789}"
OPENCLAW_TOKEN="${OPENCLAW_TOKEN:-}"
OPENCLAW_MODEL="${OPENCLAW_MODEL:-openclaw/main}"

info() { printf '\033[0;36m>\033[0m %s\n' "$1"; }

info "Bridge status"
curl -fsS "$BRIDGE_URL/api/status" | python3 -m json.tool

info "Bridge config"
curl -fsS "$BRIDGE_URL/api/config" | python3 -m json.tool

if [[ -n "$OPENCLAW_TOKEN" ]]; then
  info "OpenClaw chat completion"
  curl -fsS "$OPENCLAW_BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OPENCLAW_TOKEN" \
    -d "{
      \"model\": \"$OPENCLAW_MODEL\",
      \"messages\": [{\"role\": \"user\", \"content\": \"Say hello in one sentence.\"}],
      \"stream\": false
    }" | python3 -m json.tool
else
  info "Skipping OpenClaw test because OPENCLAW_TOKEN is not set"
fi
