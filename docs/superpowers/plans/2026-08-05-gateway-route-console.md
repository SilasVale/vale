# 网页即控制台（auto 路由）— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 模型名固定 `auto`，网关按用户网页选择（KV 存储）动态路由；密钥管理面板新增"渠道切换"卡片区（key-card 风格）。

**Architecture:** 后端：`store.js` 加 `getUserRoute/setUserRoute`（复用 cget/cset 缓存模式，KV `route:<uid>` 存完整模型名）；`index.js` 在 handleGateway 解析 `model === "auto"` 为 `resolveAutoModel(env, uid)`（所选渠道不可用回退推荐），handleConsole 加 `GET/PUT /api/me/route`（session 鉴权 + MODELS 白名单校验）。前端：密钥管理面板 key-card 风格渠道卡片（/api/health + /api/me/route），移除概览页 Vale 卡。

**Tech Stack:** Cloudflare Worker（store.js/index.js）、vanilla JS 前端、`node --test`。

## Global Constraints

- route 值 = 完整模型名（如 `qw/qwen3.8-max-preview`）；`model === "auto"` 字面量精确匹配才触发用户路由（无前缀模型名保持 default→ds 现状）
- `resolveAutoModel`：所选渠道需在 MODELS 白名单且（og）breaker 未开，否则回退 `buildHealth().recommended`，再无则 `ds/deepseek-v4-flash`
- `PUT /api/me/route`：body `{ model }`，`model` 必须精确匹配 MODELS 白名单（400 否则）；`model: null` 清除选择
- 缓存语义：内存为主，KV 每 isolate 24h 读一次；setUserRoute write-through
- 前端：渠道卡片复用 `key-card` CSS class；概览 Vale 卡整体移除（HTML/JS/i18n）
- 测试：62 现有全绿 + 新增；commit conventional + Co-Authored-By

---

### Task 1: store.js — getUserRoute / setUserRoute

**Files:**
- Modify: `gateway/src/store.js`
- Test: `gateway/test/store.cache.test.mjs`（追加）

**Interfaces:**
- Produces: `getUserRoute(env, id)` → `string | null`；`setUserRoute(env, id, model)` → void。Task 2 消费。

- [ ] **Step 1: 写失败测试**（`store.cache.test.mjs` 追加）

```js
test("getUserRoute / setUserRoute: cached read, write-through refresh", async () => {
  const kv = makeKV({});
  assert.equal(await store.getUserRoute(kv, "admin"), null); // miss → 1 get
  await store.setUserRoute(kv, "admin", "qw/qwen3.8-max-preview"); // put + cache
  assert.equal(await store.getUserRoute(kv, "admin"), "qw/qwen3.8-max-preview"); // cache hit
  assert.equal(kv.counters.get, 1); // 只有首次读 KV
  await store.setUserRoute(kv, "admin", "ds/deepseek-v4-flash"); // write-through
  assert.equal(await store.getUserRoute(kv, "admin"), "ds/deepseek-v4-flash");
  assert.equal(kv.counters.get, 1); // 仍无新 KV 读
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/vale/gateway && node --test test/store.cache.test.mjs`
Expected: FAIL — `store.getUserRoute is not a function`

- [ ] **Step 3: 实现**（`store.js`，放在 `getUserKeys` 附近）

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
  cset(key, String(model)); // write-through：切换立即生效（同 isolate 零延迟）
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/vale/gateway && node --test test/store.cache.test.mjs`
Expected: PASS

- [ ] **Step 5: 完整测试 + commit**

Run: `cd ~/vale/gateway && npm test` — 全绿
```bash
cd ~/vale && git add gateway/src/store.js gateway/test/store.cache.test.mjs
git commit -m "feat(stage-gateway): store — per-user route selection (get/set, write-through cache)" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: index.js — resolveAutoModel + auto 分支 + /api/me/route 端点

**Files:**
- Modify: `gateway/src/index.js`
- Test: `gateway/test/health.test.mjs`（追加 resolveAutoModel 用例）

**Interfaces:**
- Consumes: Task 1 的 `getUserRoute/setUserRoute`；现有 `buildHealth(env)`、`isChannelDegraded(env)`、`MODELS`。
- Produces: `resolveAutoModel(env, uid)` 导出；handleGateway 的 `model === "auto"` 分支；console `GET/PUT /api/me/route`。Task 3 消费 `/api/me/route`。

- [ ] **Step 1: 写失败测试**（`health.test.mjs` 追加）

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

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs`
Expected: FAIL — `resolveAutoModel is not exported`

- [ ] **Step 3: 实现**

a) 导入 store 新函数（`index.js` 顶部 import 行追加 `getUserRoute, setUserRoute`）。

b) 在 `buildHealth` 之后加：

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

c) handleGateway 的 model 解析（`const model = body.model || "";` 之后、`const prefix = ...` 之前）：

```js
  let model = body.model || "";
  if (model === "auto") {
    // Claude Code 固定模型名 auto：按用户网页选择路由
    model = await resolveAutoModel(env, user.id);
  }
  const prefix = model.split("/")[0];
```

注意：`model` 从 `const` 改为 `let`。

d) console 端点（handleConsole 的 session 区，`/api/me` 处理之后）：

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

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs && npm test`
Expected: PASS（全部）

- [ ] **Step 5: commit**

```bash
cd ~/vale && git add gateway/src/index.js gateway/test/health.test.mjs
git commit -m "feat(stage-gateway): model=auto routes per-user choice; /api/me/route endpoints" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 前端 — 密钥管理面板渠道切换卡（key-card 风格）+ 移除概览 Vale 卡

**Files:**
- Modify: `gateway/public/index.html`
- Modify: `gateway/public/app.js`

**Interfaces:**
- Consumes: Task 2 的 `GET/PUT /api/me/route`；现有 `api()`、`t()`、`esc()`、`/api/health`。
- Produces: 密钥管理面板 `#route-cards`（渠道卡片网格，key-card 风格）、`#btn-route-auto`；移除 `#vale-card` 及 `loadValeCard`/`valeSetupCommand`。

- [ ] **Step 1: index.html — 密钥管理面板加渠道切换区、移除概览 Vale 卡**

a) `#panel-keys` 的 `#keys-cards` 之后加：

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

b) 删除概览页整个 `#vale-card`（`<div class="card" id="vale-card">...</div>`）。

- [ ] **Step 2: app.js — i18n（zh/en）**

zh 新增/替换：
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
en 对应英文。删除 `vale.*` keys（`vale.cardTitle`、`vale.desc`、`vale.defaultModel`、`vale.setupBtn`、`vale.setupNote`、`vale.cheat`、`vale.healthLoading`、`vale.healthFail`、`vale.recommend`、`vale.copyFail`）。

- [ ] **Step 3: app.js — 渲染与交互**

删除 `VALE_FALLBACK_MODELS`、`valeSetupCommand`、`loadValeCard` 及 `loadOverview` 里的 `await loadValeCard();` 调用；替换为：

```js
  /* ============ route switch (keys panel) ============ */
  // 渠道切换：/api/health 状态 + /api/me/route 当前选择；点 [使用] → PUT。
  // 卡片复用 key-card 的样式，视觉与密钥卡片一致。
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

`loadKeys()` 末尾追加 `await loadRouteCards();`。

注意：`btn-route-auto` 的 addEventListener 在每次 loadRouteCards 里绑定会重复 —— 把 auto 按钮绑定移到 init（一次性），loadRouteCards 只负责渲染 + use 按钮（use 按钮是动态 innerHTML 里的，绑定在 box 上 ✅ 每次渲染新 listener 替换旧的，无重复问题）。调整：auto 按钮在 init 里绑定，点击时调一个共享的 `clearRoute()` 函数：

```js
  async function clearRoute() {
    const r = await api("/api/me/route", { method: "PUT", body: JSON.stringify({ model: null }) });
    if (r.res.ok) { toast(t("route.switched")); await loadRouteCards(); }
    else toast(t("route.fail"), true);
  }
```
init 里：`$("#btn-route-auto")?.addEventListener("click", clearRoute);`
`loadRouteCards` 里删除 auto 按钮绑定。

- [ ] **Step 4: 验证**

Run: `cd /home/zhengsaisi/vale/gateway && node --check public/app.js && npm test`
Expected: 语法 OK；62 全绿

- [ ] **Step 5: commit**

```bash
cd ~/vale && git add gateway/public/index.html gateway/public/app.js
git commit -m "feat(stage-gateway): console — channel switch cards in keys panel (auto routing), drop overview vale card" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 部署 + E2E 验证（含用户配置迁移）

**Files:** 无代码改动（部署与验证）。

- [ ] **Step 1: 部署**

Run: `cd ~/vale && ./scripts/build.sh gateway`；等 45s 传播

- [ ] **Step 2: API 验证（curl）**

```bash
# 登录拿 session cookie（admin 密码从 KV 读，同之前验证流程）
# GET /api/me/route → {"model":null}
# PUT /api/me/route {"model":"qw/qwen3.8-max-preview"} → {"ok":true,"model":"..."}
# PUT /api/me/route {"model":"xx/nope"} → 400
# 请求验证 auto 路由：
curl -s https://api.saisi.online/v1/messages -H "x-api-key: 5e7874ea..." -d '{"model":"auto","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
# → 200，响应 model 字段 = qw/qwen3.8-max-preview（所选渠道）
# count_tokens auto 同样正常
```

- [ ] **Step 3: 前端验证（curl HTML + 浏览器）**

```bash
curl -s https://ai.saisi.online/ | grep -c 'id="route-cards"'   # ≥1
curl -s https://ai.saisi.online/ | grep -c 'id="vale-card"'     # 0（已移除）
```
浏览器：密钥管理页渠道卡片（当前高亮、[使用] 点击切换、自动按钮）；概览页无 Vale 卡残留。

- [ ] **Step 4: 用户配置迁移（settings.json 模型 → auto）**

把 `~/.claude/settings.json` 的 7 个模型字段改为 `auto`（备份后改，保持 base/token）—— 询问用户确认后执行；改完提示"以后在网页密钥管理页点渠道即可切换，无需重启"。

- [ ] **Step 5: 回归**

`cd ~/vale/gateway && npm test` 全绿；`git status` 干净。

## Self-Review 备注

- Spec 覆盖：getUserRoute/setUserRoute ✅(T1)、resolveAutoModel + auto 分支 ✅(T2)、/api/me/route ✅(T2)、密钥管理渠道卡 ✅(T3)、移除概览 Vale 卡 ✅(T3)、验证+迁移 ✅(T4)。
- 类型一致：`getUserRoute(env, id)`/`setUserRoute(env, id, model)`/`resolveAutoModel(env, uid)`/`isModelUsable(env, model)` 跨任务一致；前端 `model: null` 清除语义与 setUserRoute 的 null 分支一致。
- 无占位符。
