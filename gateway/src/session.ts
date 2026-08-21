/**
 * Session auth — the single requireSession/sessionSecret implementation.
 *
 * Was copied verbatim into index.ts and plugins/{auth,devices,admin,mcp}.ts;
 * every copy drifted independently (the mcp plugin's round-88 gate missed the
 * sess-revoked blacklist for weeks). One module, one contract:
 *
 *   sessionSecret(env, adminPassword) — HMAC signing key for the session
 *   cookie. Prefers the dedicated high-entropy SESSION_SECRET (wrangler
 *   secret) over the admin password: using the password directly lets any
 *   invited user offline-brute-force it from their own signed cookie
 *   (HMAC-SHA256 is not memory-hard); with SESSION_SECRET set, the password
 *   is never a signing key.
 *
 *   requireSession(request, env) — resolves the console user from the
 *   session cookie, or null. Checks, in order: an admin password exists at
 *   all (no password → no sessions), the cookie is present, the cookie was
 *   not revoked by logout (server-side KV blacklist — a copied cookie dies
 *   too), the HMAC signature verifies, and the user still exists + enabled.
 */

import { getAdminPassword, getUser, type User } from "./store.ts";
import { parseCookie, verifySessionToken, SESSION_COOKIE } from "./auth.ts";
import { jsonError } from "./http.ts";

export function sessionSecret(env: any, adminPassword: string): string {
  return env.SESSION_SECRET || adminPassword;
}

export async function requireSession(request: Request, env: any): Promise<User | null> {
  const ap = await getAdminPassword(env);
  if (!ap) return null;
  const cookie = parseCookie(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!cookie) return null;
  // Revoked by logout (server-side blacklist — a copied cookie dies too).
  if (env.KEYS && (await env.KEYS.get(`sess-revoked:${cookie}`))) return null;
  const session = await verifySessionToken(sessionSecret(env, ap), cookie);
  if (!session) return null;
  const user = await getUser(env, session.uid);
  if (!user || !user.enabled) return null;
  return user;
}

/**
 * Admin gate used by every /api/admin/* and device-module handler: resolves
 * the session and requires role === "admin". Returns the user, or a Response
 * the handler should return directly (401 not logged in / 403 non-admin).
 */
export async function requireAdmin(
  request: Request,
  env: any,
): Promise<User | Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") {
    return jsonError(403, "Admin permission required", "authorization_error");
  }
  return user;
}
