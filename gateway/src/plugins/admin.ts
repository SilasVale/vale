import {
  catalogue,
  customModels,
  deleteCustomModel,
  disabledModels,
  isBuiltIn,
  putCustomModel,
  setModelDisabled,
} from "../store/models.ts";
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
import { ROUTE_INFO, type ModelSpec } from "../channels.ts";
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
  // The MERGED catalogue (built-ins minus disabled, plus custom), so the console's
  // Models page shows exactly what clients are advertised.
  const cat = await catalogue(env);
  return jsonOk({
    routes: cat.routes,
    models: cat.models,
    apiHost: env.API_HOST || "",
  });
}

/* ---- Model catalogue: add / delete / disable ----
 *
 * THE CATALOGUE IS DATA. Adding a model used to mean editing `channels.ts`,
 * rebuilding and redeploying; the whole point of `store/models.ts` is that it now
 * means a POST. Admin-only, like every other mutation here.
 *
 * A CUSTOM model names its channel by prefix and inherits everything else. A
 * BUILT-IN one can only be DISABLED: its six facets cannot be re-derived by a form,
 * and a record deleted from KV could not be restored.
 */

/** The channel prefixes a custom model may claim — the real routes, not `"none"`. */
const KNOWN_PREFIXES: string[] = ROUTE_INFO.map((r) => r.prefix).filter((p) => p && p !== "none");

/**
 * The model id out of `/api/admin/models/<id>[/enabled]`.
 *
 * The dispatcher matches with startsWith/endsWith, so the path is read here rather
 * than threaded through. A model id contains slashes (`og/mimo-v2.5`), so this
 * strips the KNOWN prefix and suffix instead of splitting on "/" — splitting would
 * silently truncate every namespaced id to its first segment.
 */
function request_admin_model_id(req: Request): string {
  let p = new URL(req.url).pathname;
  p = p.slice(`${ADMIN_BASE}/models/`.length);
  if (p.endsWith("/enabled")) p = p.slice(0, -"/enabled".length);
  return p;
}

/** Guard the shape without over-validating: the facets have defaults, the ID does not. */
function parseModelSpec(body: any): { spec?: ModelSpec; error?: string } {
  const id = String(body?.id ?? "").trim();
  if (!id) return { error: "id is required" };
  // Deliberately loose: "lowercase prefix, slash, then no whitespace". Model names
  // carry `:floor[1m]` and nested slashes, so a stricter character class rejects
  // legitimate ids — and eslint flagged the first version I wrote for an unnecessary
  // escape. The check that MATTERS is the channel prefix below, validated against the
  // real route table: a permissive shape test plus a strict semantic one beats a
  // clever regex.
  if (!/^[a-z0-9]+\/\S+$/.test(id))
    return { error: `id must look like "prefix/name" — got ${JSON.stringify(id)}` };
  const prefix = id.slice(0, id.indexOf("/") + 1);
  if (!KNOWN_PREFIXES.includes(prefix))
    return {
      error: `unknown channel prefix ${JSON.stringify(prefix)}; known: ${KNOWN_PREFIXES.join(", ")}`,
    };
  const ownedBy = String(body?.ownedBy ?? "").trim() || prefix.replace("/", "");
  const spec: ModelSpec = { id, ownedBy };
  // `wire` is PINNED to og/ by wireModelName — a wire on any other prefix is
  // silently ignored, so accepting one would be a lie in the record.
  const wire = String(body?.wire ?? "").trim();
  if (wire && prefix === "og/") spec.wire = wire;
  if (body?.usEgress === true) spec.usEgress = true;
  if (body?.search === true) spec.search = true;
  if (body?.responsesOnly === true) spec.responsesOnly = true;
  return { spec };
}

async function adminAddModel(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;

  const { spec, error } = parseModelSpec(await readJson(request));
  if (error || !spec) return jsonError(400, error || "invalid model", "invalid_request");
  if (isBuiltIn(spec.id))
    return jsonError(409, `${spec.id} is a built-in model — disable it instead`, "invalid_request");
  const next = await putCustomModel(env, spec);
  return jsonOk({ ok: true, model: spec, custom: next.map((m) => m.id) });
}

async function adminDeleteModel(request: Request, env: Env, id: string): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;

  const decoded = decodeURIComponent(id);
  if (!isBuiltIn(decoded)) {
    const removed = await deleteCustomModel(env, decoded);
    if (removed) return jsonOk({ ok: true, removed: decoded });
    return jsonError(404, `No custom model ${decoded}`, "not_found_error");
  }
  // A BUILT-IN is disabled, not deleted — see store/models.ts.
  const next = await setModelDisabled(env, decoded, true);
  return jsonOk({ ok: true, disabled: decoded, disabledModels: next });
}

async function adminEnableModel(request: Request, env: Env, id: string): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;

  const decoded = decodeURIComponent(id);
  const next = await setModelDisabled(env, decoded, false);
  return jsonOk({ ok: true, enabled: decoded, disabledModels: next });
}

/** What the console needs to render the right control per model. */
async function adminModelState(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;

  return jsonOk({
    custom: (await customModels(env)).map((m) => m.id),
    disabled: [...(await disabledModels(env))],
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
      // Never return gateway tokens in the clear (same rule as the devices
      // list below, which maskKey()s device tokens) — a console session
      // holder must not harvest every user's credential. No reveal endpoint
      // by design (minimal change); rotation lives in /api/me.
      token: maskKey(u.token || ""),
      relayToken: maskKey(u.relayToken || ""),
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
    add("GET", `${ADMIN_BASE}/models`, adminModelState);
    add("POST", `${ADMIN_BASE}/models`, adminAddModel);
    // Dynamic: DELETE /api/admin/models/{id} (delete custom, disable built-in)
    // and PUT .../{id}/enabled (re-enable).
    ctx.routes.push({
      match: (m, p) => m === "DELETE" && p.startsWith(`${ADMIN_BASE}/models/`),
      handler: (req: Request, env: Env) => adminDeleteModel(req, env, request_admin_model_id(req)),
    });
    ctx.routes.push({
      match: (m, p) =>
        m === "PUT" && p.startsWith(`${ADMIN_BASE}/models/`) && p.endsWith("/enabled"),
      handler: (req: Request, env: Env) => adminEnableModel(req, env, request_admin_model_id(req)),
    });
    add("GET", `${ADMIN_BASE}/password`, adminGetPassword);
    add("PUT", `${ADMIN_BASE}/password`, adminPutPassword);
  },
};
