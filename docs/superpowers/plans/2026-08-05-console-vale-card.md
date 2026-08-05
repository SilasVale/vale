# Console 概览页 Vale 卡片 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vale 的网页入口收敛为概览页的一个大卡片（模型选择器 + 一键配置按钮 + 渠道健康 + 命令速查），移除密钥管理与模型路由面板的 vale 块。

**Architecture:** 纯前端改动（`gateway/public/index.html` + `gateway/public/app.js`）：概览页 Token 卡与路由状态卡之间插入 Vale 卡；数据来自已有端点（`/api/me`、`/api/admin/public`、`/api/health`、`/v1/models`）；无后端改动。

**Tech Stack:** vanilla JS（沿用 app.js 现有 `api()`/`t()`/`esc()`/`toast()`/`loadRoutes()` helper）、i18n 双语言、`node --check` 验证。

## Global Constraints

- 浏览器无法读写本机配置 —— 卡片只做信息展示 + 命令生成，不尝试任何本地操作
- 一键配置按钮生成复合命令：`curl -fsSL <base>/api/vale-install | sh && vale provider add vale-gw --base <base> --token <me.token> --model <所选模型>`（`<base>` = apiHost 非空时 `https://${apiHost}`，否则 `https://api.saisi.online`）
- 模型选择器选项来自 `GET /v1/models`（x-api-key: me.token），默认选中 `/api/health` 的 recommended.model；加载失败回退内置列表（ds/qw/og/or 默认模型）
- 渠道健康来自 `GET /api/health`（公开），30s 轮询刷新（仅概览面板激活时）
- 移除：密钥管理面板的 Vale 一键配置卡（HTML + `renderValeSetup`/`valeSetupCommand`）、模型路由面板的 Vale 命令安装区（HTML + 引用）；i18n 旧 key（`routes.valeTitle`、`routes.valeDesc`、`valeSetup.*`）替换为新 `vale.*` keys
- `node --check public/app.js` 通过；`npm test` 全绿（前端改动不破坏现有测试）
- commit：conventional + stage tag + `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: 概览页 Vale 卡（HTML + 渲染 + 移除旧块）

**Files:**
- Modify: `gateway/public/index.html`
- Modify: `gateway/public/app.js`

**Interfaces:**
- Consumes: 现有 `api(path, opts)`、`loadRoutes()`（返回 `{ routes, apiHost }`）、`me.token`（`/api/me` 已加载于 `loadOverview`）、`t()`/`esc()`/`toast()`。
- Produces: `#vale-card`（概览页）、`#vale-model-select`、`#btn-vale-setup`、`#vale-health-row`；函数 `valeSetupCommand(apiHost, token, model)`、`loadValeCard()`（填充选择器+健康+命令）。

- [ ] **Step 1: index.html — 概览页加 Vale 卡（Token 卡后、路由状态卡前）**

在 `<div class="token-actions">...</div>` 的 `</div>`（Token 卡结束）之后、路由状态卡之前插入：

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

- [ ] **Step 2: 移除密钥管理面板的 Vale 卡与模型路由面板的安装区**

index.html：
1. `#panel-keys` 里删除整个 `Vale 一键配置` card（`<div class="card">...valeSetup...</div>`，含 `#vale-setup-cmd`、`#btn-copy-vale-setup`）
2. `#panel-routes` 里删除 `Vale 命令` card（`<div class="card">...routes.valeTitle...</div>`，含 `#vale-install-box`）

- [ ] **Step 3: app.js — i18n keys 替换**

zh 区块：删除 `"routes.valeTitle"`、`"routes.valeDesc"`、`"valeSetup.title"`、`"valeSetup.desc"`、`"valeSetup.copy"`、`"valeSetup.copied"`、`"valeSetup.copyFail"`，新增：

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

en 区块同样删除旧 key、新增对应英文（cardTitle "Vale CLI setup"、desc、defaultModel "Default model"、setupBtn "⚡ One-click configure Vale"、setupNote、cheat、healthLoading、healthFail、copyFail）。

- [ ] **Step 4: app.js — 渲染与交互**

删除 `valeSetupCommand`/`renderValeSetup` 函数与 `#btn-copy-vale-setup` 的 init 绑定（密钥管理面板的），替换为：

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
    // 模型选择器：/v1/models（带 token），失败回退内置列表
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
    // 默认选中推荐模型
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
    // 渠道健康（公开端点，30s 轮询）
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

`loadOverview`（`app.js:309` 附近）末尾追加 `await loadValeCard();`。

注意：`loadRoutesCache` 不存在 —— 直接调用 `loadRoutes()` 拿 apiHost（loadValeCard 内 `const { routes, apiHost } = await loadRoutes();` 然后缓存到局部变量供 renderCmd 闭包使用）。改为：

```js
    const { apiHost } = await loadRoutes();
    const renderCmd = () => {
      cmd.textContent = valeSetupCommand(apiHost, me?.token || "", sel.value);
      cmd.hidden = false;
    };
```

- [ ] **Step 5: 验证**

Run: `cd /home/zhengsaisi/vale/gateway && node --check public/app.js && npm test`
Expected: 语法 OK；`# tests` 全绿（62 个，前端改动不影响）

- [ ] **Step 6: commit**

```bash
cd ~/vale && git add gateway/public/index.html gateway/public/app.js
git commit -m "feat(stage-gateway): console — Vale card on overview, drop scattered blocks" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 部署 + 浏览器验证

**Files:** 无代码改动（部署与验证）。

- [ ] **Step 1: 部署**

Run: `cd ~/vale && ./scripts/build.sh gateway`
Expected: `Uploaded vale-gate` + `Current Version ID: ...`；等 45s 传播

- [ ] **Step 2: HTML 结构验证（curl）**

```bash
curl -s https://ai.saisi.online/ | grep -c "vale-card"        # ≥1：概览 Vale 卡存在
curl -s https://ai.saisi.online/ | grep -c "vale-install-box" # 0：模型路由旧块已移除
curl -s https://ai.saisi.online/ | grep -c "vale-setup-cmd"   # 密钥管理旧块已移除（#vale-setup-cmd 仅新卡内 1 处）
```

- [ ] **Step 3: 浏览器人工验证**
- 概览页卡片顺序：Token → Vale → 路由状态
- Vale 卡：模型下拉（分组、默认选中推荐 qw/qwen3.8-max-preview）、[⚡ 一键配置 Vale] 点击后命令显示且复制成功、渠道健康行（30s 刷新）、命令速查
- 密钥管理页无 Vale 卡残留；模型路由页无安装区残留
- 粘贴复制命令到终端 → 安装+注册成功 → `vale check` 正常

## Self-Review 备注

- Spec 覆盖：模型选择器 ✅(T1)、一键配置复合命令 ✅(T1)、渠道健康 30s ✅(T1)、命令速查 ✅(T1 HTML)、移除密钥管理/模型路由旧块 ✅(T1)、验证 ✅(T2)。
- 无占位符；函数名一致（`valeSetupCommand`/`loadValeCard` 与步骤代码一致）。
