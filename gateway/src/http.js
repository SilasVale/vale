/**
 * HTTP helpers shared across the gateway: CORS headers, JSON responses,
 * and the readJson() body-parsing helper (replaces the repeated
 * `let body = {}; try { body = await request.json(); } catch {}` pattern).
 * Extracted from index.js (2026-08-12).
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE,PUT",
  "Access-Control-Allow-Headers": "*",
};

export function jsonOk(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders } });
}

export function jsonError(status, message, type, extraHeaders = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

/** Parse a request body as JSON, tolerating empty/invalid input. */
export async function readJson(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  return body;
}
