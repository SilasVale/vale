import { safeEq } from "../auth.ts";
/**
 * Vale gateway plugin: admin — /api/admin/* (console admin APIs).
 *
 * round-73 plugin extraction; the migration is COMPLETE — this plugin is
 * the only implementation of these routes (index.ts's inline copies are gone).
 *
 * Dispatch contract: handlers receive (request, env, url) — the same triple
 * handleConsole(request, env, url) got.
 *
 * Guard: ALL routes except /api/admin/public require an admin session —
 * requireAdmin from session.ts (401 not logged in / 403 non-admin, same as
 * the devices plugin). The PUT /api/admin/password bootstrap branch stays
 * session-less by design (first-password set on a fresh deployment).
 */

import {
  getCfToken,
  setCfToken,
  createInvite,
  listUsers,
  getUserKeys,
  setUserEnabled,
  hasAdminPassword,
  setAdminPassword,
  verifyAdminPassword,
  getUser,
  maskKey,
  userKeysStatus,
  ADMIN_ID,
} from "../store.ts";
import { MODELS, ROUTE_INFO } from "../channels.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import { requireAdmin } from "../session.ts";
import type { PluginContext } from "./registry.ts";

const ADMIN_BASE = "/api/admin";

/** Workers env bindings — the shape we touch (loosely typed, same style as
 *  store.ts / registry.ts). */
interface Env {
  [key: string]: any;
}

/* ---- Public: route info (no session) ---- */

async function adminPublic(_request: Request, env: Env): Promise<Response> {
  return jsonOk({
    routes: ROUTE_INFO,
    models: MODELS.map((m) => m.id),
    apiHost: env.API_HOST || "",
  });
}

/* ---- Cloudflare tunnel API token — account-level credential the install
 * fetches (reg-key gated) so tunnel setup needs no browser login. Admin-only. ---- */

async function adminGetCfToken(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const token = await getCfToken(env);
  return jsonOk({ configured: !!token, masked: token ? maskKey(token) : "" });
}

async function adminPutCfToken(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const body = await readJson(request);
  const v = String(body?.token || "").trim();
  if (v && !/^[A-Za-z0-9_-]{20,}$/.test(v)) {
    return jsonError(
      400,
      "Token looks invalid (expected 20+ chars of letters/digits/_ -)",
      "invalid_request",
    );
  }
  await setCfToken(env, v);
  return jsonOk({ ok: true });
}

/* ---- Invite codes ---- */

async function adminInvite(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const code = await createInvite(env);
  return jsonOk({ ok: true, code });
}

/* ---- Users ---- */

async function adminListUsers(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
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
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const path = url.pathname;
  // round-107: malformed percent-escape in the user id threw URIError (500).
  let id: string;
  try {
    id = decodeURIComponent(path.slice(`${ADMIN_BASE}/users/`.length, -"/enabled".length));
  } catch {
    return jsonError(400, "Invalid user id", "invalid_request");
  }
  const body = await readJson(request);
  if (id === ADMIN_ID) return jsonError(400, "Cannot disable the admin account", "invalid_request");
  const u = await setUserEnabled(env, id, !!body.enabled);
  return jsonOk({ ok: true, id, enabled: u.enabled });
}

/* ---- Admin password: presence / change. The raw password is NEVER returned
 * (was plaintext before — a session holder could read it and impersonate
 * the admin indefinitely). ---- */

async function adminGetPassword(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
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
    if (v.length < 8)
      return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
    // Gate the bootstrap with the admin gateway token (the console Overview
    // value / Claude Code key) — an unauthenticated internet caller must not
    // set the console password on a fresh deployment.
    const admin = await getUser(env, ADMIN_ID);
    const adminKey = String(body?.adminKey || "").trim();
    if (!admin?.token || !safeEq(adminKey, admin.token)) {
      return jsonError(
        403,
        "Invalid admin key — cannot set initial password",
        "authentication_error",
      );
    }
    await setAdminPassword(env, v);
    return jsonOk({ ok: true, changed: true, initial: true });
  }
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const body = await readJson(request);
  const v = String(body?.password || "");
  if (v.length < 8)
    return jsonError(400, "Admin password must be at least 8 chars", "invalid_request");
  // Require the CURRENT password: a hijacked session must not be able to
  // rotate the password and permanently lock out the real admin.
  if (!(await verifyAdminPassword(env, String(body?.currentPassword || "")))) {
    return jsonError(403, "Current password is incorrect", "authentication_error");
  }
  await setAdminPassword(env, v);
  return jsonOk({ ok: true, changed: true });
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
      match: (m, p) =>
        m === "PUT" && p.startsWith(`${ADMIN_BASE}/users/`) && p.endsWith("/enabled"),
      handler: adminSetUserEnabled,
    });
    add("GET", `${ADMIN_BASE}/password`, adminGetPassword);
    add("PUT", `${ADMIN_BASE}/password`, adminPutPassword);
  },
};
