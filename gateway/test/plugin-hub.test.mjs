// PluginHubDO tests — the per-device WebSocket hub for the browser extension.
//
// The DO uses WebSocket Hibernation semantics (acceptWebSocket + storage
// alarms). Mock the state object with getWebSockets/acceptWebSocket/storage
// so no real Cloudflare runtime is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { PluginHubDO } from "../src/plugin-hub.js";

function makeState(initialSockets = []) {
  const sockets = [...initialSockets];
  const storage = { kv: new Map(), alarm: null };
  return {
    id: { name: "d1" },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
    storage: {
      get: async (k) => storage.kv.get(k) ?? null,
      put: async (k, v) => { storage.kv.set(k, v); },
      setAlarm: async (t) => { storage.alarm = t; },
    },
    _sockets: sockets,
    _storage: storage,
  };
}

// A fake WebSocket: records sent frames, allows programmatic onmessage/onclose.
function fakeWs() {
  return {
    sent: [],
    send(msg) { this.sent.push(msg); },
    close(code, reason) { this.closed = { code, reason }; },
  };
}

test("hub /status: online when a socket is attached", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, {});
  const res = await hub.fetch(new Request("https://hub/status"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { online: true });
});

test("hub /call: offline (no socket) → 503 extension_offline", async () => {
  const state = makeState([]);
  const hub = new PluginHubDO(state, {});
  const res = await hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "browser_click", params: {}, requestId: "r1" }),
  }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "extension_offline" });
});

test("hub /call: online → forwards request to the socket and resolves the response", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, {});
  const p = hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "browser_click", params: { x: 1 }, requestId: "r2" }),
  }));
  // Yield once so the async fetch reaches ws.send.
  await new Promise((r) => setImmediate(r));
  assert.equal(ws.sent.length, 1);
  const sent = JSON.parse(ws.sent[0]);
  assert.equal(sent.id, "r2");
  assert.equal(sent.type, "request");
  assert.equal(sent.tool, "browser_click");
  // Extension replies → the /call promise resolves.
  hub.webSocketMessage(ws, JSON.stringify({ id: "r2", type: "response", ok: true, result: { clicked: true } }));
  const res = await p;
  assert.deepEqual(await res.json(), { id: "r2", type: "response", ok: true, result: { clicked: true } });
});

test("hub webSocketMessage: ping → pong echoes t", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, {});
  hub.webSocketMessage(ws, JSON.stringify({ type: "ping", t: 42 }));
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "pong", t: 42 });
});

test("hub webSocketMessage: hello stores lastSeen", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, {});
  await hub.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
  assert.ok(state._storage.kv.has("lastSeen"));
});

test("hub webSocketClose: rejects all in-flight calls with extension_disconnected", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, {});
  const p = hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "browser_open", params: {}, requestId: "r3" }),
  }));
  await new Promise((r) => setImmediate(r)); // let /call register the pending
  hub.webSocketClose(ws, 1000, "bye");
  const res = await p;
  assert.deepEqual(await res.json(), { error: "extension_disconnected" });
});

test("hub /ws: wrong device → 400; non-websocket upgrade → 400", async () => {
  const state = makeState([]);
  const hub = new PluginHubDO(state, {});
  const wrong = await hub.fetch(new Request("https://hub/ws?device=d2"));
  assert.equal(wrong.status, 400);
  const noUpgrade = await hub.fetch(new Request("https://hub/ws?device=d1"));
  assert.equal(noUpgrade.status, 400);
});

test("hub /ws: valid websocket upgrade arms the idle alarm (skipped: needs CF runtime)", async (t) => {
  // The 101 + WebSocketPair path needs the Cloudflare runtime — node's undici
  // rejects status 101. The 400 paths above cover the gate; the accept path is
  // exercised by mcp-browser.test.mjs's hub stub.
  t.skip();
});

test("hub: DO_AUTH configured → request without x-do-auth is 401", async () => {
  const state = makeState([]);
  const hub = new PluginHubDO(state, { DO_AUTH: "sekret" });
  const res = await hub.fetch(new Request("https://hub/status"));
  assert.equal(res.status, 401);
  // With the header → authorized.
  const ok = await hub.fetch(new Request("https://hub/status", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(ok.status, 200);
});
