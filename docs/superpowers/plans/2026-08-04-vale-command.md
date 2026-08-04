# Vale 命令：网关渠道一键切换 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供跨平台 `vale` 命令 + 网关公开端点（health/vale-cli/安装器）+ console 面板，实现网关渠道一键切换（探测验证、自动备份、可回滚）。

**Architecture:** vale CLI 作为静态资源放在 `gateway/public/vale`（单一事实源，esbuild 不碰它，Worker 通过 Assets 读取并动态生成安装器）；网关新增 4 个公开端点；console 模型路由面板加安装说明。CLI 零依赖 node 脚本，运行时从本机 `~/.claude/settings.json` 自读 token。

**Tech Stack:** Node.js（CLI，`fetch`/`fs` 内置）、Cloudflare Worker（端点）、vanilla JS（console 面板）、`node --test`（测试）。

## Global Constraints

- CLI 零依赖：只用 node 内置 API（`fs`/`os`/`path`/`fetch`），不 import 任何 npm 包
- CLI 源码单一事实源：`gateway/public/vale`，Worker 端点和安装器都从这里读取
- CLI 不显示/不存储 token；只读 settings.json 里的 token 用于探测
- 端点公开无鉴权，响应不含任何密钥
- 渠道映射常量：`ds→ds/deepseek-v4-flash`、`qw→qw/qwen3.8-max-preview`、`og→og/deepseek-v4-flash`、`or→or/openai/gpt-5.6-luna:floor[1m]`；优先级 `qw > ds > og > or`
- 测试用 `VALE_SETTINGS` 环境变量覆盖 settings.json 路径（CLI 支持）
- 每个 commit 树保持绿色（`npm test` 全过）

---

### Task 1: vale CLI 脚本（gateway/public/vale）+ 子进程测试

**Files:**
- Create: `gateway/public/vale`
- Test: `gateway/test/vale-cli.test.mjs`

**Interfaces:**
- Produces: `gateway/public/vale` —— 可执行 node CLI（shebang `#!/usr/bin/env node`），支持 `check` / `use <ds|qw|og|or>` / `use auto` / `restore`；读 `VALE_SETTINGS`（默认 `~/.claude/settings.json`）和其中的 `ANTHROPIC_BASE_URL`（默认 `https://api.saisi.online`）。
- Later tasks consume: Task 2 的 Worker 端点从该文件读内容；Task 4 部署后验证。

- [ ] **Step 1: 写失败测试**

创建 `gateway/test/vale-cli.test.mjs`：

```js
// vale CLI subprocess tests — spawn the real gateway/public/vale against a
// local mock gateway (node:http) and a temp settings.json. No network.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "public", "vale");

function makeGateway({ health, okModels = [], status = 200 } = {}) {
  const calls = { health: 0, messages: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      calls.health++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(health || {
        channels: [
          { id: "ds", ok: true, model: "ds/deepseek-v4-flash" },
          { id: "qw", ok: true, model: "qw/qwen3.8-max-preview" },
          { id: "og", ok: false, model: "og/deepseek-v4-flash", reason: "circuit open" },
          { id: "or", ok: true, model: "or/openai/gpt-5.6-luna:floor[1m]" },
        ],
        recommended: { channel: "qw", model: "qw/qwen3.8-max-preview" },
      }));
      return;
    }
    if (req.url === "/v1/messages") {
      calls.messages++;
      res.setHeader("content-type", "application/json");
      res.statusCode = status;
      res.end(JSON.stringify({ type: "message", id: "m1", role: "assistant", model: "x", content: [], stop_reason: "end_turn", usage: {} }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, calls });
    });
  });
}

function makeSettings(base, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vale-test-"));
  const file = path.join(dir, "settings.json");
  const data = {
    env: {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: "test-token",
      ANTHROPIC_MODEL: "ds/deepseek-v4-flash",
      ...extra,
    },
    permissions: { allow: ["Read"] },
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file, data };
}

function run(args, settingsFile) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, VALE_SETTINGS: settingsFile },
  });
}

test("check: 显示渠道状态和当前渠道", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings(`http://127.0.0.1:${port}`);
    const r = run(["check"], file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /qw/);
    assert.match(r.stdout, /当前.*ds/);
  } finally { server.close(); }
});

test("use qw: 探测通过 → 改写 env + 备份", async () => {
  const { server, port } = await makeGateway({ status: 200 });
  try {
    const { file, data } = makeSettings(`http://127.0.0.1:${port}`);
    const r = run(["use", "qw"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.saisi.online");
    assert.equal(after.permissions.allow[0], "Read"); // 非 env 配置保留
    // 备份文件存在
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 1);
    // 备份内容是切换前配置
    const bak = JSON.parse(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"));
    assert.equal(bak.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
  } finally { server.close(); }
});

test("use og: 探测失败(400) → 拒绝切换, 配置不变", async () => {
  const { server, port } = await makeGateway({ status: 400 });
  try {
    const { file, data } = makeSettings(`http://127.0.0.1:${port}`);
    const r = run(["use", "og"], file);
    assert.notEqual(r.status, 0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 0);
  } finally { server.close(); }
});

test("use auto: 按优先级 qw>ds>og>or 选第一个健康渠道", async () => {
  const { server, port } = await makeGateway({ status: 200 });
  try {
    const { file } = makeSettings(`http://127.0.0.1:${port}`);
    const r = run(["use", "auto"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
  } finally { server.close(); }
});

test("restore: 恢复最近备份", async () => {
  const { server, port } = await makeGateway({ status: 200 });
  try {
    const { file } = makeSettings(`http://127.0.0.1:${port}`);
    run(["use", "qw"], file); // 产生备份 + 切换
    const r = run(["restore"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash"); // 回到切换前
  } finally { server.close(); }
});

test("未知渠道 → 报错退出", async () => {
  const { file } = makeSettings("http://127.0.0.1:1");
  const r = run(["use", "bogus"], file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知渠道|unknown/i);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ~/vale/gateway && node --test test/vale-cli.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory ... public/vale`

- [ ] **Step 3: 实现 `gateway/public/vale`**

创建 `gateway/public/vale`（完整代码）：

```js
#!/usr/bin/env node
// vale — switch ~/.claude/settings.json between vale-gate channels.
// Zero-dependency Node.js (fs/os/path/fetch only). Install from the gateway
// console: `curl -fsSL https://api.saisi.online/api/vale-install | sh`
// (POSIX) or `irm https://api.saisi.online/api/vale-install.ps1 | iex` (Win).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const GATEWAY_BASE = "https://api.saisi.online";
const CHANNELS = {
  ds: { model: "ds/deepseek-v4-flash" },
  qw: { model: "qw/qwen3.8-max-preview" },
  og: { model: "og/deepseek-v4-flash" },
  or: { model: "or/openai/gpt-5.6-luna:floor[1m]" },
};
const PRIORITY = ["qw", "ds", "og", "or"];
const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
const KEEP_BACKUPS = 5;
const PROBE_TIMEOUT_MS = 20000;

function settingsFile() {
  return process.env.VALE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch (e) {
    console.error(`无法读取 ${settingsFile()}: ${e.message}`);
    process.exit(1);
  }
}
function writeAtomic(data) {
  const file = settingsFile();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
function gatewayBase(settings) {
  return (settings.env && settings.env.ANTHROPIC_BASE_URL) || GATEWAY_BASE;
}
function authToken(settings) {
  const env = settings.env || {};
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
}
function currentChannel(settings) {
  const model = (settings.env && settings.env.ANTHROPIC_MODEL) || "";
  for (const [id, ch] of Object.entries(CHANNELS)) {
    if (model === ch.model) return id;
  }
  for (const id of Object.keys(CHANNELS)) {
    if (model.startsWith(id + "/")) return id;
  }
  return null;
}
function backup() {
  const file = settingsFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.bak-vale-${stamp}`;
  fs.copyFileSync(file, bak);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const olds = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-vale-`))
    .sort()
    .reverse();
  for (const f of olds.slice(KEEP_BACKUPS)) fs.unlinkSync(path.join(dir, f));
  return bak;
}
function findBackup() {
  const file = settingsFile();
  const dir = path.dirname(file);
  const base = path.basename(file);
  const list = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-vale-`))
    .sort()
    .reverse();
  return list.length ? path.join(dir, list[0]) : null;
}
function switchEnv(settings, channel) {
  const env = settings.env || {};
  for (const k of MODEL_ENV_KEYS) env[k] = CHANNELS[channel].model;
  env.ANTHROPIC_BASE_URL = GATEWAY_BASE;
  settings.env = env;
  return settings;
}
async function fetchHealth(base) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function probe(base, token, model) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": token,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: ctrl.signal,
    });
    return r.status === 200;
  } catch { return false; } finally { clearTimeout(t); }
}
function pickRecommended(channels) {
  for (const id of PRIORITY) {
    const c = (channels || []).find((x) => x.id === id);
    if (c && c.ok) return c;
  }
  return null;
}

async function cmdCheck() {
  const settings = readSettings();
  const base = gatewayBase(settings);
  const cur = currentChannel(settings);
  const health = await fetchHealth(base);
  console.log(`网关: ${base}`);
  if (!health || !Array.isArray(health.channels)) {
    console.error("无法获取渠道健康（/api/health 不可达）");
    process.exit(1);
  }
  for (const c of health.channels) {
    const marker = c.ok ? "✅ 正常" : `⚠️  ${c.reason || "异常"}`;
    const curMark = c.id === cur ? "  ← 当前" : "";
    console.log(`  ${c.id}/ → ${c.model}  ${marker}${curMark}`);
  }
  const rec = pickRecommended(health.channels);
  console.log(rec ? `推荐: ${rec.model}` : "推荐: 无可用渠道");
  if (cur) console.log(`当前配置: ${cur}（${(settings.env || {}).ANTHROPIC_MODEL}）`);
}

async function cmdUse(channel) {
  if (!CHANNELS[channel]) {
    console.error(`未知渠道: ${channel}（可用: ${Object.keys(CHANNELS).join(" / ")}）`);
    process.exit(1);
  }
  const settings = readSettings();
  const base = gatewayBase(settings);
  const token = authToken(settings);
  if (!token) {
    console.error("settings.json 里没有 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN");
    process.exit(1);
  }
  const model = CHANNELS[channel].model;
  const ok = await probe(base, token, model);
  if (!ok) {
    console.error(`探测失败: ${base} 上的 ${model} 不可用，未切换`);
    process.exit(1);
  }
  const bak = backup();
  switchEnv(settings, channel);
  writeAtomic(settings);
  console.log(`已切换到 ${model}`);
  console.log(`备份: ${bak}`);
  console.log("重启 Claude Code 后生效");
}

async function cmdAuto() {
  const settings = readSettings();
  const base = gatewayBase(settings);
  const health = await fetchHealth(base);
  const rec = health && Array.isArray(health.channels) ? pickRecommended(health.channels) : null;
  if (!rec) {
    console.error("无健康渠道（/api/health 不可达或全部异常）");
    process.exit(1);
  }
  const token = authToken(settings);
  if (token && !(await probe(base, token, rec.model))) {
    console.error(`推荐渠道 ${rec.model} 探测失败，未切换`);
    process.exit(1);
  }
  const bak = backup();
  switchEnv(settings, rec.id);
  writeAtomic(settings);
  console.log(`已自动切换到 ${rec.model}（${rec.id}）`);
  console.log(`备份: ${bak}`);
  console.log("重启 Claude Code 后生效");
}

function cmdRestore() {
  const bak = findBackup();
  if (!bak) {
    console.error("没有可恢复的备份");
    process.exit(1);
  }
  fs.copyFileSync(bak, settingsFile());
  console.log(`已恢复 ${bak}`);
  console.log("重启 Claude Code 后生效");
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "check";
  if (cmd === "check") return cmdCheck();
  if (cmd === "use") return args[1] === "auto" ? cmdAuto() : cmdUse(args[1]);
  if (cmd === "restore") return cmdRestore();
  console.error(`用法: vale check | vale use <ds|qw|og|or|auto> | vale restore`);
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ~/vale/gateway && node --test test/vale-cli.test.mjs`
Expected: PASS（6 个用例）

- [ ] **Step 5: 完整测试 + commit**

Run: `cd ~/vale/gateway && npm test` — 全绿
```bash
cd ~/vale && git add gateway/public/vale gateway/test/vale-cli.test.mjs
git commit -m "feat(stage-gateway): vale CLI — gateway channel switching with probe, backup, rollback"
```

---

### Task 2: 网关公开端点（health / vale-cli / 安装器）

**Files:**
- Modify: `gateway/src/index.js`
- Test: `gateway/test/health.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `gateway/public/vale`（通过 `env.ASSETS.fetch("/vale")` 读取）；已有 `isChannelDegraded(env)`（`index.js`，DO breaker）。
- Produces: 公开端点 `GET /api/health`（所有域名可用，含 console 与 API 域名）、`GET /api/vale-cli`（text/plain）、`GET /api/vale-install`（POSIX sh）、`GET /api/vale-install.ps1`（PowerShell）；导出 `buildHealth(env)` 供测试。

- [ ] **Step 1: 写失败测试**

创建 `gateway/test/health.test.mjs`：

```js
// /api/health channel-status logic — pure function test with a mocked breaker.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHealth } from "../src/index.js";

// Mock env: breaker reports "open" (degraded) when asked.
const openEnv = {
  BREAKER: {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("1") }),
  },
};
const closedEnv = {
  BREAKER: {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("0") }),
  },
};

test("health: og degraded when breaker open, recommended picks qw", async () => {
  const h = await buildHealth(openEnv);
  const og = h.channels.find((c) => c.id === "og");
  assert.equal(og.ok, false);
  assert.equal(og.reason, "circuit open");
  assert.deepEqual(h.recommended, { channel: "qw", model: "qw/qwen3.8-max-preview" });
});

test("health: breaker closed → all channels ok, recommended still qw", async () => {
  const h = await buildHealth(closedEnv);
  assert.ok(h.channels.every((c) => c.ok));
  assert.equal(h.recommended.channel, "qw");
});

test("health: channels cover all four prefixes in priority order", async () => {
  const h = await buildHealth(closedEnv);
  assert.deepEqual(h.channels.map((c) => c.id), ["ds", "qw", "og", "or"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs`
Expected: FAIL — `buildHealth is not exported`

- [ ] **Step 3: 实现端点**

在 `gateway/src/index.js` 添加（位置：`MODELS`/`ROUTE_INFO` 常量附近加健康常量；主 fetch 的 hostname 分流之前加路由；文件底部加函数）：

```js
// ---- Channel health (public /api/health) ----
const HEALTH_CHANNELS = [
  { id: "ds", model: "ds/deepseek-v4-flash" },
  { id: "qw", model: "qw/qwen3.8-max-preview" },
  { id: "og", model: "og/deepseek-v4-flash" },
  { id: "or", model: "or/openai/gpt-5.6-luna:floor[1m]" },
];
const HEALTH_PRIORITY = ["qw", "ds", "og", "or"];

export async function buildHealth(env) {
  const channels = [];
  for (const c of HEALTH_CHANNELS) {
    let ok = true;
    let reason = "";
    if (c.id === "og") {
      ok = !(await isChannelDegraded(env));
      if (!ok) reason = "circuit open";
    }
    channels.push({ id: c.id, ok, model: c.model, ...(reason ? { reason } : {}) });
  }
  const recommended = HEALTH_PRIORITY.map((id) => channels.find((c) => c.id === id)).find((c) => c.ok);
  return {
    channels,
    recommended: recommended ? { channel: recommended.id, model: recommended.model } : null,
  };
}

// POSIX one-liner installer — embeds the vale CLI as base64 (no quoting issues).
function posixInstaller(b64) {
  return `#!/bin/sh
set -e
command -v node >/dev/null 2>&1 || { echo "error: Node.js required"; exit 1; }
DEST="\${VALE_BIN:-\$HOME/.local/bin}"
mkdir -p "\$DEST"
echo "${b64}" | base64 -d > "\$DEST/vale"
chmod +x "\$DEST/vale"
echo "installed: \$DEST/vale"
echo "usage: vale check | vale use <ds|qw|og|or> | vale use auto | vale restore"
`;
}

// PowerShell one-liner installer (irm | iex) — installs vale + vale.cmd wrapper.
function psInstaller(b64) {
  return `$ErrorActionPreference = "Stop"
try { node --version | Out-Null } catch { Write-Error "Node.js required"; exit 1 }
$dest = Join-Path $HOME ".local\\bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${b64}"))
Set-Content -Path (Join-Path $dest "vale") -Value $script -Encoding UTF8 -NoNewline
Set-Content -Path (Join-Path $dest "vale.cmd") -Value '@echo off\r\nnode "%~dp0vale" %*' -Encoding ASCII
Write-Host "installed: $dest\\vale  (command: vale)"
`;
}

async function serveAssetText(env, assetPath) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return null;
  }
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${assetPath}`));
  return res.ok ? await res.text() : null;
}
```

主 fetch（`index.js` 中 `const path = url.pathname;` 之后、console hostname 分流之前）添加：

```js
      // ---- Public tooling endpoints (any host) ----
      if (path === "/api/health") {
        return jsonOk(await buildHealth(env));
      }
      if (path === "/api/vale-cli" || path === "/api/vale-install" || path === "/api/vale-install.ps1") {
        const cli = await serveAssetText(env, "/vale");
        if (cli === null) return jsonError(404, "vale CLI not found", "not_found_error");
        if (path === "/api/vale-cli") {
          return new Response(cli, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS } });
        }
        const b64 = btoa(cli);
        const body = path === "/api/vale-install" ? posixInstaller(b64) : psInstaller(b64);
        return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS } });
      }
```

注意：`btoa` 在 Workers 运行时内置可用。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ~/vale/gateway && node --test test/health.test.mjs`
Expected: PASS（3 个用例）

- [ ] **Step 5: 完整测试 + commit**

Run: `cd ~/vale/gateway && npm test` — 全绿
```bash
cd ~/vale && git add gateway/src/index.js gateway/test/health.test.mjs
git commit -m "feat(stage-gateway): public endpoints — /api/health, /api/vale-cli, one-line installers"
```

---

### Task 3: console 模型路由面板 — Vale 命令安装区

**Files:**
- Modify: `gateway/public/index.html`（panel-routes section）
- Modify: `gateway/public/app.js`（渲染安装命令 + i18n）

**Interfaces:**
- Consumes: `loadRoutes()` 返回的 `{ routes, apiHost }`（已有，`app.js:239` 附近）；Task 2 的端点路径。
- Produces: 模型路由面板显示两个平台的安装命令与用法。

- [ ] **Step 1: 修改 `public/index.html`**

在 panel-routes 的 switchboard 之后（`<div class="switchboard" id="routes-switchboard"></div>` 后面）添加：

```html
          <div class="card">
            <div class="card-head"><h2 data-i18n="routes.valeTitle">Vale 命令</h2></div>
            <div class="card-body" id="vale-install-box"></div>
          </div>
```

- [ ] **Step 2: 修改 `public/app.js`**

a) i18n 表加 key（zh 区块 `routes.lede` 后面，en 区块对应位置）：
```js
      "routes.valeTitle": "Vale 命令",
      "routes.valeDesc": "跨平台一键切换网关渠道（探测验证 + 自动备份 + 可回滚）。",
```
```js
      "routes.valeTitle": "Vale CLI",
      "routes.valeDesc": "Cross-platform one-command channel switching (probe + backup + rollback).",
```

b) 渲染函数（放在 `switchboardHTML` 函数后面）：
```js
  function valeInstallHTML(apiHost) {
    const base = apiHost || "https://api.saisi.online";
    const posix = `curl -fsSL ${base}/api/vale-install | sh`;
    const win = `irm ${base}/api/vale-install.ps1 | iex`;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<p class="muted">${t("routes.valeDesc")}</p>
      <p><strong>Linux / macOS</strong></p>
      <pre><code>${esc(posix)}</code></pre>
      <p><strong>Windows (PowerShell)</strong></p>
      <pre><code>${esc(win)}</code></pre>
      <p class="muted">vale check · vale use &lt;ds|qw|og|or|auto&gt; · vale restore</p>`;
  }
```

c) `loadRoutesPanel`（`app.js:276` 附近 `if (name === "routes") loadRoutesPanel();`）—— 找到 `loadRoutesPanel` 函数定义，在其渲染 switchboard 之后追加：

```js
    const box = document.getElementById("vale-install-box");
    if (box) box.innerHTML = valeInstallHTML(apiHost);
```

（`loadRoutesPanel` 内部已有 `apiHost` 变量 —— 从 `loadRoutes()` 的返回值拿；若该函数尚未解构 `apiHost`，在调用处补上。）

- [ ] **Step 3: 验证前端无语法错误**

Run: `cd ~/vale/gateway && node --check public/app.js`
Expected: 无输出（OK）

- [ ] **Step 4: commit**

```bash
cd ~/vale && git add gateway/public/index.html gateway/public/app.js
git commit -m "feat(stage-gateway): console routing panel — Vale CLI install box"
```

---

### Task 4: 部署 + 端到端验证

**Files:** 无代码改动（部署与验证）。

- [ ] **Step 1: 部署**

Run: `cd ~/vale && ./scripts/build.sh gateway`
Expected: `Uploaded vale-gate` + `Current Version ID: ...`

- [ ] **Step 2: 验证公开端点**

```bash
# health
curl -s https://api.saisi.online/api/health
# 期望: channels 数组 (ds/qw/og/or) + recommended (qw)，og 的 ok=false reason="circuit open"
# vale-cli
curl -s https://api.saisi.online/api/vale-cli | head -3
# 期望: #!/usr/bin/env node ...
# install 脚本
curl -s https://api.saisi.online/api/vale-install | head -5
curl -s https://api.saisi.online/api/vale-install.ps1 | head -5
```

- [ ] **Step 3: 本机安装并实测 vale 命令**

```bash
curl -fsSL https://api.saisi.online/api/vale-install | sh
vale check        # 期望: 渠道状态表 + 当前渠道 ds
vale use qw       # 期望: 探测通过 → 已切换到 qw/qwen3.8-max-preview + 备份
vale check        # 期望: 当前配置 qw
vale restore      # 期望: 恢复备份（ds）
vale check        # 期望: 当前配置 ds
```

- [ ] **Step 4: 验证 console 面板**

浏览器打开 console 域名 → 模型路由面板 → 确认 "Vale 命令" 卡片显示安装命令（Linux/Windows 两行）。若无法浏览器访问，用 `curl <console-host>/ | grep vale-install` 确认 HTML 含安装区，并确认 `/api/admin/public` 正常。

- [ ] **Step 5: 回归 + commit（如验证中修了代码）**

`cd ~/vale/gateway && npm test` 全绿；如有代码修复则 commit；最终确认 `git status` 干净。

## Self-Review 备注

- Spec 覆盖：health 端点 ✅(Task2)、vale-cli ✅(Task2)、双安装器 ✅(Task2)、console 面板 ✅(Task3)、vale 命令 4 个子命令 ✅(Task1)、探测/备份/原子写/保留 5 份 ✅(Task1)、优先级 ✅(Task1/2)、E2E ✅(Task4)。
- 类型一致性：`buildHealth(env)` 签名 Task2 定义并测试；CLI 子命令与 Task1 测试一致；`isChannelDegraded(env)` 复用既有 DO breaker。
- 无占位符：所有代码块完整。
