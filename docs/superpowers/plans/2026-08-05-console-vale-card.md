# Vale card on the console overview page — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate vale's web entry point into one large card on the overview page (model selector + one-click config button + channel health + command cheat sheet), and remove the vale blocks from the key-management and model-routing panels.

**Architecture:** Frontend-only changes (`gateway/public/index.html` + `gateway/public/app.js`): insert the Vale card between the overview page's Token card and route-status card; data comes from existing endpoints (`/api/me`, `/api/admin/public`, `/api/health`, `/v1/models`); no backend changes.

**Tech Stack:** vanilla JS (reusing app.js's existing `api()`/`t()`/`esc()`/`toast()`/`loadRoutes()` helpers), bilingual i18n, `node --check` verification.

## Global Constraints

- The browser cannot read or write local config — the card only displays information + generates commands, and never attempts any local operation
- The one-click config button generates a compound command: `curl -fsSL <base>/api/vale-install | sh && vale provider add vale-gw --base <base> --token <me.token> --model <selected model>` (`<base>` = `https://${apiHost}` when apiHost is non-empty, otherwise `https://api.saisi.online`)
- Model selector options come from `GET /v1/models` (x-api-key: me.token); defaults to `/api/health`'s recommended.model; falls back to the built-in list on load failure (ds/qw/og/or default models)
- Channel health comes from `GET /api/health` (public), refreshed by polling every 30s (only while the overview panel is active)
- Remove: the Vale one-click config card in the key-management panel (HTML + `renderValeSetup`/`valeSetupCommand`), the Vale command install section in the model-routing panel (HTML + references); replace the old i18n keys (`routes.valeTitle`, `routes.valeDesc`, `valeSetup.*`) with new `vale.*` keys
- `node --check public/app.js` passes; `npm test` all green (frontend changes don't break existing tests)
- commit: conventional + stage tag + `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: Overview-page Vale card (HTML + rendering + removing old blocks)

**Files:**
- Modify: `gateway/public/index.html`
- Modify: `gateway/public/app.js`

**Interfaces:**
- Consumes: existing `api(path, opts)`, `loadRoutes()` (returns `{ routes, apiHost }`), `me.token` (already loaded in `loadOverview`), `t()`/`esc()`/`toast()`.
- Produces: `#vale-card` (overview page), `#vale-model-select`, `#btn-vale-setup`, `#vale-health-row`; functions `valeSetupCommand(apiHost, token, model)`, `loadValeCard()` (fills the selector + health + commands).

- [ ] **Step 1: index.html — add the Vale card on the overview page (after the Token card, before the route-status card)**

Insert after the `</div>` of `<div class="token-actions">...</div>` (end of the Token card) and before the route-status card:

```html
        <div class="card" id="vale-card">
          <div class="card-head"><h2 data-i18n="vale.cardTitle">Vale</h2></div>
          <div class="card-body">
            <p class="muted" data-i18n="vale.desc">跨平台一键切换网关渠道。配置一次，之后 <code>vale use</code> 一条命令切换。</p>
            <div class="vale-row">
              <label data-i18n="vale.defaultModel">默认模型</label>
              <select id="vale-model-select"></select>
              <button class="btn-primary" id="btn-vale-setup" data-i18n="vale.setupBtn">⚡ 一键配置 Vale</button>
            </div>
            <p class="note" id="vale-setup-note" data-i18n="vale.setupNote" hidden></p>
            <pre><code id="vale-setup-cmd" hidden></code></pre>
            <div class="vale-health" id="vale-health-row"></div>
            <p class="muted" data-i18n="vale.cheat">vale check · vale use &lt;渠道|模型&gt; · vale use auto · vale models · vale restore</p>
          </div>
        </div>
```

- [ ] **Step 2: Remove the Vale card from the key-management panel and the install section from the model-routing panel**

index.html:
1. In `#panel-keys`, delete the entire `Vale one-click config` card (`<div class="card">...valeSetup...</div>`, including `#vale-setup-cmd`, `#btn-copy-vale-setup`)
2. In `#panel-routes`, delete the `Vale command` card (`<div class="card">...routes.valeTitle...</div>`, including `#vale-install-box`)

- [ ] **Step 3: app.js — replace i18n keys**

In the zh block: delete `"routes.valeTitle"`, `"routes.valeDesc"`, `"valeSetup.title"`, `"valeSetup.desc"`, `"valeSetup.copy"`, `"valeSetup.copied"`, `"valeSetup.copyFail"`, and add:

```js
      "vale.cardTitle": "Vale",
      "vale.desc": "跨平台一键切换网关渠道。配置一次，之后 <code>vale use</code> 一条命令切换。",
      "vale.defaultModel": "默认模型",
      "vale.setupBtn": "⚡ 一键配置 Vale",
      "vale.setupNote": "命令已复制 —— 粘贴到终端回车，安装 + 注册一次完成；之后用 <code>vale use &lt;渠道&gt;</code> 切换、<code>vale restore</code> 回滚。",
      "vale.cheat": "vale check · vale use &lt;渠道|模型&gt; · vale use auto · vale models · vale restore",
      "vale.healthLoading": "渠道健康加载中…",
      "vale.healthFail": "渠道健康不可达",
      "vale.copyFail": "复制失败，请手动选择复制",
```

In the en block, delete the same old keys and add the corresponding English (cardTitle "Vale CLI setup", desc, defaultModel "Default model", setupBtn "⚡ One-click configure Vale", setupNote, cheat, healthLoading, healthFail, copyFail).

- [ ] **Step 4: app.js — rendering and interaction**

Delete the `valeSetupCommand`/`renderValeSetup` functions and the init binding of `#btn-copy-vale-setup` (from the key-management panel), replacing them with:

```js
  // ── Vale card (overview) ─────────────────────────────
  const VALE_FALLBACK_MODELS = [
    "ds/deepseek-v4-flash", "qw/qwen3.8-max-preview",
    "og/deepseek-v4-flash", "og/minimax-m3", "or/openai/gpt-5.6-luna:floor[1m]",
  ];

  function valeSetupCommand(apiHost, token, model) {
    const base = apiHost ? `https://${apiHost}` : "https://api.saisi.online";
    return `curl -fsSL ${base}/api/vale-install | sh && vale provider add vale-gw --base ${base} --token ${token} --model ${model}`;
  }

  async function loadValeCard() {
    const sel = $("#vale-model-select");
    const btn = $("#btn-vale-setup");
    const note = $("#vale-setup-note");
    const cmd = $("#vale-setup-cmd");
    if (!sel || !btn) return;
    // Model selector: /v1/models (with token), falls back to the built-in list on failure
    let models = VALE_FALLBACK_MODELS;
    try {
      const { res, data } = await api("/v1/models");
      if (res.ok && Array.isArray(data.data)) {
        const ids = data.data.map((m) => m.id).filter((x) => typeof x === "string");
        if (ids.length) models = ids;
      }
    } catch {}
    const groups = {};
    for (const m of models) {
      const p = m.split("/")[0];
      (groups[p] = groups[p] || []).push(m);
    }
    sel.innerHTML = Object.entries(groups)
      .map(([p, ms]) => `<optgroup label="${esc(p + "/")}">${ms.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</optgroup>`)
      .join("");
    // Default-select the recommended model
    try {
      const health = await api("/api/health");
      if (health.res.ok && health.data?.recommended?.model && models.includes(health.data.recommended.model)) {
        sel.value = health.data.recommended.model;
      }
    } catch {}
    const renderCmd = () => {
      cmd.textContent = valeSetupCommand(loadRoutesCache?.apiHost || "", me?.token || "", sel.value);
      cmd.hidden = false;
    };
    btn.addEventListener("click", async () => {
      renderCmd();
      try {
        await navigator.clipboard.writeText(cmd.textContent);
        note.hidden = false;
        toast(t("vale.setupNote"));
      } catch { toast(t("vale.copyFail"), true); }
    });
    // Channel health (public endpoint, 30s polling)
    const healthRow = $("#vale-health-row");
    const renderHealth = async () => {
      try {
        const { res, data } = await api("/api/health");
        if (!res.ok || !Array.isArray(data?.channels)) { healthRow.textContent = t("vale.healthFail"); return; }
        healthRow.innerHTML = data.channels
          .map((c) => `<span class="chip ${c.ok ? "ok" : "bad"}">${esc(c.id + "/")} ${c.ok ? "✅" : `⚠️ ${esc(c.reason || "异常")}`}</span>`)
          .join(" ") + (data.recommended ? ` <span class="muted">推荐: ${esc(data.recommended.model)}</span>` : "");
      } catch { healthRow.textContent = t("vale.healthFail"); }
    };
    await renderHealth();
    if (window.__valeHealthTimer) clearInterval(window.__valeHealthTimer);
    window.__valeHealthTimer = setInterval(renderHealth, 30000);
  }
```

Append `await loadValeCard();` at the end of `loadOverview` (near `app.js:309`).

Note: `loadRoutesCache` doesn't exist — call `loadRoutes()` directly to get apiHost (inside loadValeCard, `const { routes, apiHost } = await loadRoutes();`, then cache it in a local variable for the renderCmd closure). Instead use:

```js
    const { apiHost } = await loadRoutes();
    const renderCmd = () => {
      cmd.textContent = valeSetupCommand(apiHost, me?.token || "", sel.value);
      cmd.hidden = false;
    };
```

- [ ] **Step 5: Verification**

Run: `cd /home/zhengsaisi/vale/gateway && node --check public/app.js && npm test`
Expected: syntax OK; `# tests` all green (62, unaffected by frontend changes)

- [ ] **Step 6: commit**

```bash
cd ~/vale && git add gateway/public/index.html gateway/public/app.js
git commit -m "feat(stage-gateway): console — Vale card on overview, drop scattered blocks" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Deploy + browser verification

**Files:** No code changes (deploy and verify).

- [ ] **Step 1: Deploy**

Run: `cd ~/vale && ./scripts/build.sh gateway`
Expected: `Uploaded vale-gate` + `Current Version ID: ...`; wait 45s for propagation

- [ ] **Step 2: HTML structure verification (curl)**

```bash
curl -s https://ai.saisi.online/ | grep -c "vale-card"        # ≥1: overview Vale card exists
curl -s https://ai.saisi.online/ | grep -c "vale-install-box" # 0: old model-routing block removed
curl -s https://ai.saisi.online/ | grep -c "vale-setup-cmd"   # key-management old block removed (#vale-setup-cmd only 1 occurrence, inside the new card)
```

- [ ] **Step 3: Manual browser verification**
- Overview page card order: Token → Vale → route status
- Vale card: model dropdown (grouped, defaults to the recommended qw/qwen3.8-max-preview), clicking [⚡ One-click configure Vale] shows the command and copies successfully, channel health row (30s refresh), command cheat sheet
- No Vale card remnant on the key-management page; no install-section remnant on the model-routing page
- Paste the copied command into a terminal → install + registration succeed → `vale check` works

## Self-Review Notes

- Spec coverage: model selector ✅(T1), one-click compound config command ✅(T1), 30s channel health ✅(T1), command cheat sheet ✅(T1 HTML), removal of the key-management/model-routing old blocks ✅(T1), verification ✅(T2).
- No placeholders; function names consistent (`valeSetupCommand`/`loadValeCard` match the step code).
