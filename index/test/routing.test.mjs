// Worker static-routing regression tests (structure refactor round — these
// routes previously had ZERO coverage). The Setup.exe serving exists
// precisely because a past bug served the download PAGE as 200 HTML for a
// missing binary (devices silently downloaded HTML as ValeAgent-Setup.exe);
// these tests pin the documented contract so it can't regress.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// ASSETS stub: answer version.json with JSON, everything else with an
// octet-stream "binary" so tgz routing is observable (status + pass-through).
function makeEnv(versionJson) {
  const assetsFetches = [];
  return {
    assetsFetches,
    env: {
      CONSOLE_URL: "https://console.example",
      ASSETS: {
        async fetch(req) {
          assetsFetches.push(String(req.url));
          const path = new URL(req.url).pathname;
          if (path === "/vale-agent/version.json") {
            if (versionJson === null) return new Response("no such key", { status: 404 });
            return new Response(JSON.stringify(versionJson), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("fake-binary", {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        },
      },
    },
  };
}

test("versioned tgz + latest alias both serve from ASSETS", async () => {
  const { env, assetsFetches } = makeEnv(null);
  for (const p of [
    "/vale-agent/vale-agent-1.2.297.tgz",
    "/vale-agent/vale-agent-latest.tgz",
  ]) {
    const resp = await worker.fetch(new Request(`https://dl.local${p}`), env);
    assert.equal(resp.status, 200, p);
    assert.equal(await resp.text(), "fake-binary", p);
  }
  assert.equal(assetsFetches.length, 2, "both requests must reach ASSETS");
});

test("near-miss tgz paths are NOT routed to ASSETS (exact-pattern discipline)", async () => {
  const { env, assetsFetches } = makeEnv(null);
  for (const p of [
    "/vale-agent/vale-agent-latest.tgz.exe",
    "/vale-agent/vale-agent-1.2.tgz",
    "/vale-agent/vale-agent-1.2.297.tgz/",
    "/vale-agent/evil-1.2.297.tgz",
  ]) {
    const resp = await worker.fetch(new Request(`https://dl.local${p}`), env);
    assert.equal(resp.status, 404, `${p} must fall to the 404 fallback`);
  }
  assert.equal(assetsFetches.length, 0, "no near-miss may reach ASSETS");
});

test("ValeAgent-Setup.exe alias + versioned names serve from ASSETS", async () => {
  const { env, assetsFetches } = makeEnv(null);
  for (const p of [
    "/vale-agent/ValeAgent-Setup.exe",
    "/vale-agent/ValeAgent-Setup-1.2.307.exe",
  ]) {
    const resp = await worker.fetch(new Request(`https://dl.local${p}`), env);
    assert.equal(resp.status, 200, p);
    assert.equal(await resp.text(), "fake-binary", p);
  }
  assert.equal(assetsFetches.length, 2, "both requests must reach ASSETS");
});

test("near-miss Setup.exe paths are NOT routed to ASSETS (exact-pattern discipline)", async () => {
  const { env, assetsFetches } = makeEnv(null);
  for (const p of [
    "/vale-agent/ValeAgent-Setup.exe.exe",
    "/vale-agent/ValeAgent-Setup-1.2.exe",
    "/vale-agent/ValeAgent-Setup-1.2.307.exe/",
    "/vale-agent/valeagent-setup.exe",
    "/vale-agent/ValeAgent-Setup-1.2.307.tgz",
  ]) {
    const resp = await worker.fetch(new Request(`https://dl.local${p}`), env);
    assert.equal(resp.status, 404, `${p} must fall to the 404 fallback`);
  }
  assert.equal(assetsFetches.length, 0, "no near-miss may reach ASSETS");
});

test("/api/version serves the release manifest derived from version.json", async () => {
  const { env } = makeEnv({
    version: "1.2.297",
    sha256: "a".repeat(64),
    tarball: "vale-agent-latest.tgz",
  });
  const resp = await worker.fetch(new Request("https://dl.local/api/version"), env);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.version, "1.2.297");
  assert.equal(body.sha256, "a".repeat(64));
  assert.equal(body.download, "https://dl.local/vale-agent/vale-agent-latest.tgz");
});

test("/api/version fails honest 503 on missing/unverifiable manifest", async () => {
  // No version.json at all.
  const missing = await worker.fetch(
    new Request("https://dl.local/api/version"),
    makeEnv(null).env,
  );
  assert.equal(missing.status, 503);
  // Truncated sha (round-119: agent_update refuses unverifiable installs —
  // the worker must not serve one either).
  const badSha = await worker.fetch(
    new Request("https://dl.local/api/version"),
    makeEnv({ version: "1.2.297", sha256: "abc", tarball: "vale-agent-latest.tgz" }).env,
  );
  assert.equal(badSha.status, 503);
});

test("unknown paths 404 (never the landing page as 200 HTML) and / renders it", async () => {
  const notFound = await worker.fetch(new Request("https://dl.local/nope"), makeEnv(null).env);
  assert.equal(notFound.status, 404);
  assert.notEqual(notFound.headers.get("content-type") || "", "text/html");

  const { env } = makeEnv(null);
  const page = await worker.fetch(new Request("https://dl.local/"), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(await page.text(), /<!doctype html>/);
});

test("cloudflared.exe proxies GitHub: pass-through on success, 502 on failure", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("clfz-binary", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const ok = await worker.fetch(
      new Request("https://dl.local/vale-agent/cloudflared.exe"),
      makeEnv(null).env,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/octet-stream");
    assert.equal(await ok.text(), "clfz-binary");

    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const bad = await worker.fetch(
      new Request("https://dl.local/vale-agent/cloudflared.exe"),
      makeEnv(null).env,
    );
    assert.equal(bad.status, 502);
    assert.match(await bad.text(), /503/);
  } finally {
    globalThis.fetch = real;
  }
});
