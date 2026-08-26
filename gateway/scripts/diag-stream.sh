#!/usr/bin/env bash
# diag-stream.sh — attribute mid-stream truncation / 503 failures during a
# failure window, by comparing the vale-gate relay against the direct upstream.
#
# Background: DSH's client reports "Stream ended without finish_reason" when
# the SSE stream from api.saisi.online (vale-gate) closes without a terminal
# frame, and "503 status code (no body)" when it gets a body-less 503. Both
# can come from EITHER the upstream (opencode.ai/zen) OR Cloudflare edge/worker
# aborts — this script decides which, by firing concurrent minimal probes at
# BOTH paths and counting how many complete with a terminal frame.
#
# Usage:
#   VALE_TOKEN=<gateway token> bash scripts/diag-stream.sh            # vale only
#   VALE_TOKEN=... OPENCODE_GO_KEY=... bash scripts/diag-stream.sh    # vale vs direct zen
#
# The gateway token is the value stored for VALE_API_KEY (see ~/.dsh/.credentials.yaml).
# OPENCODE_GO_KEY is the user's opencode.ai/zen key (the worker secret
# OPENCODE_GO_API_KEY; ask the admin if you don't have it).
#
# Output: per-attempt status/elapsed/terminal-frame presence, then a verdict:
#   - direct zen also truncates → upstream problem (relay is not the cause)
#   - vale truncates but direct zen completes → gateway/edge-side cause
#   - all complete → failures are intermittent/lower-frequency than this run

set -u
API="${API:-https://api.saisi.online}"
ZEN="${ZEN:-https://opencode.ai/zen/go}"
MODEL="${MODEL:-og/deepseek-v4-flash}"
ZEN_MODEL="${ZEN_MODEL:-deepseek-v4-flash}"
ATTEMPTS="${ATTEMPTS:-4}"
CONCURRENCY="${CONCURRENCY:-2}"
MAX_TOKENS="${MAX_TOKENS:-8}"

: "${VALE_TOKEN:?set VALE_TOKEN (the gateway token for VALE_API_KEY)}"

probe_vale() {
  curl -sS -m 120 -N \
    -H "Authorization: Bearer $VALE_TOKEN" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":$MAX_TOKENS,\"stream\":true}" \
    "$API/v1/chat/completions" 2>/dev/null
}

probe_zen() {
  local key="$1"
  curl -sS -m 120 -N \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
    -d "{\"model\":\"$ZEN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":$MAX_TOKENS,\"stream\":true}" \
    "$ZEN/v1/chat/completions" 2>/dev/null
}

# one probe: returns "status|has_terminal_frame|bytes|httpx"
run_one() {
  local name="$1" key="$2"
  local tmp="$(mktemp)"
  local start end status bytes httpx frame
  start="$(date +%s%N)"
  if [ "$name" = "vale" ]; then
    httpx="$(curl -sS -m 120 -N -o "$tmp" -w '%{http_code}' \
      -H "Authorization: Bearer $VALE_TOKEN" -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":$MAX_TOKENS,\"stream\":true}" \
      "$API/v1/chat/completions" 2>/dev/null)"
  else
    httpx="$(curl -sS -m 120 -N -o "$tmp" -w '%{http_code}' \
      -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
      -d "{\"model\":\"$ZEN_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":$MAX_TOKENS,\"stream\":true}" \
      "$ZEN/v1/chat/completions" 2>/dev/null)"
  fi
  end="$(date +%s%N)"
  bytes="$(wc -c < "$tmp" | tr -d ' ')"
  # terminal = finish_reason OR [DONE]; error-in-body counts as failure
  if grep -q 'finish_reason' "$tmp" || grep -q '\[DONE\]' "$tmp"; then
    frame=yes
  else
    frame=no
  fi
  local ms=$(( (end - start) / 1000000 ))
  echo "$name|status=$httpx|terminal=$frame|bytes=$bytes|ms=$ms"
  rm -f "$tmp"
}

echo "== diag-stream: vale($API/$MODEL) vs zen($ZEN/$ZEN_MODEL) — $(date '+%F %T')"
echo "== attempts=$ATTEMPTS concurrency=$CONCURRENCY"
echo

ok_vale=0; ok_zen=0; tot_vale=0; tot_zen=0
run_batch() {
  local name="$1" key="$2"
  for i in $(seq 1 "$ATTEMPTS"); do
    local out
    out="$(run_one "$name" "$key")"
    echo "$out"
    case "$out" in
      *"terminal=yes"*)
        [ "$name" = "vale" ] && ok_vale=$((ok_vale+1)) || ok_zen=$((ok_zen+1))
        ;;
    esac
    [ "$name" = "vale" ] && tot_vale=$((tot_vale+1)) || tot_zen=$((tot_zen+1))
    # small stagger so concurrent runs don't retry in lockstep
    sleep 0.2
  done
}

run_batch vale "$VALE_TOKEN"
if [ -n "${OPENCODE_GO_KEY:-}" ]; then
  run_batch zen "$OPENCODE_GO_KEY"
else
  echo
  echo "(no OPENCODE_GO_KEY — skipping direct-zen comparison; set it to attribute)"
fi

echo
echo "== summary"
echo "vale: $ok_vale/$tot_vale completed with a terminal frame"
if [ -n "${OPENCODE_GO_KEY:-}" ]; then
  echo "zen : $ok_zen/$tot_zen completed with a terminal frame"
  if [ "$tot_vale" -gt 0 ] && [ "$tot_zen" -gt 0 ]; then
    if [ "$ok_zen" -lt "$tot_zen" ]; then
      echo "VERDICT: direct zen truncates too → upstream (opencode.ai/zen) problem, relay is not the cause"
    elif [ "$ok_vale" -lt "$tot_vale" ]; then
      echo "VERDICT: vale truncates but direct zen completes → gateway/edge-side cause (check wrangler tail / CF edge)"
    else
      echo "VERDICT: all complete at this sample — failures are intermittent; re-run during a failure window"
    fi
  fi
fi