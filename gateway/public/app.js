/* Vale console — AI gateway (BYOK) + device management, bilingual (zh/en) */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const KEY_NAMES = ["DEEPSEEK_API_KEY", "OPENCODE_GO_API_KEY", "OPENROUTER_API_KEY"];

  /* ============ i18n ============ */
  const I18N = {
    zh: {
      "app.sub": "Vale 平台 · AI 网关与设备",
      "auth.login": "登录", "auth.register": "注册",
      "auth.username": "用户名", "auth.password": "密码", "auth.inviteCode": "邀请码",
      "auth.usernamePh": "用户名", "auth.passwordPh": "密码",
      "auth.usernamePhReg": "用户名（2-32 位字母/数字/_.-）", "auth.passwordPhReg": "密码（至少 6 位）",
      "auth.invitePh": "向管理员索取邀请码",
      "auth.loginBtn": "登录", "auth.registerBtn": "注册并登录",
      "auth.foot": "注册后带上自己的 DeepSeek / OpenCode Go 密钥即可通过本网关转发。",
      "auth.loginFail": "登录失败", "auth.registerFail": "注册失败",
      "nav.overview": "概览", "nav.keys": "密钥管理", "nav.routes": "模型路由", "nav.users": "用户管理",
      "btn.logout": "退出登录", "btn.copy": "复制", "btn.show": "显示", "btn.hide": "隐藏", "btn.regenerate": "重新生成 Token",
      "role.admin": "管理员", "role.user": "用户",
      "overview.title": "概览", "overview.lede": "你的网关凭证与后端密钥状态。",
      "token.title": "网关 Token", "token.desc": "客户端 <code>x-api-key</code> 填这个值；模型名用 <code>og/…</code>、<code>ds/…</code> 前缀路由。",
      "token.copied": "已复制网关 Token", "token.copyFail": "复制失败，请手动选择复制",
      "token.regenerateConfirm": "重生成网关 Token 后，旧 Token 立即失效，所有用旧 Token 的客户端需更新。\n\n注意：你是管理员，重生成后旧 CLIENT_KEY（settings.json 里的）将失效，需同步更新。",
      "token.regenerated": "已生成新 Token，旧 Token 已失效。请同步更新客户端配置。",
      "token.regenerateFail": "重生成失败",
      "routes.title": "路由状态", "routes.lede": "请求模型名按 <code>前缀/模型</code> 路由到对应后端；无前缀默认走 DeepSeek 官方。",
      "route.title": "渠道切换",
      "route.desc": "Claude Code 模型名配 <code>auto</code> 后，在这里点一下即可切换，无需重启。未选择时默认走 <code>ds/deepseek-v4-flash</code>。",
      "route.use": "使用",
      "route.current": "当前",
      "route.bad": "异常",
      "route.auto": "恢复默认渠道（ds）",
      "route.switched": "已切换，下次请求生效",
      "route.fail": "切换失败",
      "route.loadFail": "渠道状态加载失败",
      "keys.title": "密钥管理", "keys.lede": "填入你自己在对应服务商申请的 API key，网关转发时只使用你自己的 key，各算各的额度。",
      "key.configured": "已配置", "key.notConfigured": "未配置",
      "key.ds.backend": "DeepSeek", "key.ds.hint": "api.deepseek.com 申请",
      "key.og.backend": "OpenCode Go", "key.og.hint": "opencode.ai/zen/go 申请",
      "key.or.backend": "OpenRouter", "key.or.hint": "openrouter.ai/keys 申请",
      "btn.edit": "编辑", "btn.test": "测试连通", "btn.testing": "测试中…", "btn.clear": "清除", "btn.save": "保存", "btn.cancel": "取消",
      "key.emptyValue": "值不能为空", "key.saved": "已保存", "key.saveFail": "保存失败",
      "key.clearConfirm": "确定清除 {name} 吗？之后走该路由会返回 502。", "key.cleared": "已清除",
      "key.testOk": "✓ 连通正常（HTTP {status}）", "key.testFail": "✗ {detail}",
      "client.title": "客户端接入示例（Claude Code）",
      "client.note": "模型名里的 <code>[1m]</code> 是 Claude Code 的 1M 上下文窗口标记，上行前它自己会剥掉，网关按前缀路由不受影响。curl 手测勿发带 <code>[1m]</code> 的字面模型名。",
      "route.og.backend": "OpenCode Go 套餐", "route.og.desc": "opencode.ai/zen/go，Anthropic↔OpenAI 转译，含工具调用与 thinking 回传",
      "route.ds.backend": "DeepSeek 官方", "route.ds.desc": "api.deepseek.com/anthropic，Bearer 透传",
      "route.or.backend": "OpenRouter", "route.or.desc": "openrouter.ai，透传用户自己的 key（经 openrouter-proxy 代理）",
      "route.none.label": "无前缀", "route.none.backend": "DeepSeek 官方（默认）", "route.none.desc": "兜底路由",
      "users.lede": "管理员密码、邀请码与用户列表。",
      "adminpw.title": "管理员密码", "adminpw.desc": "控制台登录用的密码（也是会话签名钥匙）。改完需用新密码重新登录。",
      "adminpw.placeholder": "新密码（至少 8 位）", "adminpw.change": "修改密码",
      "adminpw.copied": "已复制管理员密码", "adminpw.copyFail": "复制失败，请手动选择",
      "adminpw.short": "管理员密码至少 8 位", "adminpw.changed": "密码已修改，会话将失效，请用新密码重新登录。", "adminpw.changeFail": "修改失败",
      "invite.title": "邀请码", "invite.gen": "生成邀请码", "invite.new": "新邀请码：{code}（一次性，用完即焚）", "invite.genFail": "生成失败",
      "users.list": "用户列表",
      "user.enabled": "启用", "user.disabled": "禁用", "user.disableToast": "已禁用", "user.enableToast": "已启用",
      "migrated.yes": "已自动迁移至 KV", "migrated.no": "KV 未初始化",
      "nav.devices": "设备管理", "devices.lede": "注册每台 Windows 设备（vale-command）的 token，控制台即可代理到设备面板、复制 MCP 配置。",
      "devices.addTitle": "添加 / 更新设备", "devices.listTitle": "设备列表",
      "devices.namePh": "设备名（如 d1）", "devices.hostPh": "<device-host>", "devices.tokenPh": "Bearer token（安装时生成）",
      "devices.saved": "设备已保存", "devices.saveFail": "保存失败",
      "devices.deleted": "已删除", "devices.deleteConfirm": "删除设备 {name}？",
      "devices.open": "打开面板", "devices.copyMcp": "复制 MCP 配置", "devices.mcpCopied": "MCP 配置已复制",
      "devices.empty": "还没有设备。用注册码自动登记，或手动填一台（名 / 主机 / token）。",
      "cf.title": "Cloudflare 隧道凭据", "cf.configured": "已配置", "cf.notConfigured": "未配置",
      "cf.desc": "安装时自动配置隧道的账户级 API token（需 Tunnel:Edit + Zone:DNS:Edit 权限）。存这里后，Windows 安装带注册码即可自动取用，无需浏览器授权。",
      "cf.saved": "已保存", "cf.empty": "已清除（安装时将回退到浏览器授权）",
      "devices.regKeyTitle": "安装新设备", "devices.genKey": "生成注册码", "devices.downloadInstall": "下载安装程序 ↓",
      "devices.regKeyDesc": "下载安装程序 → 生成注册码 → Windows 上设置 <code>$env:VALE_REG_KEY</code> 后安装，装完自动登记到下方列表（无需手动抄 token）。",
      "devices.keyGenerated": "注册码（一次性，装完即焚）：{code}",
      "devices.regKeyCmd": "在 Windows 安装时先设置这个环境变量，再运行安装：",
      "devices.genKeyFail": "生成失败", "devices.keyCopied": "注册码已复制",
      "devices.online": "在线", "devices.offline": "离线",
      "devices.pair": "配对扩展", "devices.pairFor": "设备：{name}",
      "devices.pairHint": "在扩展 popup 输入此码完成配对。一次性，10 分钟内有效。",
      "devices.pairCopied": "已复制配对码", "devices.pairFail": "生成配对码失败",
      "gwMcp.title": "网关 MCP 配置",
      "gwMcp.desc": "Claude Code 通过本配置接入网关（浏览器 / 终端工具），使用你当前账户的 token。",
      "gwMcp.copy": "复制网关 MCP 配置",
      "ext.title": "安装浏览器扩展", "ext.download": "下载扩展 ↓", "ext.desc": "在 Windows 设备的 Chrome/Edge 里加载此扩展，AI 才能操作设备浏览器。三步：下载 zip → 解压 → chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」选解压文件夹。装好后在本页对应设备点「配对扩展」。",
      "loading": "加载中…", "err.loadRoutes": "路由信息加载失败",
    },
    en: {
      "app.sub": "Vale platform — AI relay & devices",
      "auth.login": "Log in", "auth.register": "Sign up",
      "auth.username": "Username", "auth.password": "Password", "auth.inviteCode": "Invite code",
      "auth.usernamePh": "Username", "auth.passwordPh": "Password",
      "auth.usernamePhReg": "Username (2-32 chars: letters/digits/_.-)", "auth.passwordPhReg": "Password (min 6 chars)",
      "auth.invitePh": "Ask the admin for an invite code",
      "auth.loginBtn": "Log in", "auth.registerBtn": "Sign up & log in",
      "auth.foot": "After signing up, add your own DeepSeek / OpenCode Go keys and route through this gateway.",
      "auth.loginFail": "Login failed", "auth.registerFail": "Registration failed",
      "nav.overview": "Overview", "nav.keys": "API Keys", "nav.routes": "Routing", "nav.users": "Users",
      "btn.logout": "Log out", "btn.copy": "Copy", "btn.show": "Show", "btn.hide": "Hide", "btn.regenerate": "Regenerate token",
      "role.admin": "Admin", "role.user": "User",
      "overview.title": "Overview", "overview.lede": "Your gateway credentials and backend key status.",
      "token.title": "Gateway Token", "token.desc": "Set this as the client <code>x-api-key</code>; prefix model names with <code>og/…</code>, <code>ds/…</code> for routing.",
      "token.copied": "Gateway token copied", "token.copyFail": "Copy failed — select and copy manually",
      "token.regenerateConfirm": "Regenerating invalidates the old token immediately; all clients using it must update.\n\nNote: you are the admin — the old CLIENT_KEY (in settings.json) will stop working; update it too.",
      "token.regenerated": "New token generated; the old one is invalid. Update your client configs.",
      "token.regenerateFail": "Regenerate failed",
      "routes.title": "Routing status", "routes.lede": "Model names are routed by prefix; no prefix defaults to DeepSeek official.",
      "route.title": "Channel switch",
      "route.desc": "Set the Claude Code model to <code>auto</code>, then flip channels here — no restart needed. Defaults to <code>ds/deepseek-v4-flash</code> when unset.",
      "route.use": "Use",
      "route.current": "Current",
      "route.bad": "Down",
      "route.auto": "Restore default (ds)",
      "route.switched": "Switched — takes effect on the next request",
      "route.fail": "Switch failed",
      "route.loadFail": "Failed to load channel status",
      "keys.title": "API Keys", "keys.lede": "Add your own API keys from each provider; the gateway only uses your keys, so each user pays for their own usage.",
      "key.configured": "Configured", "key.notConfigured": "Not configured",
      "key.ds.backend": "DeepSeek", "key.ds.hint": "from api.deepseek.com",
      "key.og.backend": "OpenCode Go", "key.og.hint": "from opencode.ai/zen/go",
      "key.or.backend": "OpenRouter", "key.or.hint": "from openrouter.ai/keys",
      "btn.edit": "Edit", "btn.test": "Test", "btn.testing": "Testing…", "btn.clear": "Clear", "btn.save": "Save", "btn.cancel": "Cancel",
      "key.emptyValue": "Value cannot be empty", "key.saved": "Saved", "key.saveFail": "Save failed",
      "key.clearConfirm": "Clear {name}? Routes using it will return 502.", "key.cleared": "Cleared",
      "key.testOk": "✓ OK (HTTP {status})", "key.testFail": "✗ {detail}",
      "client.title": "Client setup example (Claude Code)",
      "client.note": "The <code>[1m]</code> suffix is Claude Code's 1M-context marker; it strips it before sending, so prefix routing is unaffected. When testing with curl, don't send a literal <code>[1m]</code>.",
      "route.og.backend": "OpenCode Go", "route.og.desc": "opencode.ai/zen/go — Anthropic↔OpenAI translation, tool calls & thinking",
      "route.ds.backend": "DeepSeek Official", "route.ds.desc": "api.deepseek.com/anthropic — Bearer passthrough",
      "route.or.backend": "OpenRouter", "route.or.desc": "openrouter.ai — user's own key, proxied via openrouter-proxy",
      "route.none.label": "default", "route.none.backend": "DeepSeek Official (default)", "route.none.desc": "fallback route",
      "users.lede": "Admin password, invite codes and the user list.",
      "adminpw.title": "Admin password", "adminpw.desc": "The console login password (also the session signing key). Re-login with the new password after changing.",
      "adminpw.placeholder": "New password (min 8 chars)", "adminpw.change": "Change password",
      "adminpw.copied": "Admin password copied", "adminpw.copyFail": "Copy failed — select manually",
      "adminpw.short": "Admin password must be at least 8 chars", "adminpw.changed": "Password changed; the session will expire — log in with the new password.", "adminpw.changeFail": "Change failed",
      "invite.title": "Invite codes", "invite.gen": "Generate invite", "invite.new": "New invite: {code} (one-time)", "invite.genFail": "Generation failed",
      "users.list": "Users",
      "user.enabled": "Enabled", "user.disabled": "Disabled", "user.disableToast": "Disabled", "user.enableToast": "Enabled",
      "migrated.yes": "Migrated to KV", "migrated.no": "KV not initialized",
      "nav.devices": "Devices", "devices.lede": "Register each Windows device (vale-command) token so the console can proxy to its panel and copy MCP configs.",
      "devices.addTitle": "Add / update device", "devices.listTitle": "Devices",
      "devices.namePh": "Device name (e.g. d1)", "devices.hostPh": "<device-host>", "devices.tokenPh": "Bearer token (from install)",
      "devices.saved": "Device saved", "devices.saveFail": "Save failed",
      "devices.deleted": "Deleted", "devices.deleteConfirm": "Delete device {name}?",
      "devices.open": "Open panel", "devices.copyMcp": "Copy MCP config", "devices.mcpCopied": "MCP config copied",
      "devices.empty": "No devices yet. Auto-register with a key, or add one manually (name / host / token).",
      "cf.title": "Cloudflare tunnel credential", "cf.configured": "Configured", "cf.notConfigured": "Not configured",
      "cf.desc": "Account-level API token used by installs to set up the tunnel (needs Tunnel:Edit + Zone:DNS:Edit). Once saved, Windows installs fetch it with a registration key — no browser login.",
      "cf.saved": "Saved", "cf.empty": "Cleared (installs will fall back to browser auth)",
      "devices.regKeyTitle": "Install a device", "devices.genKey": "Generate key", "devices.downloadInstall": "Download installer ↓",
      "devices.regKeyDesc": "Download the installer → generate a key → set <code>$env:VALE_REG_KEY</code> on Windows and install. The device registers itself below — no token copy-paste.",
      "devices.keyGenerated": "Registration key (one-time, consumed on use): {code}",
      "devices.regKeyCmd": "Set this env var on the Windows machine before install, then run:",
      "devices.genKeyFail": "Generation failed", "devices.keyCopied": "Registration key copied",
      "devices.online": "Online", "devices.offline": "Offline",
      "devices.pair": "Pair extension", "devices.pairFor": "Device: {name}",
      "devices.pairHint": "Enter this code in the extension popup to pair. One-time, valid for 10 minutes.",
      "devices.pairCopied": "Pairing code copied", "devices.pairFail": "Failed to generate pairing code",
      "gwMcp.title": "Gateway MCP config",
      "gwMcp.desc": "Claude Code connects to the gateway (browser / terminal tools) with this config, using your current account's token.",
      "gwMcp.copy": "Copy gateway MCP config",
      "ext.title": "Install browser extension", "ext.download": "Download extension ↓", "ext.desc": "Load this extension in the device's Chrome/Edge so the AI can operate the device browser. Three steps: download zip → unzip → chrome://extensions enable Developer mode → Load unpacked → pick the folder. Then click Pair on the device below.",
      "loading": "Loading…", "err.loadRoutes": "Failed to load routes",
    },
  };

  let lang = "zh";
  try { lang = localStorage.getItem("valegate-lang") || (navigator.language || "zh").startsWith("zh") ? "zh" : "en"; } catch (e) { /* ignore */ }
  if (lang !== "zh" && lang !== "en") lang = "zh";

  function t(key, vars) {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
    return s;
  }

  function setLang(next) {
    lang = next;
    try { localStorage.setItem("valegate-lang", lang); } catch (e) { /* ignore */ }
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    applyStaticText();
    renderLangToggles();
    if (!$("#view-app").hidden) { const cur = $(".nav-item.active"); switchPanel(cur ? cur.dataset.panel : "overview"); }
  }

  function applyStaticText() {
    $$("[data-i18n]").forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    // input placeholders
    const pl = {
      "#form-login [name=username]": "auth.usernamePh",
      "#form-login [name=password]": "auth.passwordPh",
      "#form-register [name=username]": "auth.usernamePhReg",
      "#form-register [name=password]": "auth.passwordPhReg",
      "#form-register [name=inviteCode]": "auth.invitePh",
      "#admin-pw-new": "adminpw.placeholder",
    };
    for (const [sel, key] of Object.entries(pl)) {
      const el = $(sel);
      if (el) el.placeholder = t(key);
    }
  }

  function renderLangToggles() {
    $$("[data-lang-toggle]").forEach((el) => {
      el.innerHTML = `<button class="lang-btn" data-lang-btn>${lang === "zh" ? "EN" : "中文"}</button>`;
    });
  }

  /* ============ helpers ============ */
  let me = null;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* noop */ }
    if (res.status === 401) showAuth();
    return { res, data };
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function toast(msg, isErr) {
    const el = $("#toast");
    el.hidden = false;
    el.textContent = msg;
    el.className = "toast" + (isErr ? " err" : "");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function maskToken(tok) {
    if (!tok) return "";
    if (tok.length <= 8) return tok[0] + "…" + tok.slice(-3);
    return tok.slice(0, 6) + "…" + tok.slice(-4);
  }

  /* ============ routing switchboard ============ */
  function switchboardHTML(routes) {
    const ROUTE_KEY = { "og/": "og", "ds/": "ds", "or/": "or", none: "none" };
    return routes
      .map((r) => {
        const key = ROUTE_KEY[r.prefix] || "none";
        const laneClass = { og: "og", ds: "ds", or: "or" }[key] || "def";
        const portLabel = key === "none" ? t("route.none.label") : r.prefix.replace("/", "");
        const backend = t("route." + key + ".backend") || r.backend;
        const desc = t("route." + key + ".desc") || r.desc;
        return `
        <div class="lane lane-${laneClass}">
          <div class="lane-port">${esc(portLabel)}</div>
          <div class="lane-arrow">▸</div>
          <div class="lane-body">
            <div class="backend">${esc(backend)}</div>
            <div class="desc">${esc(desc)}</div>
          </div>
          <div class="lane-models">${(r.models || []).map((m) => `<span class="model-tag">${esc(m)}</span>`).join("")}</div>
        </div>`;
      })
      .join("");
  }

  async function loadRoutes() {
    const { res, data } = await api("/api/admin/public");
    if (!res.ok) return { routes: [], apiHost: "" };
    return { routes: data.routes || [], apiHost: data.apiHost || "" };
  }

  /* ============ auth ============ */
  async function init() {
    const { res, data } = await api("/api/me");
    if (res.ok && data.username) {
      me = data;
      showApp();
    } else {
      showAuth();
    }
  }

  function showAuth() {
    $("#view-auth").hidden = false;
    $("#view-app").hidden = true;
  }

  function showApp() {
    $("#view-auth").hidden = true;
    $("#view-app").hidden = false;
    $("#side-user").innerHTML =
      `<div class="name">${esc(me.username)}</div><div class="role">${me.role === "admin" ? t("role.admin") : t("role.user")}</div>`;
    // Un-hide every admin-only element (users nav, devices nav, …). $() would
    // only touch the first match, leaving later [data-admin-only] sections hidden.
    $$('[data-admin-only]').forEach((el) => { el.hidden = me.role !== "admin"; });
    switchPanel("overview");
  }

  function switchPanel(name) {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
    $$(".panel").forEach((p) => { p.hidden = p.id !== "panel-" + name; });
    if (name === "overview") loadOverview();
    if (name === "keys") loadKeys();
    if (name === "routes") loadRoutesPanel();
    if (name === "users") loadUsers();
    if (name === "devices") loadDevices();
    else stopDevicesPoll(); // 离开设备面板就停在线轮询
  }

  /* ============ overview ============ */
  let tokenRevealed = false;
  async function loadOverview() {
    const { res, data } = await api("/api/me");
    if (!res.ok) return;
    me = data;
    tokenRevealed = false;
    $("#role-badge").textContent = me.role === "admin" ? t("role.admin") : t("role.user");
    $("#role-badge").className = "badge " + (me.role === "admin" ? "admin" : "user");
    renderToken();
    $("#token-note").hidden = true;
    const { routes } = await loadRoutes();
    $("#overview-switchboard").innerHTML = switchboardHTML(routes);
  }

  function renderToken() {
    const el = $("#token-value");
    el.textContent = tokenRevealed ? me.token : maskToken(me.token);
    $("#btn-reveal").textContent = tokenRevealed ? t("btn.hide") : t("btn.show");
  }

  /* ============ keys ============ */
  async function loadKeys() {
    const { res, data } = await api("/api/me");
    if (!res.ok) return;
    me = data;
    $("#keys-cards").innerHTML = KEY_NAMES.map((n) => keyCardHTML(n, me.keys[n])).join("");
  }

  function keyCardHTML(name, info) {
    const masked = esc(info?.masked || t("key.notConfigured"));
    const configured = !!(info && info.configured);
    const badge = configured ? `<span class="badge ok">${t("key.configured")}</span>` : `<span class="badge empty">${t("key.notConfigured")}</span>`;
    const keyName = name.replace("_API_KEY", "").toLowerCase();
    const backend = t(`key.${keyName}.backend`);
    const hint = t(`key.${keyName}.hint`);
    return `
      <div class="key-card" data-name="${name}">
        <div class="top">
          <div>
            <div class="key-name">${esc(name)}</div>
            <div class="key-desc">${esc(backend)} · ${esc(hint)}</div>
          </div>
          ${badge}
        </div>
        <div class="key-value" data-masked>${masked}</div>
        <div class="key-actions">
          <button class="btn-primary btn-mini" data-act="edit">${t("btn.edit")}</button>
          <button class="btn-ghost btn-mini" data-act="test">${t("btn.test")}</button>
          <button class="btn-danger btn-mini" data-act="clear">${t("btn.clear")}</button>
        </div>
        <div data-edit hidden>
          <div class="key-edit-row">
            <input type="text" data-value placeholder="…" autocomplete="off">
            <button class="btn-primary btn-mini" data-act="save">${t("btn.save")}</button>
            <button class="btn-ghost btn-mini" data-act="cancel">${t("btn.cancel")}</button>
          </div>
        </div>
        <div data-result hidden></div>
      </div>`;
  }

  async function bindKeyActions() {
    const box = $("#keys-cards");
    box.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const card = btn.closest(".key-card");
      const name = card.dataset.name;
      const act = btn.dataset.act;

      if (act === "edit") { card.querySelector("[data-edit]").hidden = false; return; }
      if (act === "cancel") { card.querySelector("[data-edit]").hidden = true; return; }

      if (act === "save") {
        const value = card.querySelector("[data-value]").value.trim();
        if (!value) return flash(card, t("key.emptyValue"), false);
        const { res, data } = await api("/api/me/keys", { method: "PUT", body: JSON.stringify({ name, value }) });
        if (res.ok) {
          card.querySelector("[data-masked]").textContent = data.masked;
          card.querySelector("[data-value]").value = "";
          card.querySelector("[data-edit]").hidden = true;
          toast(t("key.saved") + " " + name);
          loadKeys();
        } else {
          flash(card, data?.error?.message || t("key.saveFail"), false);
        }
        return;
      }

      if (act === "test") {
        btn.disabled = true; btn.textContent = t("btn.testing");
        const { res, data } = await api("/api/me/keys/test", { method: "POST", body: JSON.stringify({ name }) });
        btn.disabled = false; btn.textContent = t("btn.test");
        showResult(card, res.ok ? data : { ok: false, detail: data?.error?.message || "…" });
        return;
      }

      if (act === "clear") {
        if (!confirm(t("key.clearConfirm", { name }))) return;
        const { res, data } = await api(`/api/me/keys?name=${encodeURIComponent(name)}`, { method: "DELETE" });
        if (res.ok) { toast(t("key.cleared") + " " + name); loadKeys(); }
        else toast(data?.error?.message || t("key.saveFail"), true);
      }
    });
  }

  function showResult(card, d) {
    const box = card.querySelector("[data-result]");
    box.hidden = false;
    box.className = "test-result " + (d.ok ? "ok" : "err");
    box.textContent = d.ok
      ? t("key.testOk", { status: d.status || 200 }) + (d.detail ? " · " + d.detail : "")
      : t("key.testFail", { detail: d.detail || "…" });
  }

  function flash(card, msg, ok) {
    const box = card.querySelector("[data-result]");
    box.hidden = false;
    box.className = "test-result " + (ok ? "ok" : "err");
    box.textContent = msg;
    setTimeout(() => { box.hidden = true; }, 3000);
  }

  /* ============ routes panel ============ */
  // 渠道切换：/api/health 状态 + /api/me/route 当前选择；点 [使用] → PUT。
  // 卡片复用 key-card 的样式，视觉与密钥管理页一致。
  function routeCardHTML(ch, current) {
    const status = ch.ok
      ? `<span class="badge ok">${t("route.use")}</span>`
      : `<span class="badge off">${esc(ch.reason || t("route.bad"))}</span>`;
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
    // [使用] 按钮是动态渲染的，委托到容器；只绑定一次，避免每次重渲染叠加 listener。
    if (!box.dataset.bound) {
      box.dataset.bound = "1";
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
    }
  }

  async function clearRoute() {
    const r = await api("/api/me/route", { method: "PUT", body: JSON.stringify({ model: null }) });
    if (r.res.ok) { toast(t("route.switched")); await loadRouteCards(); }
    else toast(t("route.fail"), true);
  }

  async function loadRoutesPanel() {
    const { apiHost } = await loadRoutes();
    const ex = $("#client-example");
    if (ex) {
      // 用当前账户的真实值渲染客户端接入示例（base + 网关 token + auto[1m]）
      const base = apiHost ? `https://${apiHost}` : "https://api.saisi.online";
      const token = me?.token || "<your gateway token>";
      const modelKeys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ];
      const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token };
      for (const k of modelKeys) env[k] = "auto[1m]";
      ex.textContent = JSON.stringify({ env }, null, 2);
    }
    await loadRouteCards();
  }

  /* ============ users (admin) ============ */
  let adminPw = "", pwRevealed = false;

  function renderAdminPw() {
    $("#admin-pw-value").textContent = pwRevealed ? adminPw : maskToken(adminPw);
    $("#btn-pw-reveal").textContent = pwRevealed ? t("btn.hide") : t("btn.show");
  }

  async function loadUsers() {
    const { res, data } = await api("/api/admin/users");
    if (!res.ok) return;
    const pw = await api("/api/admin/password");
    if (pw.res.ok) { adminPw = pw.data.password || ""; pwRevealed = false; renderAdminPw(); }
    $("#users-list").innerHTML = data.users
      .map((u) => `
        <div class="user-row" data-id="${esc(u.id)}">
          <div class="user-main">
            <span class="u-name">${esc(u.username)}</span>
            ${u.role === "admin" ? `<span class="badge admin">${t("role.admin")}</span>` : ""}
            <span class="u-sub">${esc(maskToken(u.token))}</span>
          </div>
          <div class="user-actions">
            <span class="badge ${u.enabled ? "ok" : "off"}">${u.enabled ? t("user.enabled") : t("user.disabled")}</span>
            ${u.role !== "admin" ? `<button class="btn-ghost btn-mini" data-enable="${u.enabled ? "0" : "1"}">${u.enabled ? t("btn.disable") : t("btn.enable")}</button>` : ""}
          </div>
        </div>`)
      .join("");
  }

  async function bindUsers() {
    $("#users-list").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-enable]");
      if (!btn) return;
      const row = btn.closest(".user-row");
      const enabled = btn.dataset.enable === "1";
      const { res, data } = await api(`/api/admin/users/${encodeURIComponent(row.dataset.id)}/enabled`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) { toast(enabled ? t("user.enableToast") : t("user.disableToast")); loadUsers(); }
      else toast(data?.error?.message || "…", true);
    });

    $("#btn-invite").addEventListener("click", async () => {
      $("#btn-invite").disabled = true;
      const { res, data } = await api("/api/admin/invite", { method: "POST" });
      $("#btn-invite").disabled = false;
      if (res.ok && data.code) {
        $("#invite-box").innerHTML = `<div class="note tip">${t("invite.new", { code: `<code class="mono">${esc(data.code)}</code>` })}</div>`;
        navigator.clipboard?.writeText(data.code).catch(() => {});
      } else {
        toast(data?.error?.message || t("invite.genFail"), true);
      }
    });

    $("#btn-pw-reveal").addEventListener("click", () => { pwRevealed = !pwRevealed; renderAdminPw(); });
    $("#btn-pw-copy").addEventListener("click", async () => {
      if (!adminPw) return;
      try { await navigator.clipboard.writeText(adminPw); toast(t("adminpw.copied")); }
      catch { toast(t("adminpw.copyFail"), true); }
    });
    $("#btn-pw-change").addEventListener("click", async () => {
      const v = $("#admin-pw-new").value;
      const msg = $("#pw-msg"); msg.hidden = true;
      if (v.length < 8) { msg.hidden = false; msg.textContent = t("adminpw.short"); return; }
      const { res, data } = await api("/api/admin/password", { method: "PUT", body: JSON.stringify({ password: v }) });
      if (res.ok) {
        adminPw = v; pwRevealed = true; renderAdminPw();
        $("#admin-pw-new").value = "";
        msg.hidden = false; msg.textContent = t("adminpw.changed");
        toast(t("adminpw.title") + " " + t("key.saved"));
      } else {
        msg.hidden = false; msg.textContent = data?.error?.message || t("adminpw.changeFail");
      }
    });
  }

  /* ============ devices (admin) ============ */
  let devicesPollTimer = null;

  function stopDevicesPoll() {
    if (devicesPollTimer) { clearInterval(devicesPollTimer); devicesPollTimer = null; }
  }

  // 网关 MCP 配置：Claude Code → https://<console>/mcp（Bearer 当前用户 token）
  function gwMcpSnippet() {
    const snippet = {
      mcpServers: {
        "vale-gate": {
          type: "http",
          url: location.origin + "/mcp",
          headers: { Authorization: `Bearer ${me?.token || ""}` },
        },
      },
    };
    return JSON.stringify(snippet, null, 2);
  }

  async function loadCfToken() {
    const { res, data } = await api("/api/admin/cloudflare-token");
    if (res.ok && data) {
      $("#cf-status").textContent = data.configured
        ? `${t("cf.configured")} ${data.masked || ""}` : t("cf.notConfigured");
      $("#cf-status").className = "badge " + (data.configured ? "ok" : "empty");
    }
  }

  async function loadDevices() {
    loadCfToken();
    // 刷新一次 /api/me，网关 MCP 配置用当前用户 token
    const m = await api("/api/me");
    if (m.res.ok) me = m.data;
    const gwEl = $("#gw-mcp-json");
    if (gwEl) gwEl.textContent = gwMcpSnippet();

    const { res, data } = await api("/api/devices");
    if (!res.ok) return;
    const devices = data.devices || [];
    if (!devices.length) {
      stopDevicesPoll();
      $("#devices-list").innerHTML = `<div class="note">${t("devices.empty")}</div>`;
      return;
    }
    $("#devices-list").innerHTML = devices.map((d) => `
      <div class="user-row" data-name="${esc(d.name)}">
        <div class="user-main">
          <span class="u-name">${esc(d.name)}</span>
          <span class="badge offline" data-status=""><span class="dot"></span></span>
          <span class="u-sub mono">${esc(d.hostname)}</span>
          <span class="badge">${esc(d.token)}</span>
        </div>
        <div class="user-actions">
          <button class="btn-ghost btn-mini" data-pair="${esc(d.name)}">${t("devices.pair")}</button>
          <a class="btn-ghost btn-mini" href="/api/devices/${encodeURIComponent(d.name)}/proxy/" target="_blank" rel="noopener">${t("devices.open")}</a>
          <button class="btn-ghost btn-mini" data-mcp="${esc(d.name)}">${t("devices.copyMcp")}</button>
          <button class="btn-danger btn-mini" data-del="${esc(d.name)}">${t("btn.clear")}</button>
        </div>
      </div>`).join("");
    // 在线状态：进面板立即查一次，之后每 30s 轮询（离开面板时 stopDevicesPoll 停掉）
    await loadDeviceStatus();
    stopDevicesPoll();
    devicesPollTimer = setInterval(loadDeviceStatus, 30000);
  }

  async function loadDeviceStatus() {
    if ($("#view-app").hidden || $("#panel-devices").hidden) return;
    const box = $("#devices-list");
    if (!box || !box.querySelector(".user-row")) return;
    const { res, data } = await api("/api/plugins/status");
    if (!res.ok || !data?.devices) return;
    for (const [name, st] of Object.entries(data.devices)) {
      const row = box.querySelector(`.user-row[data-name="${name}"]`);
      const badge = row?.querySelector("[data-status]");
      if (!badge) continue;
      const online = !!st.online;
      badge.className = "badge " + (online ? "online" : "offline");
      badge.innerHTML = `<span class="dot"></span>${online ? t("devices.online") : t("devices.offline")}`;
    }
  }

  function showPairModal(name, code) {
    $("#pair-device-name").textContent = t("devices.pairFor", { name });
    $("#pair-code").textContent = code;
    $("#pair-modal").hidden = false;
  }

  async function bindDevices() {
    const list = $("#devices-list");
    list.addEventListener("click", async (ev) => {
      const pairBtn = ev.target.closest("button[data-pair]");
      const mcpBtn = ev.target.closest("button[data-mcp]");
      const delBtn = ev.target.closest("button[data-del]");
      if (pairBtn) {
        const name = pairBtn.dataset.pair;
        const { res, data } = await api("/api/plugins/pair", { method: "POST", body: JSON.stringify({ device: name }) });
        if (res.ok && data.code) showPairModal(name, data.code);
        else toast(data?.error?.message || t("devices.pairFail"), true);
        return;
      }
      if (mcpBtn) {
        const name = mcpBtn.dataset.mcp;
        const { res, data } = await api(`/api/devices/${encodeURIComponent(name)}/mcp`);
        if (res.ok && data.mcp?.json) {
          try { await navigator.clipboard.writeText(data.mcp.json); toast(t("devices.mcpCopied")); }
          catch { toast(t("devices.mcpCopied") + " ⚠", true); }
        } else {
          toast(data?.error?.message || t("devices.saveFail"), true);
        }
        return;
      }
      if (delBtn) {
        const name = delBtn.dataset.del;
        if (!confirm(t("devices.deleteConfirm", { name }))) return;
        const { res, data } = await api(`/api/devices/${encodeURIComponent(name)}`, { method: "DELETE" });
        if (res.ok) { toast(t("devices.deleted") + " " + name); loadDevices(); }
        else toast(data?.error?.message || t("devices.saveFail"), true);
      }
    });

    $("#btn-gw-mcp").addEventListener("click", async () => {
      if (!me?.token) return;
      try { await navigator.clipboard.writeText(gwMcpSnippet()); toast(t("devices.mcpCopied")); }
      catch { toast(t("devices.mcpCopied") + " ⚠", true); }
    });

    $("#btn-pair-close").addEventListener("click", () => { $("#pair-modal").hidden = true; });
    $("#pair-modal").addEventListener("click", (ev) => { if (ev.target === $("#pair-modal")) $("#pair-modal").hidden = true; });
    $("#btn-pair-copy").addEventListener("click", async () => {
      const code = $("#pair-code").textContent;
      if (!code) return;
      try { await navigator.clipboard.writeText(code); toast(t("devices.pairCopied")); }
      catch { toast(t("token.copyFail"), true); }
    });

    $("#btn-dev-regkey").addEventListener("click", async () => {
      const btn = $("#btn-dev-regkey");
      btn.disabled = true;
      const { res, data } = await api("/api/devices/register-key", { method: "POST" });
      btn.disabled = false;
      if (res.ok && data.key) {
        const box = $("#regkey-box");
        box.innerHTML = `
          <div class="note tip">${t("devices.keyGenerated", { code: `<code class="mono">${esc(data.key)}</code>` })}</div>
          <div class="key-edit-row" style="margin-top:8px">
            <code class="mono" id="regkey-value">${esc(data.key)}</code>
            <button id="btn-regkey-copy" class="btn-ghost" data-i18n="btn.copy">复制</button>
          </div>
          <div class="muted" style="margin-top:8px">${t("devices.regKeyCmd")}</div>
          <div class="key-edit-row"><code class="mono">$env:VALE_REG_KEY = "${esc(data.key)}"; irm https://command.saisi.online/vale-command/vale-command-setup.ps1 | iex</code></div>`;
        $("#btn-regkey-copy").addEventListener("click", () => {
          navigator.clipboard?.writeText(data.key).then(() => toast(t("devices.keyCopied"))).catch(() => {});
        });
        navigator.clipboard?.writeText(data.key).catch(() => {});
        toast(t("devices.genKey"));
      } else {
        $("#regkey-box").innerHTML = `<div class="note err">${data?.error?.message || t("devices.genKeyFail")}</div>`;
      }
    });

    $("#btn-cf-save").addEventListener("click", async () => {
      const v = $("#cf-token-input").value.trim();
      const msg = $("#cf-msg");
      const { res, data } = await api("/api/admin/cloudflare-token", {
        method: "PUT", body: JSON.stringify({ token: v }),
      });
      if (res.ok) {
        msg.hidden = false; msg.className = "form-msg";
        msg.textContent = v ? t("cf.saved") : t("cf.empty");
        $("#cf-token-input").value = "";
        loadCfToken();
      } else {
        msg.hidden = false; msg.className = "form-msg";
        msg.textContent = data?.error?.message || t("devices.saveFail");
      }
    });

    $("#btn-dev-add").addEventListener("click", async () => {
      const name = $("#dev-name").value.trim();
      const hostname = $("#dev-host").value.trim();
      const token = $("#dev-token").value.trim();
      const msg = $("#dev-msg"); msg.hidden = true;
      const { res, data } = await api("/api/devices", {
        method: "POST",
        body: JSON.stringify({ name, hostname, token }),
      });
      if (res.ok) {
        $("#dev-name").value = ""; $("#dev-host").value = ""; $("#dev-token").value = "";
        toast(t("devices.saved"));
        loadDevices();
      } else {
        msg.hidden = false; msg.textContent = data?.error?.message || t("devices.saveFail");
      }
    });
  }

  /* ============ events ============ */
  function bindEvents() {
    // lang toggles
    $$("[data-lang-toggle]").forEach((wrap) => {
      wrap.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-lang-btn]")) setLang(lang === "zh" ? "en" : "zh");
      });
    });

    $$(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".auth-tab").forEach((el) => el.classList.toggle("active", el === tab));
        $("#form-login").hidden = tab.dataset.tab !== "login";
        $("#form-register").hidden = tab.dataset.tab !== "register";
      });
    });

    $("#form-login").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = $("#login-msg"); msg.hidden = true;
      const { res, data } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: $("#form-login [name=username]").value, password: $("#form-login [name=password]").value }),
      });
      if (res.ok) init();
      else { msg.hidden = false; msg.textContent = data?.error?.message || t("auth.loginFail"); }
    });

    $("#form-register").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = $("#register-msg"); msg.hidden = true;
      const f = $("#form-register");
      const { res, data } = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username: f.querySelector("[name=username]").value, password: f.querySelector("[name=password]").value, inviteCode: f.querySelector("[name=inviteCode]").value }),
      });
      if (res.ok) init();
      else { msg.hidden = false; msg.textContent = data?.error?.message || t("auth.registerFail"); }
    });

    $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchPanel(b.dataset.panel)));

    $("#btn-logout").addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      showAuth();
    });

    $("#btn-reveal").addEventListener("click", () => { tokenRevealed = !tokenRevealed; renderToken(); });
    $("#btn-copy").addEventListener("click", async () => {
      if (!me || !me.token) return;
      try { await navigator.clipboard.writeText(me.token); toast(t("token.copied")); }
      catch { toast(t("token.copyFail"), true); }
    });
    $("#btn-regenerate").addEventListener("click", async () => {
      const warn = me.role === "admin" ? t("token.regenerateConfirm") : t("token.regenerateConfirm").split("\n")[0];
      if (!confirm(warn)) return;
      const { res, data } = await api("/api/me/token/regenerate", { method: "POST" });
      if (res.ok && data.token) {
        me.token = data.token;
        tokenRevealed = true;
        renderToken();
        const note = $("#token-note");
        note.hidden = false;
        note.textContent = t("token.regenerated");
        toast(t("btn.regenerate"));
      } else {
        toast(data?.error?.message || t("token.regenerateFail"), true);
      }
    });

    bindKeyActions();
    bindUsers();
    bindDevices();
    $("#btn-route-auto")?.addEventListener("click", clearRoute);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    applyStaticText();
    renderLangToggles();
    bindEvents();
    init();
  });
})();
