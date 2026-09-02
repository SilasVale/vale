// PluginHubDO tests — the per-device WebSocket hub for the browser extension.
//
// The DO uses WebSocket Hibernation semantics (acceptWebSocket + storage
// alarms). Mock the state object with getWebSockets/acceptWebSocket/storage
// so no real Cloudflare runtime is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { PluginHubDO } from "../src/plugin-hub.ts";

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
  let attachment = null;
  return {
    sent: [],
    send(msg) { this.sent.push(msg); },
    close(code, reason) { this.closed = { code, reason }; },
    // round-121: token binding moved to the per-connection attachment.
    serializeAttachment(a) { attachment = a; },
    deserializeAttachment() { return attachment; },
  };
}

test("hub /status: online when a socket is attached", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, { DO_AUTH: "sekret" });
  const res = await hub.fetch(new Request("https://hub/status", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { online: true });
});

test("hub /call: offline (no socket) → 503 extension_offline", async () => {
  const state = makeState([]);
  const hub = new PluginHubDO(state, { DO_AUTH: "sekret" });
  const res = await hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-do-auth": "sekret" },
    body: JSON.stringify({ tool: "browser_click", params: {}, requestId: "r1" }),
  }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "extension_offline" });
});

// round-105: every frame is token-revalidated (a socket with NO bound token
// is closed) — tests that drive frames must bind a valid link first.
async function boundHub(state, ws) {
  const env = { DO_AUTH: "sekret",
    KEYS: {
      async get(k) {
        if (k === "plugins:v1") {
          return JSON.stringify({ "tok-test": { device: "d1", createdAt: Date.now(), expiresAt: Date.now() + 86400000 * 30 } });
        }
        return null;
      },
      async put() {}, async delete() {},
    },
  };
  const hub = new PluginHubDO(state, env);
  // Simulate the hello that binds the token to this socket (round-121:
  // token lives in the socket attachment, not storage).
  ws.serializeAttachment({ token: "tok-test" });
  return hub;
}

test("hub /call: online → forwards request to the socket and resolves the response", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = await boundHub(state, ws);
  const p = hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-do-auth": "sekret" },
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
  await hub.webSocketMessage(ws, JSON.stringify({ id: "r2", type: "response", ok: true, result: { clicked: true } }));
  const res = await p;
  assert.deepEqual(await res.json(), { id: "r2", type: "response", ok: true, result: { clicked: true } });
});

test("hub webSocketMessage: ping → pong echoes t", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = await boundHub(state, ws);
  // round-94: webSocketMessage is async (token re-validation on every frame);
  // await it so the pong is actually sent before asserting.
  await hub.webSocketMessage(ws, JSON.stringify({ type: "ping", t: 42 }));
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "pong", t: 42 });
});

test("hub webSocketMessage: hello with NO token closes (round-119: token required)", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = new PluginHubDO(state, { DO_AUTH: "sekret" });
  await hub.webSocketMessage(ws, JSON.stringify({ type: "hello" }));
  assert.equal(ws.closed?.code, 4001); // no bound token → close
  assert.ok(!state._storage.kv.has("lastSeen")); // nothing stored for an invalid hello
});

test("hub webSocketClose: rejects all in-flight calls with extension_disconnected", async () => {
  const ws = fakeWs();
  const state = makeState([ws]);
  const hub = await boundHub(state, ws); // round-119: /call validates the bound token
  const p = hub.fetch(new Request("https://hub/call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-do-auth": "sekret" },
    body: JSON.stringify({ tool: "browser_open", params: {}, requestId: "r3" }),
  }));
  await new Promise((r) => setImmediate(r)); // let /call register the pending
  hub.webSocketClose(ws, 1000, "bye");
  const res = await p;
  assert.deepEqual(await res.json(), { error: "extension_disconnected" });
});

test("hub /ws: wrong device → 400; non-websocket upgrade → 400", async () => {
  const state = makeState([]);
  const hub = new PluginHubDO(state, { DO_AUTH: "sekret" });
  const wrong = await hub.fetch(new Request("https://hub/ws?device=d2", { headers: { "x-do-auth": "sekret" } }));
  assert.equal(wrong.status, 400);
  const noUpgrade = await hub.fetch(new Request("https://hub/ws?device=d1", { headers: { "x-do-auth": "sekret" } }));
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
