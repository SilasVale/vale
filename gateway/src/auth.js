/**
 * auth.js — Password hashing + session signing (zero-dependency, Web Crypto only)
 *
 * Passwords: PBKDF2-SHA256 with a per-user random salt and a fixed iteration count.
 * Sessions: HMAC-SHA256 signed cookie; the signing key is ADMIN_PASSWORD
 *           (the single Worker-secret trust anchor).
 */

export const PASSWORD_ITERATIONS = 100000;

export function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PASSWORD_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function verifyPassword(password, salt, expectedHash) {
  const h = await hashPassword(password, salt);
  return timingSafeEqual(h, expectedHash);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---- Sessions (HMAC-signed, key = ADMIN_PASSWORD) ---- */

export const SESSION_COOKIE = "ag_session";
export const SESSION_TTL_MS = 24 * 3600 * 1000;

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeStr(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeStr(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

/** Issue a session token: `b64url(payload).hmac`, payload = { uid, role, exp } */
export async function issueSessionToken(secret, uid, role) {
  const payload = b64urlEncodeStr(JSON.stringify({ uid, role, exp: Date.now() + SESSION_TTL_MS }));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** Verify a session token; returns { uid, role, exp } on success, or null */
export async function verifySessionToken(secret, token) {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await hmacKey(secret);
  const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  if (!timingSafeEqual(bytesToB64url(sigBytes), sig)) return null;
  try {
    const data = JSON.parse(b64urlDecodeStr(payload));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { uid: String(data.uid), role: String(data.role || "user") };
  } catch {
    return null;
  }
}

export function parseCookie(str) {
  const out = {};
  for (const pair of String(str || "").split(";")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookieHeader(token, maxAgeSec, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
