# ADR 0004: One-time panel grants — the permanent device token never rides in a URL

Status: Adopted ｜ Date: 2026-09-05 ｜ Scope: `gateway/src/plugins` + `agent/src/web`

## Background

The console's DevicesPanel "open panel" flow fetched the device MCP config, extracted the device's
**permanent 64-hex token**, and opened `https://<device-host>/panel/?token=<token>` directly at the
device origin. The gateway's device-proxy was NOT in this path — the agent's own web surface served
the panel, validated the query token against its own `device_token`, and injected it into the panel
HTML (`window.__PANEL_TOKEN__`).

Round-124 had already 302'd the query into a scoped per-device cookie so the token left the omnibox,
but the credential still existed in:

1. browser history/journal (the entry exists *before* any 302 lands),
2. any logs that record full URLs (device access logs, proxies, the agent's own startup surface),
3. the `window.open` referer chain.

The in-code comment flagged this as an accepted debt ("the real fix (gateway-issued one-time grant)
is tracked separately"). The plugin-token pairing that used to give the console a lesser credential
was removed in round-340, so the permanent token was the only remaining bootstrap credential for
this flow.

## Options Considered

1. **Do nothing** — the token in the URL is the same token the panel page receives anyway. Rejected:
   the page HTML is same-origin and short-lived; a URL outlives the page, lands in sync/export
   targets, and is read by more software than the DOM.
2. **Open through the console proxy** (`/api/devices/<n>/proxy/panel/`) with the admin session — no
   token in any URL. Rejected: regresses the round-133/134 decision that the admin-opened panel runs
   at the DEVICE origin precisely so device HTML cannot read console APIs at a CONSOLE_HOST origin.
3. **Offline capability**: gateway mints `HMAC(proxy_secret, device + exp)`; the agent verifies
   locally. Rejected: no single-use (no shared mutable state) — a grant read from history/logs
   within the window still opens the panel; the redeem round-trip was available and cheap.
4. **One-time grant redeemed at the gateway (adopted)**.

## Decision

1. **Mint** (admin-session-gated): `POST /api/devices/<name>/panel-grant` stores `panelgrant:<code>`
   (32 hex chars, `crypto.getRandomValues`) as KV `{device, mintedAt}` with **TTL 120 s** (KV floor
   is 60 s; the grant only has to survive click → navigation → redeem) and returns the device-origin
   URL with `?grant=<code>`.
2. **Redeem** (device-Bearer-gated): `POST /api/devices/panel-grant/redeem` identifies the caller by
   a `safeEq` scan of the device registry, 403s cross-device use, **deletes the grant BEFORE
   answering**, and fails closed (a crash between delete and respond leaves nothing to retry).
   Unknown/expired/malformed grants all answer 404 without distinguishing them (no probing oracle);
   codes are shape-checked before any KV read.
3. **Agent**: a `/panel` navigation with `?grant=` redeems at `<console_url>` with the device's OWN
   Bearer token, then serves the **exact same response shape** as the authorized injection paths
   (proxy-secret marker, loopback). Redeem failure falls through to the plain panel — "a grant is a
   claim, not a proof". Pure-local devices (no `console_url`) never redeem. Grant/token values are
   never logged or echoed.
4. The `?token=` bootstrap for the device-origin panel is retired; the console UI opens grant URLs
   only.

## Consequences

- The permanent token no longer appears in any URL (history, logs, referer chain).
- Panel opening now requires the AGENT to reach the gateway (console_url). Pure-local devices never
  used this flow; gateway-connected devices reach the console by definition (they registered through
  it).
- Single-use is best-effort under KV's eventual consistency: two concurrent redeems can both pass
  the get before either delete lands. Accepted with documented blast radius — the overlap window is
  milliseconds, gated by a device-token Bearer an attacker does not hold, and the tunnel-token flow
  accepted the same class before its claim lock.
- The grant is worthless to a shoulder-surfer/history-reader after 120 s or first use, whichever
  comes first.
