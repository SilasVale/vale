// /api/version tarball-field tests (P2-1, node:test, no CF runtime).
//
// The version.json `tarball` field is live data: /api/version must serve
// exactly the file it names (validated to a flat basename), falling back
// to the derived versioned name only when the field is absent/invalid so
// older manifests keep working. Smoke (scripts/smoke-index.sh) pins the
// consistent case live (tarball field == download basename).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function versionEnv(versionJson) {
  return {
    TEMP_CLAIM: {
      idFromName: (name) => ({ __name: name }),
      get: () => ({ fetch: async () => new Response("unused") }),
    },
    ASSETS: {
      fetch: async () =>
        new Response(JSON.stringify(versionJson), { headers: { "content-type": "application/json" } }),
    },
  };
}

const GOOD_SHA = "b".repeat(64);

test("tarball field is honored: latest alias served verbatim", async () => {
  const resp = await worker.fetch(
    new Request("https://dl.local/api/version"),
    versionEnv({ version: "1.2.3", tarball: "vale-agent-latest.tgz", sha256: GOOD_SHA }),
  );
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.download, "https://dl.local/vale-agent/vale-agent-latest.tgz");
});

test("tarball field is honored: versioned name served verbatim", async () => {
  const resp = await worker.fetch(
    new Request("https://dl.local/api/version"),
    versionEnv({ version: "1.2.3", tarball: "vale-agent-1.2.3.tgz", sha256: GOOD_SHA }),
  );
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.download, "https://dl.local/vale-agent/vale-agent-1.2.3.tgz");
});

test("absent tarball falls back to the derived versioned name (old manifests)", async () => {
  const resp = await worker.fetch(
    new Request("https://dl.local/api/version"),
    versionEnv({ version: "1.2.3", sha256: GOOD_SHA }),
  );
  assert.equal(resp.status, 200);
  const j = await resp.json();
  assert.equal(j.download, "https://dl.local/vale-agent/vale-agent-1.2.3.tgz");
});

test("hostile tarball (slashes / wrong suffix) falls back, never escapes /vale-agent/", async () => {
  for (const tarball of ["../secret.tgz", "/etc/passwd", "vale-agent-1.2.3.zip", "", null, undefined, 42]) {
    const resp = await worker.fetch(
      new Request("https://dl.local/api/version"),
      versionEnv({ version: "1.2.3", tarball, sha256: GOOD_SHA }),
    );
    assert.equal(resp.status, 200, `tarball ${JSON.stringify(tarball)} must fall back, not 503`);
    const j = await resp.json();
    assert.equal(j.download, "https://dl.local/vale-agent/vale-agent-1.2.3.tgz");
    assert.ok(!j.download.includes(".."), "download URL must not contain path traversal");
  }
});
