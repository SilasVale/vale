// vale CLI subprocess tests — spawn the real gateway/public/vale against a
// local mock gateway (node:http) and a temp settings.json. No network.
//
// The CLI talks to the gateway via VALE_GATEWAY (default https://api.saisi.online):
//   - GET  /api/health       → channel status (public)
//   - POST /api/vale-probe   → probe a channel (public, worker-side keys)
//   - GET  /v1/models        → token validation for `use` (x-api-key)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "public", "vale");

const DEFAULT_MODELS = [
  { id: "ds/deepseek-v4-flash", object: "model", owned_by: "deepseek" },
  { id: "qw/qwen3.8-max-preview", object: "model", owned_by: "qwen" },
  { id: "og/deepseek-v4-flash", object: "model", owned_by: "opencode" },
  { id: "og/minimax-m3", object: "model", owned_by: "opencode" },
  { id: "og/mimo-v2.5", object: "model", owned_by: "opencode" },
  { id: "og/ox-alpha-free", object: "model", owned_by: "opencode" },
  { id: "or/openai/gpt-5.6-luna:floor[1m]", object: "model", owned_by: "openrouter" },
];

function makeGateway({ health, probeOk = true, probeStatus = 200, tokenOk = true, probeFailModels = [], models = DEFAULT_MODELS, messagesOk = true, authMode = "both" } = {}) {
  const calls = { health: 0, probes: 0, models: 0, messages: 0 };
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
    if (req.url === "/api/vale-probe" && req.method === "POST") {
      calls.probes++;
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        let model = "";
        try { model = JSON.parse(body || "{}").model || ""; } catch {}
        const failed = probeFailModels.includes(model);
        const ok = probeOk && !failed;
        res.setHeader("content-type", "application/json");
        res.statusCode = ok ? 200 : probeStatus;
        res.end(JSON.stringify({
          ok, channel: model.split("/")[0] || "x",
          status: ok ? 200 : probeStatus,
          detail: ok ? "" : "upstream down",
        }));
      });
      return;
    }
    if (req.url === "/v1/messages" && req.method === "POST") {
      calls.messages++;
      // authMode: which auth header the mock provider accepts — "api-key"
      // (x-api-key only), "bearer" (Authorization only), or "both".
      const hasApiKey = !!req.headers["x-api-key"];
      const hasBearer = !!req.headers["authorization"];
      const authOk = authMode === "both"
        || (authMode === "api-key" && hasApiKey)
        || (authMode === "bearer" && hasBearer);
      res.setHeader("content-type", "application/json");
      res.statusCode = messagesOk && authOk ? 200 : 400;
      res.end(JSON.stringify({ type: "message", id: "m1", role: "assistant", model: "x", content: [], stop_reason: "end_turn", usage: {} }));
      return;
    }
    if (req.url === "/v1/models" && req.method === "GET") {
      calls.models++;
      res.setHeader("content-type", "application/json");
      res.statusCode = tokenOk ? 200 : 401;
      res.end(tokenOk
        ? JSON.stringify({ object: "list", data: models })
        : JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Missing or invalid x-api-key" } }));
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

function makeSettings(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vale-test-"));
  const file = path.join(dir, "settings.json");
  const data = {
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", // direct config (the CLI does not read it)
      ANTHROPIC_API_KEY: "test-token",
      ANTHROPIC_MODEL: "ds/deepseek-v4-flash",
      ...extra,
    },
    permissions: { allow: ["Read"] },
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file, data };
}

function run(args, settingsFile, gatewayUrl, providersFile) {
  // NOTE: async spawn, NOT spawnSync — spawnSync blocks the parent's event
  // loop, so the in-process mock gateway could never respond to the CLI's
  // requests (deadlock). Async spawn lets the mock serve the child.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        VALE_SETTINGS: settingsFile,
        VALE_GATEWAY: gatewayUrl,
        ...(providersFile ? { VALE_PROVIDERS: providersFile } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => resolve({ status: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

const gw = (port) => `http://127.0.0.1:${port}`;

test("check: 显示渠道状态和当前渠道", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["check"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /qw/);
    assert.match(r.stdout, /当前.*ds/);
  } finally { server.close(); }
});

test("use qw: 探测通过 + token 有效 → 改写 env + 备份", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    fs.chmodSync(file, 0o600); // settings contain an API key, so tighten permissions to 0600
    const r = await run(["use", "qw"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.saisi.online");
    assert.equal(after.permissions.allow[0], "Read"); // non-env config preserved
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); // permission bits unchanged after the rewrite
    // the backup file exists
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 1);
    // the backup content is the pre-switch config
    const bak = JSON.parse(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8"));
    assert.equal(bak.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
  } finally { server.close(); }
});

test("use og: 探测失败(400) → 拒绝切换, 配置不变", async () => {
  const { server, port } = await makeGateway({ probeOk: false, probeStatus: 400 });
  try {
    const { file } = makeSettings();
    const r = await run(["use", "og"], file, gw(port));
    assert.notEqual(r.status, 0);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 0);
  } finally { server.close(); }
});

test("use qw: token 对网关无效(401) → 拒绝切换并提示", async () => {
  const { server, port } = await makeGateway({ tokenOk: false });
  try {
    const { file } = makeSettings();
    const r = await run(["use", "qw"], file, gw(port));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /token|密钥/);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 0);
  } finally { server.close(); }
});

test("use auto: 按优先级 qw>ds>og>or 选第一个健康渠道", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["use", "auto"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
  } finally { server.close(); }
});

test("restore: 恢复最近备份（原子写；恢复前先备份当前状态）", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    await run(["use", "qw"], file, gw(port)); // creates a backup + switches
    const r = await run(["restore"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash"); // back to the pre-switch state
    // use and restore each create one backup → 2 backups; the newest is the pre-restore (qw) state
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 2);
    const newest = backups.sort().reverse()[0];
    const bak = JSON.parse(fs.readFileSync(path.join(path.dirname(file), newest), "utf8"));
    assert.equal(bak.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
  } finally { server.close(); }
});

test("备份保留: 6 次 use 后只保留最近 5 个 .bak-vale-*", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    for (let i = 0; i < 6; i++) {
      const r = await run(["use", "qw"], file, gw(port));
      assert.equal(r.status, 0, r.stderr);
      // settings stay valid after each switch (later use depends on being able to read the token)
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
    }
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 5);
  } finally { server.close(); }
});

test("use auto: 推荐渠道 qw 探测失败 → 回退到下一个健康渠道 ds", async () => {
  const { server, port } = await makeGateway({ probeFailModels: ["qw/qwen3.8-max-preview"] });
  try {
    // starts as or: if the fallback doesn't take, the config stays on or (and the command exits non-zero)
    const { file } = makeSettings({ ANTHROPIC_MODEL: "or/openai/gpt-5.6-luna:floor[1m]" });
    const r = await run(["use", "auto"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
  } finally { server.close(); }
});

test("use auto: 所有渠道探测失败 → 无可用渠道, 配置不变", async () => {
  const { server, port } = await makeGateway({ probeOk: false, probeStatus: 400 });
  try {
    const { file } = makeSettings();
    const r = await run(["use", "auto"], file, gw(port));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /无可用渠道/);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 0);
  } finally { server.close(); }
});

test("未知渠道/模型 → 报错退出", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["use", "bogus"], file, gw(port));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未知渠道|未知模型|unknown/i);
  } finally { server.close(); }
});

test("models: 列出全部模型（含 og/minimax-m3）", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["models"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /og\/minimax-m3/);
    assert.match(r.stdout, /og\/mimo-v2.5/);
    assert.match(r.stdout, /og\/ox-alpha-free/);
    assert.match(r.stdout, /qw\/qwen3.8-max-preview/);
    assert.match(r.stdout, /ds\/deepseek-v4-flash/);
  } finally { server.close(); }
});

test("use og/minimax-m3: 白名单内的完整模型名 → 切换", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["use", "og/minimax-m3"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "og/minimax-m3");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "og/minimax-m3");
    assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.saisi.online");
  } finally { server.close(); }
});

test("use og/mimo-v2.5: 白名单内的完整模型名 → 切换", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["use", "og/mimo-v2.5"], file, gw(port));
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "og/mimo-v2.5");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "og/mimo-v2.5");
    assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.saisi.online");
  } finally { server.close(); }
});

test("use xx/nope: 不在模型列表 → 拒绝切换", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings();
    const r = await run(["use", "xx/nope"], file, gw(port));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未知渠道|未知模型|不支持/);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash");
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 0);
  } finally { server.close(); }
});

// ── Provider store ─────────────────────────────────────────────

const provFile = (n) => path.join(os.tmpdir(), `vale-prov-${n}-${process.pid}.json`);

test("provider add: 写入仓库（0600）", async () => {
  const file = provFile("add");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    const r = await run(["provider", "add", "deepseek-direct", "--base", "https://api.deepseek.com/anthropic", "--token", "sk-test123456", "--model", "deepseek-v4-flash"], sf, gw(1), file);
    assert.equal(r.status, 0, r.stderr);
    const prov = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(prov["deepseek-direct"], { base: "https://api.deepseek.com/anthropic", token: "sk-test123456", model: "deepseek-v4-flash" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(file, { force: true }); }
});

test("provider list: token 打码", async () => {
  const file = provFile("list");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    await run(["provider", "add", "p1", "--base", "https://x.example", "--token", "sk-abcdef123456", "--model", "m1"], sf, gw(1), file);
    const r = await run(["provider", "list"], sf, gw(1), file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /p1/);
    assert.ok(!r.stdout.includes("sk-abcdef123456"), "token 必须打码");
    assert.match(r.stdout, /\*\*\*/);
  } finally { fs.rmSync(file, { force: true }); }
});

test("provider rm: 删除提供商", async () => {
  const file = provFile("rm");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    await run(["provider", "add", "p1", "--base", "https://x.example", "--token", "sk-t", "--model", "m1"], sf, gw(1), file);
    const r = await run(["provider", "rm", "p1"], sf, gw(1), file);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  } finally { fs.rmSync(file, { force: true }); }
});

test("use <provider>: 探测通过 → 整套 env（base/token/model）替换 + 备份", async () => {
  const { server, port } = await makeGateway({ authMode: "both" });
  const file = provFile("use");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    await run(["provider", "add", "direct", "--base", gw(port), "--token", "sk-provider-token", "--model", "custom-model"], sf, gw(port), file);
    const r = await run(["use", "direct"], sf, gw(port), file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(sf, "utf8"));
    assert.equal(after.env.ANTHROPIC_BASE_URL, gw(port));
    assert.equal(after.env.ANTHROPIC_MODEL, "custom-model");
    // authMode both → probe tries Bearer first and succeeds → only write AUTH_TOKEN, clear API_KEY
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, "sk-provider-token");
    assert.equal(after.env.ANTHROPIC_API_KEY, undefined);
    const backups = fs.readdirSync(path.dirname(sf)).filter((f) => f.includes(".bak-vale-"));
    assert.equal(backups.length, 1);
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("provider add: 自动探测鉴权（bearer-only 端点 → auth=bearer）", async () => {
  const { server, port } = await makeGateway({ authMode: "bearer" });
  const file = provFile("detect-bearer");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    const r = await run(["provider", "add", "b", "--base", gw(port), "--token", "sk-t", "--model", "m"], sf, gw(port), file);
    assert.equal(r.status, 0, r.stderr);
    const prov = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(prov.b.auth, "bearer");
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("provider add: 自动探测鉴权（api-key-only 端点 → auth=api-key）", async () => {
  const { server, port } = await makeGateway({ authMode: "api-key" });
  const file = provFile("detect-apikey");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    const r = await run(["provider", "add", "a", "--base", gw(port), "--token", "sk-t", "--model", "m"], sf, gw(port), file);
    assert.equal(r.status, 0, r.stderr);
    const prov = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(prov.a.auth, "api-key");
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("use <api-key 型 provider>: 只写 ANTHROPIC_API_KEY，清除 AUTH_TOKEN", async () => {
  const { server, port } = await makeGateway({ authMode: "api-key" });
  const file = provFile("usekey");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    // preset a leftover AUTH_TOKEN to verify it gets cleared on switch
    await run(["provider", "add", "gw", "--base", gw(port), "--token", "sk-gw-token", "--model", "m"], sf, gw(port), file);
    const r = await run(["use", "gw"], sf, gw(port), file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(sf, "utf8"));
    assert.equal(after.env.ANTHROPIC_API_KEY, "sk-gw-token");
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("use <provider>: 探测失败(400) → 拒绝切换", async () => {
  const { server, port } = await makeGateway({ messagesOk: false });
  const file = provFile("usefail");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    await run(["provider", "add", "bad", "--base", gw(port), "--token", "sk-t", "--model", "m"], sf, gw(port), file);
    const r = await run(["use", "bad"], sf, gw(port), file);
    assert.notEqual(r.status, 0);
    const after = JSON.parse(fs.readFileSync(sf, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash"); // not switched
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("provider 名优先于渠道名", async () => {
  const { server, port } = await makeGateway();
  const file = provFile("prio");
  try {
    fs.rmSync(file, { force: true });
    const { file: sf } = makeSettings();
    await run(["provider", "add", "qw", "--base", gw(port), "--token", "sk-p", "--model", "p-model"], sf, gw(port), file);
    const r = await run(["use", "qw"], sf, gw(port), file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(sf, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "p-model"); // the provider takes effect rather than the qw channel's default model
  } finally { fs.rmSync(file, { force: true }); server.close(); }
});

test("check: /api/health 接受连接但不响应 → 超时后非0退出（不挂起）", async () => {
  // The server accepts TCP connections but never responds to /api/health; fetchHealth should
  // abort after PROBE_TIMEOUT_MS and return null, so vale check exits non-zero immediately.
  const server = http.createServer(() => {}); // no res written → the connection hangs forever
  server.on("connection", (s) => s.on("error", () => {})); // swallow socket errors after the client aborts
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { file } = makeSettings();
    const r = await run(["check"], file, gw(server.address().port));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /无法获取渠道健康/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
