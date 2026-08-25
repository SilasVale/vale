#!/usr/bin/env node
// mcp-driver.mjs — drive the deployed vale-gate MCP browser tools via JSON-RPC.
// The deployed schema takes element refs as STRINGS under `target`:
//   node test/mcp-driver.mjs open <url>
//   node test/mcp-driver.mjs snap
//   node test/mcp-driver.mjs click <ref>        e.g. click e56
//   node test/mcp-driver.mjs type <ref> <text...>
//   node test/mcp-driver.mjs wait <text> [secs]
//   node test/mcp-driver.mjs shot

import { readFileSync } from "node:fs";
import os from "node:os";


const patch = readFileSync(process.env.HOME + "/.dsh/profiles/web/cordis.patch.yml", "utf8");
const URL_MCP = patch.match(/url:\s*(\S+)/)[1];
const TOKEN = patch.match(/Authorization:\s*Bearer\s+(\S+)/)[1];

let seq = 0;
async function rpc(method, params) {
  const res = await fetch(URL_MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params: params || {} }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok || (data && data.error)) {
    throw new Error(`RPC ${method} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return data && data.result;
}

async function call(tool, args) {
  const result = await rpc("tools/call", { name: tool, arguments: args });
  const content = (result && result.content) || [];
  let text = content.map((c) => c.text || "").join("\n");
  if (result && result.isError) throw new Error(text.slice(0, 400));
  // The gateway wraps the payload: text may be JSON with nested result strings.
  try {
    let probe = JSON.parse(text);
    if (probe && typeof probe.result === "string") text = probe.result;
    else if (probe && probe.result && typeof probe.result.result === "string") {
      text = probe.result.result;
    }
  } catch {}
  return text;
}

const [cmd, ...rest] = process.argv.slice(2);
const DEVICE = process.env.VALE_DEVICE || "d1";

switch (cmd) {
  case "open":
    console.log(await call("browser_open", { device: DEVICE, url: rest[0] }));
    break;
  case "snap":
    console.log(await call("browser_snapshot", { device: DEVICE }));
    break;
  case "click": {
    console.log(await call("browser_click", { device: DEVICE, target: rest[0] }));
    break;
  }
  case "type": {
    console.log(await call("browser_type", { device: DEVICE, target: rest[0], text: rest.slice(1).join(" ") }));
    break;
  }
  case "wait":
    console.log(await call("browser_wait", { device: DEVICE, condition: rest[0], timeout_s: Number(rest[1]) || 10 }));
    break;
  case "shot": {
    const img = await rpcCallShot();
    console.log(img);
    break;
  }
  default:
    console.error("usage: mcp-driver.mjs open|snap|click|type|wait|shot ...");
    process.exit(1);
}

async function rpcCallShot() {
  return call("browser_screenshot", { device: DEVICE });
}
