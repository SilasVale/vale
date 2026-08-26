# The Web as the Console: Gateway-Side Channel Routing (Redesign)

Date: 2026-08-05
Status: Approved (user confirmed the "config in the cloud, web as console" direction)

## Context

User feedback on the vale command approach (local CLI + provider repo + copying commands into a terminal) surfaced four pain points: the copy-paste mental burden, the CLI's overly strong presence, config scattered across three places (settings.json / providers.json / console), and awkward page layout.

**Root problem**: config lives locally, but the user wants to control things from the web page.

**Redesign**: move the "current channel selection" to the cloud — Claude Code's model name is fixed as `auto` (configured once, never changes), and the gateway routes dynamically according to the user's choice on the web page. **One click on the web page = takes effect immediately, no local tooling, no restart**.

## Architecture

```
Claude Code (settings.json configured once, fixed):
  ANTHROPIC_MODEL = "auto"
  ANTHROPIC_BASE_URL = https://api.saisi.online
  ANTHROPIC_API_KEY = gateway token

Request model="auto"
  → gateway looks up the user's route choice (store.js cache pattern: memory-first, KV read once per isolate per 24h)
  → route to the chosen channel (e.g. qw/qwen3.8-max-preview)
  → response model field = the actual channel model name

Web console (overview page after login):
  Channel card (health status + click to select) → PUT /api/me/route
  → KV write-through → the next request immediately takes the new channel (no restart needed)
```

## Gateway changes

### 1. store.js — user route choice (reuses the cget/cset cache pattern)

```js
export async function getUserRoute(env, id) {
  const key = `route:${id}`;
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (await env.KEYS.get(key)) || null;
  cset(key, v);
  return v;
}
export async function setUserRoute(env, id, model) {
  const key = `route:${id}`;
  await env.KEYS.put(key, model);
  cset(key, model); // write-through: the switch takes effect immediately (zero latency within the same isolate, ~1s KV propagation across isolates)
}
```

- Route value = **the full model name** (e.g. `qw/qwen3.8-max-preview`), consistent with the `/api/me/route` API; any model can be supported in the future
- No choice (null) → fall back to the recommended channel (first ok in HEALTH_PRIORITY)

### 2. index.js — `auto` routing

In handleGateway, when `body.model === "auto"`:

```js
let model = body.model || "";
if (model === "auto") {
  model = await resolveAutoModel(env, user.id);
}
```

```js
export async function resolveAutoModel(env, uid) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && isModelUsable(env, chosen)) return chosen;
  // no choice, or the choice is unusable (breaker open / not whitelisted) → recommended channel
  const health = await buildHealth(env);
  const rec = health.recommended;
  return rec ? rec.model : "ds/deepseek-v4-flash";
}
```

- `isModelUsable`: the model is in the MODELS whitelist and (for the og channel) the breaker is not open
- `auto` is handled the same way in count_tokens (the translate channel's local estimation logic is kept)
- The response model field returns the resolved actual model name (the user sees the real channel)
- Prefix-less model names (e.g. `deepseek-v4-flash`) keep the current behavior (default → ds), no special handling

### 3. console API — read/write route choice

In handleConsole's session section (near /api/me):

```
GET  /api/me/route  → { model: "qw/qwen3.8-max-preview" | null }
PUT  /api/me/route  body { model: "qw/qwen3.8-max-preview" }
  → validate the model is in the MODELS whitelist (400 otherwise)
  → setUserRoute → { ok: true, model }
```

## Frontend changes (model routing panel redesigned as a key-card-style channel switch card)

User requirement: the **model routing panel** uses the **same design style as the secret management page** (key card grid: name + status badge + description + action buttons), with the channel switchable directly on the card. The overview-page Vale card is removed.

```
┌─ Model routing ───────────────────────────────┐
│  ds/  deepseek-v4-flash      ✅   [Use] ◀ current │  ← key-card style (replaces the switchboard)
│  qw/  qwen3.8-max-preview    ✅   [Use]         │
│  og/  deepseek-v4-flash      ⚠️ degraded [Use]  │
│  or/  gpt-5.6-luna           ✅   [Use]         │
│  [Auto-select healthy channel]                │  ← clears the choice → gateway falls back to
│                                                │     the recommendation
│  Tip: Claude Code model name = auto,           │
│       switching needs no restart               │
│                                                │
│  Client access examples (kept)                │
└────────────────────────────────────────────────┘
```

- Data: /api/health (public channel status) + GET /api/me/route (current choice) + PUT /api/me/route (switch)
- The current channel card is highlighted ("current" badge); clicking [Use] → PUT → highlight updates + "Switched; takes effect on the next request" notice
- [Auto-select healthy channel] → PUT route `{ model: null }` (clears the choice → the gateway falls back to the recommendation)
- The model routing panel's switchboard is replaced by key-card-style channel cards (same info, card presentation); the client access examples are kept
- Remove: the overview-page Vale card (HTML/JS/i18n); the vale CLI install entry stays as a small-print link in the model routing panel or in the docs (the CLI is demoted to optional)
- The channel card DOM reuses the `key-card` CSS class (looks consistent with secret management)

## Kept / demoted

- vale CLI: functionality kept (optional for local troubleshooting/offline scenarios), no longer needed for daily use
- Channel health / circuit breaker / probe / installer endpoints: all kept
- Claude Code config migration: change the model field in the user's settings.json to `auto` (one-time; assist after implementation)

## Verification

1. Unit tests: resolveAutoModel (has choice / no choice / unusable choice → recommendation), setUserRoute write-through, /api/me/route validation
2. curl: PUT /api/me/route (session) → GET to read back; model=auto request → routed to the chosen channel (verify the response model field)
3. Browser: click the overview channel card to switch → highlight + the next auto request takes the new channel
4. Regression: explicit model-name routing for ds/qw/og/or unchanged; count_tokens auto works; all 62 tests green

## Implementation files

- `gateway/src/store.js`: getUserRoute/setUserRoute
- `gateway/src/index.js`: resolveAutoModel + the auto branch + the /api/me/route endpoint
- `gateway/public/index.html` + `public/app.js`: the secret-management-panel channel switch card (key-card style) + remove the overview Vale card
- `gateway/test/`: add route-related tests