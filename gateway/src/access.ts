/**
 * Cloudflare Access identity — zero-password console login (spec option C).
 *
 * After a visitor passes the zone's Access email-OTP challenge, Cloudflare
 * injects a signed JWT into every origin-bound request:
 *
 *     Cf-Access-Jwt-Assertion: <RS256 JWT, claims include email + aud + exp>
 *
 * This module verifies that JWT against the team's published certs and maps
 * the verified email onto a console user:
 *
 *   - ACCESS_ADMIN_EMAIL match  → the seeded admin account
 *   - previously-seen email      → its bound account (KV access-email:<email>)
 *   - first time seen            → auto-provision a passwordless "user"
 *
 * Password accounts keep working unchanged: requireSession tries the cookie
 * session FIRST (local/dev fallback), and only falls back to this path when
 * there is no valid session cookie. Multi-user is preserved — identity is
 * the verified email instead of a shared password.
 */

interface Env {
  [key: string]: any;
}
import type { User } from "./store.ts";
import { withKeyLock } from "./store.ts";
import { randomHex } from "./auth.ts";

const CERTS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { keys: any[]; exp: number } | null = null;

function b64urlToJson(part: string): any {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + pad));
}

async function fetchJwks(env: Env): Promise<any[]> {
  if (env.ACCESS_JWKS_JSON) return JSON.parse(env.ACCESS_JWKS_JSON).keys;
  if (jwksCache && Date.now() < jwksCache.exp) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: 3600 },
  } as any);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = await res.json();
  jwksCache = { keys: body.keys, exp: Date.now() + CERTS_TTL_MS };
  return body.keys;
}

/** Verify the Cf-Access JWT; returns the verified email, or null. */
export async function verifyAccessJwt(request: Request, env: Env): Promise<{ email: string } | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: any;
  let payload: any;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch {
    return null;
  }
  if (!header.kid || payload.aud !== env.ACCESS_AUD) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;

  let keyJwk: any;
  try {
    keyJwk = (await fetchJwks(env)).find((k) => k.kid === header.kid);
  } catch {
    return null;
  }
  if (!keyJwk || keyJwk.alg !== "RS256") return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    keyJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!ok) return null;

  const email = String(payload.email || "").toLowerCase().trim();
  return email.includes("@") ? { email } : null;
}

function usernameFromEmail(email: string): string {
  let base = email.split("@")[0].replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 28);
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(base)) base = "user";
  return base;
}

/**
 * Map a verified Access email to a console user — bind, reuse or provision.
 * Returns null only when KV is unavailable.
 */
export async function ensureUserByEmail(env: Env, email: string): Promise<User | null> {
  if (!env.KEYS) return null;
  email = String(email || "").toLowerCase().trim();

  // Owner shortcut: the configured admin email drives the seeded admin account.
  const adminEmail = String(env.ACCESS_ADMIN_EMAIL || "").toLowerCase();
  if (adminEmail && email === adminEmail) {
    const admin = await env.KEYS.get("user:admin");
    if (admin) {
      const u = typeof admin === "string" ? JSON.parse(admin) : admin;
      if (u.enabled !== false) return u;
    }
    return null;
  }

  // Previously bound?
  const bound = await env.KEYS.get(`access-email:${email}`);
  if (bound) {
    const u = await env.KEYS.get(`user:${bound}`);
    if (u) {
      const user = typeof u === "string" ? JSON.parse(u) : u;
      if (user.enabled !== false) return user;
    }
  }

  // Provision a passwordless user. Serialized like createUser (round-107).
  return withKeyLock(`access-provision:${email}`, async () => {
    const again = await env.KEYS.get(`access-email:${email}`);
    if (again) {
      const u = await env.KEYS.get(`user:${again}`);
      if (u) return typeof u === "string" ? JSON.parse(u) : u;
    }

    let name = usernameFromEmail(email);
    if (await env.KEYS.get(`user:${name}`)) {
      const suffix = randomHex(2); // 4 hex chars — collision suffix
      name = `${name}-${suffix}`;
    }

    const token = randomHex(24);
    const user: User & { accessEmail?: string } = {
      id: name,
      username: name,
      role: "user",
      enabled: true,
      createdAt: Date.now(),
      token,
      accessEmail: email,
    };
    await env.KEYS.put(`user:${name}`, JSON.stringify(user));
    await env.KEYS.put(`token:${token}`, name);
    await env.KEYS.put(`access-email:${email}`, name);
    return user;
  });
}

/**
 * Fallback identity resolution for requireSession: cookie session failed,
 * so trust the edge-verified Access identity when this deployment opts in.
 */
export async function requireAccessSession(request: Request, env: Env): Promise<User | null> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const claims = await verifyAccessJwt(request, env);
  if (!claims) return null;
  return ensureUserByEmail(env, claims.email);
}
