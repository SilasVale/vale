// lib/terminals.mjs hub unit tests (CI tier — the WS data path's pure logic
// with stub viewers; the socket-level behavior stays live-only per the test
// tiering). Pins the two usage-driven review fixes:
//   - broadcast backpressure: a stalled viewer (bufferedAmount over budget)
//     is force-dropped instead of buffering forever;
//   - the per-terminal viewer cap: MAX_TERMINALS caps creation, the viewer
//     cap caps fan-out — a refused viewer must be reported so the server
//     can close the socket cleanly.
import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalHub } from "../lib/terminals.mjs";

function stubViewer({ readyState = 1, bufferedAmount = 0 } = {}) {
  return {
    readyState,
    bufferedAmount,
    sent: [],
    closed: false,
    terminated: false,
    send(data) { this.sent.push(data); },
    close() { this.closed = true; },
    terminate() { this.terminated = true; },
  };
}

test("termBroadcast: fan-out to open viewers, skip closed ones", async () => {
  const hub = createTerminalHub();
  const t = { id: "t", ring: { buf: [], write(d) { this.buf.push(d); }, toString() { return this.buf.join(""); } }, viewers: new Set(), exitCode: null };
  const a = stubViewer(), b = stubViewer({ readyState: 0 }); // CONNECTING
  hub.addViewer(t, a); hub.addViewer(t, b);
  const { termBroadcast } = await import("../lib/terminals.mjs");
  termBroadcast(t, Buffer.from("hello"));
  assert.deepEqual(a.sent, [Buffer.from("hello")]);
  assert.equal(b.sent.length, 0, "non-open viewers are skipped");
  assert.equal(t.ring.buf.length, 1, "ring always receives the frame");
});

test("broadcast backpressure: a stalled viewer (bufferedAmount over budget) is force-dropped", async () => {
  const hub = createTerminalHub();
  const t = { id: "t", ring: { buf: [], write() {}, toString() { return ""; } }, viewers: new Set(), exitCode: null };
  const stalled = stubViewer({ bufferedAmount: 5 * 1024 * 1024 });
  const healthy = stubViewer();
  hub.addViewer(t, stalled); hub.addViewer(t, healthy);
  const { termBroadcast } = await import("../lib/terminals.mjs");
  termBroadcast(t, Buffer.from("tick"));
  assert.equal(healthy.sent.length, 1, "healthy viewers keep receiving");
  assert.equal(stalled.terminated, true, "the stalled socket is force-closed");
  assert.equal(t.viewers.has(stalled), false, "and dropped from the fan-out set");
});

test("viewer cap: addViewer refuses past the cap and reports it", async () => {
  const hub = createTerminalHub({ maxViewers: 2 });
  const t = { id: "t", viewers: new Set() };
  assert.equal(hub.addViewer(t, stubViewer()), true);
  assert.equal(hub.addViewer(t, stubViewer()), true);
  assert.equal(hub.addViewer(t, stubViewer()), false, "third viewer refused at cap=2");
  assert.equal(t.viewers.size, 2);
});
