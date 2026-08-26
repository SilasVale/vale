# The web page is the console (auto routing) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code's model name is fixed to `auto`; the gateway routes dynamically by the user's web selection (KV storage); the key-management panel gains a "channel switch" card section (key-card style).

**Architecture:** Backend: `store.js` gains `getUserRoute/setUserRoute` (reusing the cget/cset cache pattern; KV `route:<uid>` stores the full model name); `index.js` resolves `model === "auto"` in handleGateway via `resolveAutoModel(env, uid)` (falls back to the recommended channel when the chosen one is unusable); handleConsole gains `GET/PUT /api/me/route` (session auth + MODELS whitelist validation). Frontend: key-card-style channel cards in the key-management panel (/api/health + /api/me/route), and removal of the overview-page Vale card.

**Tech Stack:** Cloudflare Worker (store.js/index.js), vanilla JS frontend, `node --test`.

## Global Constraints

- route value = full model name (e.g. `qw/qwen3.8-max-preview`); user routing triggers only on an exact literal match of `model === "auto"` (models without the prefix keep the current default→ds behavior)
- `resolveAutoModel`: the chosen channel must be in the MODELS whitelist and (for og) the breaker must not be open; otherwise fall back to `buildHealth().recommended`, and if none, `ds/deepseek-v4-flash`
- `PUT /api/me/route`: body `{ model }`; `model` must exactly match the MODELS whitelist (otherwise 400); `model: null` clears the selection
- Cache semantics: memory-first, KV read once per isolate per 24h; setUserRoute is write-through
- Frontend: channel cards reuse the `key-card` CSS class; the overview Vale card is removed entirely (HTML/JS/i18n)
- Tests: all 62 existing green + new ones; conventional commits + Co-Authored-By

---

### Task 1: store.js — getUserRoute / setUserRoute

**Files:**
- Modify: `gateway/src/store.js`
- Test: `gateway/test/store.cache.test.mjs` (append)

**Interfaces:**
- Produces: `getUserRoute(env, id)` → `string | null`; `setUserRoute(env, id, model)` → void. Consumed by Task 2.

- [ ] **Step 1: Write a failing test** (append to `store.cache.test.mjs`)

```js
test("getUserRoute / setUserRoute: cached read, write-through refresh", async () => {
  const kv = makeKV({});
  assert.equal(await store.getUserRoute(kv, "admin"), null); // miss → 1 get
  await store.setUserRoute(kv, "admin", "qw/qwen3.8-max-preview"); // put + cache
  assert.equal(await store.getUserRoute(kv, "admin"), "qw/qwen3.8-max-preview"); // cache hit
  assert.equal(kv.counters.get, 1); // only the first read hits KV
  await store.setUserRoute(kv, "admin", "ds/deepseek-v4-flash"); // write-through
  assert.equal(await store.getUserRoute(kv, "admin"), "ds/deepseek-v4-flash");
  assert.equal(kv.counters.get, 1); // still no new KV read
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd ~/vale/gateway && node --test test/store.cache.test.mjs`
Expected: FAIL — `store.getUserRoute is not a function`

- [ ] **Step 3: Implement** (`store.js`, near `getUserKeys`)

```js
/* ---- Per-user route selection (model=auto) ---- */

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
  if (model === null || model === undefined || model === "") {
    await env.KEYS.delete(key);
    cdel(key);
    return;
  }
  await env.KEYS.put(key, String(model));
  cset(key, String(model)); // write-through: the switch takes effect immediately (zero latency within the same isolate)
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd ~/vale/gateway && node --test test/store.cache.test.mjs`
Expected: PASS

- [ ] **Step 5: Full test suite + commit**

Run: `cd ~/vale/gateway && npm test` — all green
```bash
cd ~/vale && git add gateway/src/store.js gateway/test/store.cache.test.mjs
git commit -m "feat(stage-gateway): store — per-user route selection (get/set, write-through cache)" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: index.js — resolveAutoModel + the auto branch + /api/me/route endpoints

**Files:**
- Modify: `gateway/src/index.js`
- Test: `gateway/test/health.test.mjs` (append resolveAutoModel cases)

**Interfaces:**
- Consumes: Task 1's `getUserRoute/setUserRoute`; existing `buildHealth(env)`, `isChannelDegraded(env)`, `MODELS`.
- Produces: exported `resolveAutoModel(env, uid)`; the `model === "auto"` branch in handleGateway; console `GET/PUT /api/me/route`. Consumed by Task 3.

- [ ] **Step 1: Write a failing test** (append to `health.test.mjs`)

```js
// ── auto route resolution ────────────────────────────
// env with KV mock: route:<uid> → chosen model
function routeEnv(routeValue, breakerOpen = false) {
  const m = new Map();
  if (routeValue !== null) m.set(`route:admin`, routeValue);
  return {
    KEYS: {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, String(v)); },
      async delete(k) { m.delete(k); },
    },
    BREAKER: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response(breakerOpen ? "1" : "0") }),
    },
    DEEPSEEK_API_KEY: "sk-ds", QWEN_API_KEY: "sk-qw",
    OPENROUTER_API_KEY: "sk-or", OPENCODE_GO_API_KEY: "sk-og",
  };
}

test("resolveAutoModel: uses chosen route", async () => {
  const env = routeEnv("qw/qwen3.8-max-preview");
  assert.equal(await resolveAutoModel(env, "admin"), "qw/qwen3.8-max-preview");
});

test("resolveAutoModel: no choice → recommended (qw)", async () => {
  const env = routeEnv(null);
  assert.equal(await resolveAutoModel(env, "admin"), "qw/qwen3.8-max-preview");
});

test("resolveAutoModel: chosen og channel with open breaker → falls back to recommended", async () => {
  const env = routeEnv("og/deepseek-v4-flash", true);
  assert.equal(await resolveAutoModel(env, "admin"), "qw/qwen3.8-max-preview");
});

test("resolveAutoModel: chosen model not in whitelist → falls back", async () => {
  const env = routeEnv("xx/nope");
  assert.equal(await resolveAutoModel(env, "admin"), "qw/qwen3.8-max-preview");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs`
Expected: FAIL — `resolveAutoModel is not exported`

- [ ] **Step 3: Implement**

a) Import the new store functions (append `getUserRoute, setUserRoute` to the import line at the top of `index.js`).

b) After `buildHealth`, add:

```js
/** Model usable for routing? In the whitelist and (og) breaker not open. */
export async function isModelUsable(env, model) {
  if (!MODELS.some((m) => m.id === model)) return false;
  if (model.startsWith("og/")) return !(await isChannelDegraded(env));
  return true;
}

/**
 * Resolve Claude Code's fixed `auto` model name to this user's chosen
 * channel (per-user route selection). Falls back to the recommended
 * healthy channel when unset or unusable.
 */
export async function resolveAutoModel(env, uid) {
  const chosen = await getUserRoute(env, uid);
  if (chosen && (await isModelUsable(env, chosen))) return chosen;
  const health = await buildHealth(env);
  const rec = health.recommended;
  return rec ? rec.model : "ds/deepseek-v4-flash";
}
```

c) The model resolution in handleGateway (after `const model = body.model || "";`, before `const prefix = ...`):

```js
  let model = body.model || "";
  if (model === "auto") {
    // Claude Code's fixed model name "auto": route by the user's web selection
    model = await resolveAutoModel(env, user.id);
  }
  const prefix = model.split("/")[0];
```

Note: `model` changes from `const` to `let`.

d) console endpoints (in handleConsole's session section, after the `/api/me` handling):

```js
  // Per-user route selection (Claude Code model=auto)
  if (method === "GET" && path === `${ME_BASE}/route`) {
    return jsonOk({ model: await getUserRoute(env, user.id) });
  }
  if (method === "PUT" && path === `${ME_BASE}/route`) {
    let body = {};
    try { body = await request.json(); } catch {}
    const model = body?.model ?? null;
    if (model !== null && !MODELS.some((m) => m.id === model)) {
      return jsonError(400, `Unknown model: ${model}`, "invalid_request");
    }
    await setUserRoute(env, user.id, model);
    return jsonOk({ ok: true, model });
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs && npm test`
Expected: PASS (all)

- [ ] **Step 5: commit**

```bash
cd ~/vale && git add gateway/src/index.js gateway/test/health.test.mjs
git commit -m "feat(stage-gateway): model=auto routes per-user choice; /api/me/route endpoints" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Frontend — key-card-style channel switch cards in the model-routing panel + removing the overview Vale card

**Files:**
- Modify: `gateway/public/index.html`
- Modify: `gateway/public/app.js`

**Interfaces:**
- Consumes: Task 2's `GET/PUT /api/me/route`; existing `api()`, `t()`, `esc()`, `/api/health`.
- Produces: `#route-cards` in the model-routing panel (channel card grid, key-card style, replacing the switchboard), `#btn-route-auto`; removes `#vale-card` and `loadValeCard`/`valeSetupCommand`.

- [ ] **Step 1: index.html — rework the model-routing panel, remove the overview Vale card**

a) In `#panel-routes`, replace the switchboard card with:

```html
        <div class="card">
          <div class="card-head"><h2 data-i18n="route.title">渠道切换</h2></div>
          <div class="card-body">
            <p class="muted" data-i18n="route.desc">Claude Code 模型名配 <code>auto</code> 后，在这里点一下即可切换，无需重启。</p>
            <div class="cards" id="route-cards"></div>
            <button class="btn-ghost" id="btn-route-auto" data-i18n="route.auto">自动选择健康渠道</button>
          </div>
        </div>
```

(Delete `#routes-switchboard` and its wrapper card; keep the client connection example card. The key-management panel stays untouched.)

b) Delete the entire overview-page `#vale-card` (`<div class="card" id="vale-card">...</div>`).

- [ ] **Step 2: app.js — i18n (zh/en)**

zh additions/replacements:
```js
      "route.title": "渠道切换",
      "route.desc": "Claude Code 模型名配 <code>auto</code> 后，在这里点一下即可切换，无需重启。",
      "route.use": "使用",
      "route.current": "当前",
      "route.auto": "自动选择健康渠道",
      "route.switched": "已切换，下次请求生效",
      "route.fail": "切换失败",
      "route.loadFail": "渠道状态加载失败",
```
en: corresponding English. Delete the `vale.*` keys (`vale.cardTitle`, `vale.desc`, `vale.defaultModel`, `vale.setupBtn`, `vale.setupNote`, `vale.cheat`, `vale.healthLoading`, `vale.healthFail`, `vale.recommend`, `vale.copyFail`).

- [ ] **Step 3: app.js — rendering and interaction**

Delete `VALE_FALLBACK_MODELS`, `valeSetupCommand`, `loadValeCard`, and the `await loadValeCard();` call in `loadOverview`; replace with:

```js
  /* ============ route switch (routing panel) ============ */
  // Channel switch: /api/health status + /api/me/route current selection; click [use] → PUT.
  // Cards reuse the key-card styles for a consistent look with the key-management page.
  function routeCardHTML(ch, current) {
    const status = ch.ok ? `<span class="badge ok">${t("route.use")}</span>` : `<span class="badge bad">${ch.reason || "异常"}</span>`;
    const isCur = current === ch.model;
    return `
      <div class="key-card" data-model="${esc(ch.model)}">
        <div class="top">
          <div>
            <div class="key-name">${esc(ch.id + "/")}${isCur ? ` <span class="badge ok">${t("route.current")}</span>` : ""}</div>
            <div class="key-desc">${esc(ch.model)}</div>
          </div>
          ${status}
        </div>
        <div class="key-actions">
          <button class="btn-primary btn-mini" data-act="use" ${ch.ok ? "" : "disabled"}>${t("route.use")}</button>
        </div>
      </div>`;
  }

  async function loadRouteCards() {
    const box = $("#route-cards");
    if (!box) return;
    let current = null;
    try {
      const r = await api("/api/me/route");
      if (r.res.ok) current = r.data?.model ?? null;
    } catch {}
    const health = await api("/api/health");
    if (!health.res.ok || !Array.isArray(health.data?.channels)) {
      box.textContent = t("route.loadFail");
      return;
    }
    box.innerHTML = health.data.channels.map((c) => routeCardHTML(c, current)).join("");
    box.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-act='use']");
      if (!btn || btn.disabled) return;
      const card = btn.closest(".key-card");
      const model = card?.dataset.model;
      if (!model) return;
      const r = await api("/api/me/route", { method: "PUT", body: JSON.stringify({ model }) });
      if (r.res.ok) { toast(t("route.switched")); await loadRouteCards(); }
      else toast(t("route.fail"), true);
    });
    $("#btn-route-auto")?.addEventListener("click", async () => {
      const r = await api("/api/me/route", { method: "PUT", body: JSON.stringify({ model: null }) });
      if (r.res.ok) { toast(t("route.switched")); await loadRouteCards(); }
      else toast(t("route.fail"), true);
    });
  }
```

Append `await loadRouteCards();` at the end of `loadRoutesPanel()` (the model-routing panel loader; switchboard rendering removed).

Note: binding `btn-route-auto`'s addEventListener inside loadRouteCards would duplicate listeners each render — move the auto-button binding to init (once); loadRouteCards only renders and binds the use buttons (use buttons live in the dynamic innerHTML, bound on the box ✅ each render's new listener replaces the old one, no duplication). Adjustment: bind the auto button in init; on click, call a shared `clearRoute()` function:

```js
  async function clearRoute() {
    const r = await api("/api/me/route", { method: "PUT", body: JSON.stringify({ model: null }) });
    if (r.res.ok) { toast(t("route.switched")); await loadRouteCards(); }
    else toast(t("route.fail"), true);
  }
```
In init: `$("#btn-route-auto")?.addEventListener("click", clearRoute);`
Remove the auto-button binding inside `loadRouteCards`.

- [ ] **Step 4: Verification**

Run: `cd /home/zhengsaisi/vale/gateway && node --check public/app.js && npm test`
Expected: syntax OK; all 62 green

- [ ] **Step 5: commit**

```bash
cd ~/vale && git add gateway/public/index.html gateway/public/app.js
git commit -m "feat(stage-gateway): console — channel switch cards in keys panel (auto routing), drop overview vale card" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Deploy + E2E verification (including user config migration)

**Files:** No code changes (deploy and verify).

- [ ] **Step 1: Deploy**

Run: `cd ~/vale && ./scripts/build.sh gateway`; wait 45s for propagation

- [ ] **Step 2: API verification (curl)**

```bash
# Log in to get the session cookie (admin password read from KV, same as the previous verification flow)
# GET /api/me/route → {"model":null}
# PUT /api/me/route {"model":"qw/qwen3.8-max-preview"} → {"ok":true,"model":"..."}
# PUT /api/me/route {"model":"xx/nope"} → 400
# Request to verify auto routing:
curl -s https://api.saisi.online/v1/messages -H "x-api-key: 5e7874ea..." -d '{"model":"auto","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
# → 200, response model field = qw/qwen3.8-max-preview (the chosen channel)
# count_tokens auto works the same
```

- [ ] **Step 3: Frontend verification (curl HTML + browser)**

```bash
curl -s https://ai.saisi.online/ | grep -c 'id="route-cards"'   # ≥1
curl -s https://ai.saisi.online/ | grep -c 'id="vale-card"'     # 0 (removed)
```
Browser: channel cards on the key-management page (current one highlighted, click [use] to switch, auto button); no Vale card remnant on the overview page.

- [ ] **Step 4: User config migration (settings.json model → auto)**

Change the 7 model fields in `~/.claude/settings.json` to `auto` (back up first, keep base/token) — do it only after asking the user to confirm; afterwards tell them "from now on, click a channel on the web key-management page to switch, no restart needed".

- [ ] **Step 5: Regression**

`cd ~/vale/gateway && npm test` all green; `git status` clean.

## Self-Review Notes

- Spec coverage: getUserRoute/setUserRoute ✅(T1), resolveAutoModel + auto branch ✅(T2), /api/me/route ✅(T2), key-card channel cards in the model-routing panel ✅(T3), overview Vale card removal ✅(T3), verification + migration ✅(T4).
- Type consistency: `getUserRoute(env, id)`/`setUserRoute(env, id, model)`/`resolveAutoModel(env, uid)`/`isModelUsable(env, model)` are consistent across tasks; the frontend's `model: null` clear semantics match setUserRoute's null branch.
- No placeholders.
