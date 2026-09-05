// Shared test helpers (mirrors gateway/test/helpers.mjs): an in-memory R2
// mock supporting get/put/delete with the same value shape the worker
// relies on (body + httpMetadata + customMetadata).
import assert from "node:assert/strict";

const enc = new TextEncoder();

/** In-memory R2 bucket mock. put() accepts a string, Uint8Array, or Blob. */
export function makeR2() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts = {}) {
      let bytes;
      if (typeof value === "string") bytes = enc.encode(value);
      else if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
      else throw new TypeError(`makeR2: unsupported value type for ${key}`);
      store.set(key, {
        bytes,
        httpMetadata: { ...(opts.httpMetadata || {}) },
        customMetadata: { ...(opts.customMetadata || {}) },
      });
    },
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      return {
        body: new Blob([e.bytes]),
        httpMetadata: { ...e.httpMetadata },
        customMetadata: { ...e.customMetadata },
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/** Seed one temp file the way POST /api/upload writes it. */
export async function seedFile(r2, token, bytes, { contentType, disposition, expiresAt } = {}) {
  await r2.put(`files/${token}`, bytes, {
    httpMetadata: {
      contentType: contentType || "application/octet-stream",
      contentDisposition: disposition || 'attachment; filename="download.bin"',
    },
    customMetadata: expiresAt == null ? {} : { expiresAt: String(expiresAt) },
  });
}

/** Read a Response fully as bytes for exact comparison. */
export async function respBytes(resp) {
  return new Uint8Array(await resp.arrayBuffer());
}

/** Assert a JSON error response has the exact status + body (no headers). */
export async function assertJsonError(resp, status, error) {
  assert.equal(resp.status, status);
  assert.equal(await resp.text(), JSON.stringify({ error }));
}
