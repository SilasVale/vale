#!/usr/bin/env bash
# tunnel-health.sh — one-command posture view for the cloudflared tunnel's
# public hostnames + the local origins behind them.
#
# Why: the tunnel is DASHBOARD-managed (local config.yml ingress is ignored —
# the effective hostnames live in the Cloudflare API), so "what is actually
# exposed right now" is easy to lose track of. This script checks, per
# hostname: external reachability, whether it is Access-gated (302 to the
# team login), and whether the local origin port is listening.
#
# Usage: bash scripts/tunnel-health.sh    (informational; exit 0 normally,
# exit 1 only when a LOCAL origin that should be listening is not — external
# state is reported but not owned by this box).
set -uo pipefail

# hostname | local_port | expectation
#   expectation: "live" (local listener must exist) | "retired" (origin may be dead)
ENTRIES=(
  "dsh.saisi.online|7738|live"
  "vscode.saisi.online|7739|live"
  "code.saisi.online|7780|retired"
)

FAIL=0
printf "%-24s %-14s %-22s %s\n" "HOSTNAME" "LOCAL PORT" "EXTERNAL" "NOTE"
printf "%-24s %-14s %-22s %s\n" "--------" "----------" "---------------------" "----"

for e in "${ENTRIES[@]}"; do
  IFS='|' read -r host port expect <<<"$e"
  local_state="-"
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    local_state="listening"
  else
    local_state="NOT listening"
    [ "$expect" = "live" ] && FAIL=1
  fi

  ext="$(curl -s -o /dev/null -m 12 -w '%{http_code}' "https://${host}/" 2>/dev/null)"
  note=""
  loc="$(curl -s -o /dev/null -m 12 -w '%{redirect_url}' "https://${host}/" 2>/dev/null)"
  case "$ext" in
    302)
      if [[ "$loc" == *cloudflareaccess.com* ]]; then note="Access-gated"; fi
      ;;
    200) note="open" ;;
    000) note="unreachable (network/DNS)"; [ "$expect" = "live" ] && FAIL=1 ;;
    *) note="HTTP $ext" ;;
  esac
  [ "$expect" = "retired" ] && note="$note (retired origin — expected dead)"

  printf "%-24s %-14s %-22s %s\n" "$host" "$port" "HTTP $ext / $note" "local: $local_state"
done

# Local extras worth glancing at while here (ports not already covered above).
for p in 18080; do
  if ss -tln 2>/dev/null | grep -q ":${p} "; then
    printf "%-24s %-14s %-22s %s\n" "(local only)" "$p" "listening" ""
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: a live-expectation local origin is NOT listening — check pm2." >&2
  exit 1
fi
echo "RESULT: posture consistent (external state informational)."
