/**
 * Vale gateway plugin: admin — /api/admin/* (console admin APIs).
 *
 * round-73 plugin extraction: all handler/helper logic copied VERBATIM from
 * index.js (handleConsole); zero behavior change. The wiring phase (next)
 * dispatches through the registry and removes the now-duplicated routes
 * from index.js.
 *
 * Dispatch contract: handlers receive (request, env, url) — the same triple
 * handleConsole(request, env, url) got.
 *
 * Guard: ALL routes except /api/admin/public require an admin session —
 * requireSession copied verbatim from index.js, and each gated handler
 * checks role === "admin" (index.js gated these with the line
 * `if (user.role !== "admin") return jsonError(403, ...)` after the shared
 * session check; here the guard is inlined per handler with a 401).
 */

import { getCfToken, setCfToken, createInvite, listUsers, getUserKeys, setUserEnabled, hasAdminPassword, setAdminPassword, verifyAdminPassword, getAdminPassword, getUser, maskKey, ADMIN_ID, USER_KEY_NAMES } from "../store.ts";
import { parseCookie, verifySessionToken, SESSION_COOKIE } from "../auth.ts";
import { MODELS, ROUTE_INFO } from "../channels.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import type { User } from "../store.ts";
import type { PluginContext } from "./registry.ts";

const ADMIN_BASE = "/api/admin";

/** Workers env bindings — the shape we touch (loosely typed, same style as
 *  store.ts / registry.ts). */
interface Env {
  [key: string]: any;
}

// Session HMAC key: prefer the dedicated high-entropy SESSION_SECRET (wrangler
// secret) over the admin password. Using the password directly lets any invited
// user offline-brute-force it from their own signed cookie (HMAC-SHA256 is not
// memory-hard); with SESSION_SECRET set, the password is never a signing key.
function sessionSecret(env: Env, adminPassword: string): string {
  return env.SESSION_SECRET || adminPassword;
}

async function requireSession(request: Request, env: Env): Promise<User | null> {
  const ap = await getAdminPassword(env);
  if (!ap) return null;
  const cookie = parseCookie(request.headers.get("Cookie") ?? "")[SESSION_COOKIE];
  if (!cookie) return null;
  // Revoked by logout (server-side blacklist — a copied cookie dies too).
  if (env.KEYS && (await env.KEYS.get(`sess-revoked:${cookie}`))) return null;
  const session = await verifySessionToken(sessionSecret(env, ap), cookie);
  if (!session) return null;
  const user = await getUser(env, session.uid);
  if (!user || !user.enabled) return null;
  return user;
}

/* ---- Public: route info (no session) ---- */

async function adminPublic(request: Request, env: Env): Promise<Response> {
  return jsonOk({ routes: ROUTE_INFO, models: MODELS.map((m) => m.id), apiHost: env.API_HOST || "" });
}

/* ---- Cloudflare tunnel API token — account-level credential the install
 * fetches (reg-key gated) so tunnel setup needs no browser login. Admin-only. ---- */

async function adminGetCfToken(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const token = await getCfToken(env);
  return jsonOk({ configured: !!token, masked: token ? maskKey(token) : "" });
}

async function adminPutCfToken(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const body = await readJson(request);
  const v = String(body?.token || "").trim();
  if (v && !/^[A-Za-z0-9_-]{20,}$/.test(v)) {
    return jsonError(400, "Token looks invalid (expected 20+ chars of letters/digits/_ -)", "invalid_request");
  }
  await setCfToken(env, v);
  return jsonOk({ ok: true });
}

/* ---- Invite codes ---- */

async function adminInvite(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const code = await createInvite(env);
  return jsonOk({ ok: true, code });
}

/* ---- Users ---- */

async function adminListUsers(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const users = await listUsers(env);
  const out = [];
  for (const u of users) {
    const ukeys = await getUserKeys(env, u.id);
    out.push({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      createdAt: u.createdAt,
      token: u.token,
      keys: userKeysStatus(ukeys),
    });
  }
  return jsonOk({ users: out });
}

async function adminSetUserEnabled(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const path = url.pathname;
  // round-107: malformed percent-escape in the user id threw URIError (500).
  let id: string;
  try { id = decodeURIComponent(path.slice(`${ADMIN_BASE}/users/`.length, -"/enabled".length)); }
  catch { return jsonError(400, "Invalid user id", "invalid_request"); }
  const body = await readJson(request);
  if (id === ADMIN_ID) return jsonError(400, "Cannot disable the admin account", "invalid_request");
  const u = await setUserEnabled(env, id, !!body.enabled);
  return jsonOk({ ok: true, id, enabled: u.enabled });
}

/* ---- Admin password: presence / change. The raw password is NEVER returned
 * (was plaintext before — a session holder could read it and impersonate
 * the admin indefinitely). ---- */

async function adminGetPassword(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  return jsonOk({ set: await hasAdminPassword(env) });
}

async function adminPutPassword(request: Request, env: Env): Promise<Response> {
  // round-119: bootstrap is circular — with NO password set, no session can
  // ever exist (requireSession returns null on empty getAdminPassword,
  // login 500s 'not configured'), so the console was unreachable on a fresh
  // deployment with no ADMIN_PASSWORD secret. Allow a session-less FIRST
  // password set when none exists (the admin key from KV gates it — the
  // same credential the reset-password path uses); once a password exists
  // the current-password + session requirements apply.
  const hasPw = await hasAdminPassword(env);
  if (!hasPw) {
    const body = await readJson(request);
    const v = String(body?.password || "");
    if (v.length < 8) return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
    // Gate the bootstrap with the admin gateway token (the console Overview
    // value / Claude Code key) — an unauthenticated internet caller must not
    // set the console password on a fresh deployment.
    const admin = await getUser(env, ADMIN_ID);
    const adminKey = String(body?.adminKey || "").trim();
    if (!admin?.token || adminKey !== admin.token) {
      return jsonError(403, "Invalid admin key — cannot set initial password", "authentication_error");
    }
    await setAdminPassword(env, v);
    return jsonOk({ ok: true, changed: true, initial: true });
  }
  const user = await requireSession(request, env);
  if (!user || user.role !== "admin") return jsonError(401, "Not logged in", "authentication_error");
  const body = await readJson(request);
  const v = String(body?.password || "");
  if (v.length < 8) return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
  // Require the CURRENT password: a hijacked session must not be able to
  // rotate the password and permanently lock out the real admin.
  if (!(await verifyAdminPassword(env, String(body?.currentPassword || "")))) {
    return jsonError(403, "Current password is incorrect", "authentication_error");
  }
  await setAdminPassword(env, v);
  return jsonOk({ ok: true, changed: true });
}

/* ---- Helper (copied verbatim from index.js) ---- */

function userKeysStatus(ukeys: Record<string, any>): Record<string, { configured: boolean; masked: string }> {
  const out: Record<string, { configured: boolean; masked: string }> = {};
  for (const n of USER_KEY_NAMES) {
    const v = ukeys[n];
    out[n] = { configured: !!v, masked: maskKey(v) };
  }
  return out;
}

export default {
  name: "admin",
  deps: [],
  setup(ctx: PluginContext) {
    // Exact method+path match, same as the index.js if/else chain (the
    // registry's route() helper does prefix matching — exact here so
    // /api/admin/users never swallows /api/admin/users/{id}/enabled).
    const add = (method: string, path: string, handler: (...args: any[]) => any) =>
      ctx.routes.push({ match: (m, p) => m === method && p === path, handler });
    add("GET", `${ADMIN_BASE}/public`, adminPublic);
    add("GET", `${ADMIN_BASE}/cloudflare-token`, adminGetCfToken);
    add("PUT", `${ADMIN_BASE}/cloudflare-token`, adminPutCfToken);
    add("POST", `${ADMIN_BASE}/invite`, adminInvite);
    add("GET", `${ADMIN_BASE}/users`, adminListUsers);
    // Dynamic path: PUT /api/admin/users/{id}/enabled (startsWith + endsWith,
    // same matcher as the index.js if).
    ctx.routes.push({
      match: (m, p) => m === "PUT" && p.startsWith(`${ADMIN_BASE}/users/`) && p.endsWith("/enabled"),
      handler: adminSetUserEnabled,
    });
    add("GET", `${ADMIN_BASE}/password`, adminGetPassword);
    add("PUT", `${ADMIN_BASE}/password`, adminPutPassword);
  },
};
