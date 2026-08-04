// vale CLI subprocess tests — spawn the real gateway/public/vale against a
// local mock gateway (node:http) and a temp settings.json. No network.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
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
  // NOTE: async spawn, NOT spawnSync — spawnSync blocks the parent's event
  // loop, so the in-process mock gateway could never respond to the CLI's
  // requests (deadlock). Async spawn lets the mock serve the child.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, VALE_SETTINGS: settingsFile },
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

test("check: 显示渠道状态和当前渠道", async () => {
  const { server, port } = await makeGateway();
  try {
    const { file } = makeSettings(`http://127.0.0.1:${port}`);
    const r = await run(["check"], file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /qw/);
    assert.match(r.stdout, /当前.*ds/);
  } finally { server.close(); }
});

test("use qw: 探测通过 → 改写 env + 备份", async () => {
  const { server, port } = await makeGateway({ status: 200 });
  try {
    const { file, data } = makeSettings(`http://127.0.0.1:${port}`);
    fs.chmodSync(file, 0o600); // settings 含 API key，权限收紧为 0600
    const r = await run(["use", "qw"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "qw/qwen3.8-max-preview");
    assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.saisi.online");
    assert.equal(after.permissions.allow[0], "Read"); // 非 env 配置保留
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); // 重写后权限位不变
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
    const r = await run(["use", "og"], file);
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
    const r = await run(["use", "auto"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "qw/qwen3.8-max-preview");
  } finally { server.close(); }
});

test("restore: 恢复最近备份", async () => {
  const { server, port } = await makeGateway({ status: 200 });
  try {
    const { file } = makeSettings(`http://127.0.0.1:${port}`);
    await run(["use", "qw"], file); // 产生备份 + 切换
    const r = await run(["restore"], file);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_MODEL, "ds/deepseek-v4-flash"); // 回到切换前
  } finally { server.close(); }
});

test("未知渠道 → 报错退出", async () => {
  const { file } = makeSettings("http://127.0.0.1:1");
  const r = await run(["use", "bogus"], file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /未知渠道|unknown/i);
});

test("check: /api/health 接受连接但不响应 → 超时后非0退出（不挂起）", async () => {
  // 服务器接受 TCP 连接但对 /api/health 永不响应；fetchHealth 应在
  // PROBE_TIMEOUT_MS 后 abort 并返回 null，vale check 立即非0退出。
  const server = http.createServer(() => {}); // 不写 res → 连接一直挂着
  server.on("connection", (s) => s.on("error", () => {})); // 客户端 abort 后吞掉 socket error
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { file } = makeSettings(`http://127.0.0.1:${server.address().port}`);
    const r = await run(["check"], file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /无法获取渠道健康/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
