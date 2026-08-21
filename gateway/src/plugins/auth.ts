/**
 * Vale gateway plugin: auth — /api/auth/* (register / login / logout) and
 * /api/me/* (account info, route selection, US-proxy switch, user keys).
 *
 * round-73 plugin extraction: all handler/helper logic copied VERBATIM from
 * index.js (handleConsole); zero behavior change. The wiring phase (next)
 * dispatches through the registry and removes the now-duplicated routes
 * from index.js.
 *
 * Dispatch contract: handlers receive (request, env, url) — the same triple
 * handleConsole(request, env, url) got. The auth handlers' `secure` flag is
 * derived here the same way handleConsole did: url.protocol === "https:".
 */

import {
  createUser,
  getUser,
  findUserByUsername,
  regenerateToken,
  getUserKeys,
  setUserKey,
  deleteUserKey,
  getAdminPassword,
  hasAdminPassword,
  verifyAdminPassword,
  setAdminPassword,
  maskKey,
  ADMIN_ID,
  USER_KEY_NAMES,
  getUserRoute,
  setUserRoute,
  getGlobalSetting,
  setGlobalSetting,
  globalSettingEnabled,
  type User,
} from "../store.ts";
import {
  verifyPassword,
  issueSessionToken,
  verifySessionToken,
  parseCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  SESSION_COOKIE,
} from "../auth.ts";
import { fetchWithTimeout } from "../reliability.ts";
import { MODELS, OG_ZEN_CHAT, usProxyBase } from "../channels.ts";
import { jsonOk, jsonError, readJson } from "../http.ts";
import type { PluginContext } from "./registry.ts";

const AUTH_BASE = "/api/auth";
const ME_BASE = "/api/me";

// round-104: per-IP gate for registration (2-3 KV writes per attempt — an
// attacker can exhaust the Free-plan daily KV write quota). In-memory like
// the devices plugin's public gate; no per-request KV writes.
const __authRate = new Map(); // `ip:${bucket}` → count
function authRateLimited(request: Request): boolean {
  try {
    const ip = request?.headers?.get?.("cf-connecting-ip") || "unknown";
    const bucket = Math.floor(Date.now() / 60000);
    const key = `auth-rate:${ip}:${bucket}`;
    const hit = __authRate.get(key) || 0;
    if (hit >= 30) return true;
    __authRate.set(key, hit + 1);
    if (__authRate.size > 4096) __authRate.delete(__authRate.keys().next().value);
    return false;
  } catch {
    return false;
  }
}

// Session HMAC key: prefer the dedicated high-entropy SESSION_SECRET (wrangler
// secret) over the admin password. Using the password directly lets any invited
// user offline-brute-force it from their own signed cookie (HMAC-SHA256 is not
// memory-hard); with SESSION_SECRET set, the password is never a signing key.
function sessionSecret(env: any, adminPassword: string): string {
  return env.SESSION_SECRET || adminPassword;
}

async function requireSession(request: Request, env: any): Promise<User | null> {
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

/* ---- Register / Login ---- */

async function authRegister(request: Request, env: any, secure: boolean): Promise<Response> {
  // round-104: registration costs 2-3 KV writes per attempt — an attacker
  // can exhaust the Free-plan daily KV write quota (console-wide DoS).
  // Per-IP in-memory gate, same pattern as the devices plugin.
  if (authRateLimited(request)) {
    return jsonError(429, "rate limit exceeded", "rate_limit_error");
  }
  const ap = await getAdminPassword(env);
  if (!ap) return jsonError(500, "Admin password not configured", "config_error");
  const body = await readJson(request);
  try {
    const created = await createUser(env, {
      username: body.username,
      password: body.password,
      inviteCode: body.inviteCode,
      role: "user", // always a normal user; the admin can only come from seeding
    });
    const token = await issueSessionToken(sessionSecret(env, ap), created.id, created.role);
    return jsonOk(
      { ok: true, username: created.username, role: created.role, token: created.token },
      { "Set-Cookie": sessionCookieHeader(token, 86400, secure) },
    );
  } catch (e: any) {
    return jsonError(400, e.message, "invalid_request");
  }
}

async function authLogin(request: Request, env: any, secure: boolean): Promise<Response> {
  if (!(await hasAdminPassword(env)))
    return jsonError(500, "Admin password not configured", "config_error");
  // The session-signing key in fallback mode is the stored admin password
  // HASH (same value requireSession uses) — getAdminPassword returns the
  // hash, never the plaintext.
  const ap = await getAdminPassword(env);
  const body = await readJson(request);
  // Brute-force throttle: 5 consecutive failures lock the username for 30s
  // (exponential backoff would need the failure count; a flat lock is simple
  // and stops online guessing of the 6-8 char passwords).
  // Trim + lowercase: findUserByUsername trims, so an untrimmed key let
  // "admin " variants bypass the lock while still reaching the real admin
  // password check (brute-force bypass).
  // Bind the lock to the CALLER (IP+username): a per-username-only key let
  // any unauthenticated attacker POST 5 wrong passwords and hold the admin
  // console login at 429 forever (permanent login-layer DoS).
  const callerIp = request.headers?.get?.("cf-connecting-ip") || "unknown";
  // Per-IP in-memory burst gate BEFORE the KV lock path: a brute-force loop
  // otherwise burns 2-3 KV WRITES per failed login — ~400 attempts exhaust
  // the Free-plan daily write quota (1000). >10 failures/min from one IP
  // short-circuits with no KV traffic; the KV lock below still handles the
  // sustained case.
  const gk = `login:${callerIp}:${Math.floor(Date.now() / 60000)}`;
  const gate = (__loginGate.get(gk) || 0) + 1;
  __loginGate.set(gk, gate);
  if (__loginGate.size > 4096) __loginGate.delete(__loginGate.keys().next().value);
  if (gate > 10) {
    return jsonError(429, "Too many attempts — try again in a moment", "rate_limit_error");
  }
  const lockKey = `login-lock:${callerIp}:${String(body.username || "")
    .trim()
    .toLowerCase()}`;
  const locked = await env.KEYS.get(lockKey);
  if (locked) {
    return jsonError(429, "Too many attempts — try again in ~30s", "rate_limit_error");
  }
  const user = await findUserByUsername(env, body.username);
  if (!user || !user.enabled)
    return jsonError(401, "Incorrect username or password", "authentication_error");
  // eslint-disable-next-line no-useless-assignment
  let ok = false;
  if (user.id === ADMIN_ID) {
    // The admin account logs in with the admin password (stored HASHED —
    // compare via verifyAdminPassword, never read the plaintext).
    ok = await verifyAdminPassword(env, body.password || "");
  } else {
    ok =
      !!user.salt &&
      !!user.passwordHash &&
      (await verifyPassword(body.password || "", user.salt, user.passwordHash));
  }
  if (!ok) {
    // round-115: count failures in memory — the old KV counter (lockKey:":n")
    // burned one KV WRITE per failed attempt, the same quota-exhaustion path
    // as the register/pair endpoints (round-102/104 gated the rate but a
    // parallel burst across isolates still landed hundreds of writes). Only
    // arming the 30s lock touches KV. The lock itself is still KV, so a lock
    // armed on one isolate throttles every isolate.
    const fk = `login-fails:${callerIp}:${user.id}`;
    const fails = (__loginFails.get(fk) || 0) + 1;
    if (fails >= 5) {
      await env.KEYS.put(lockKey, "1", { expirationTtl: 60 });
      __loginFails.delete(fk);
    } else {
      __loginFails.set(fk, fails);
      if (__loginFails.size > 4096) __loginFails.delete(__loginFails.keys().next().value);
    }
    return jsonError(401, "Incorrect username or password", "authentication_error");
  }
  // Success clears the failure counter.
  __loginFails.delete(`login-fails:${callerIp}:${user.id}`);
  const token = await issueSessionToken(sessionSecret(env, ap), user.id, user.role);
  return jsonOk(
    { ok: true, username: user.username, role: user.role },
    { "Set-Cookie": sessionCookieHeader(token, 86400, secure) },
  );
}

/* ---- Reset admin password (by admin gateway token) ----
 *
 * The admin password is stored HASHED (never plaintext) so there is no way
 * to "look it up" — the console shows only `set`/`not set`. If the admin
 * forgets the password, the console is locked out entirely (the admin is
 * the only account that can change it). Recovery: prove possession of the
 * admin gateway token (the `x-api-key` value in the console Overview —
 * also the user's Claude Code key) and set a new password. Rate-limited
 * like register so an attacker cannot brute-force the token.
 */
async function authResetPassword(request: Request, env: any): Promise<Response> {
  if (authRateLimited(request)) {
    return jsonError(429, "rate limit exceeded", "rate_limit_error");
  }
  const admin = await getUser(env, ADMIN_ID);
  if (!admin) return jsonError(500, "Admin not seeded", "config_error");
  const body = await readJson(request);
  const adminKey = String(body?.adminKey || "").trim();
  const newPassword = String(body?.newPassword || "");
  if (!adminKey || !newPassword) {
    return jsonError(400, "adminKey and newPassword are required", "invalid_request");
  }
  if (newPassword.length < 8) {
    return jsonError(400, "New password must be at least 8 chars", "invalid_request");
  }
  // Prove possession of the admin gateway token (the console's Overview
  // shows this value; it is the same key Claude Code uses as x-api-key).
  if (!admin.token || adminKey !== admin.token) {
    return jsonError(403, "Invalid admin key", "authentication_error");
  }
  await setAdminPassword(env, newPassword);
  return jsonOk({ ok: true });
}

const __loginGate = new Map(); // `login:${ip}:${minute}` → failed-login burst count
const __loginFails = new Map(); // `login-fails:${ip}:${userId}` → consecutive failures (in-memory, round-115)

/* ---- Logout ---- */

async function authLogout(request: Request, env: any, secure: boolean): Promise<Response> {
  // round-110: logout is an unauthenticated KV-write endpoint (any crafted
  // cookie with a truthy exp triggers a write) — an attacker could exhaust
  // the daily KV write quota. Per-IP gate like register.
  // round-111: a 429 must STILL clear the client cookie — skipping the
  // whole handler left the browser cookie alive AND skipped the KV
  // blacklist (the endpoint's entire security purpose).
  if (authRateLimited(request)) {
    return jsonError(429, "rate limit exceeded", "rate_limit_error", {
      "set-cookie": clearSessionCookieHeader(secure),
    });
  }
  // Revoke the session server-side: the HMAC cookie alone was cleared
  // client-side, but a copied cookie stayed valid for the full 24h. Blacklist
  // the token hash in KV until its exp so it dies everywhere.
  const cookie = parseCookie(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (cookie && env.KEYS) {
    try {
      const payload = JSON.parse(
        atob(cookie.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") || "{}") || "{}",
      );
      if (payload.exp) {
        // round-122: exp is stored in MS (issueSessionToken uses Date.now() + SESSION_TTL_MS) — the old *1000 treated it as seconds, overstating the remaining life ~1000x (every logout wrote a 2-day entry).
        // round-124: floor 60 — KV's minimum expirationTtl; the old floor of
        // 1 let a <60s-life session skip the blacklist write entirely.
        const ttl = Math.max(60, Math.min(86400, Math.ceil((payload.exp - Date.now()) / 1000)));
        await env.KEYS.put(`sess-revoked:${cookie}`, "1", { expirationTtl: ttl });
      }
    } catch {
      /* malformed cookie — ignore */
    }
  }
  return jsonOk({ ok: true }, { "Set-Cookie": clearSessionCookieHeader(secure) });
}

/* ---- /api/me (session-gated; gate copied from handleConsole) ---- */

async function meGet(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const ukeys = await getUserKeys(env, user.id);
  return jsonOk({
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    token: user.token,
    keys: userKeysStatus(ukeys),
  });
}

// Per-user route selection (Claude Code model=auto)
// resolveAutoModel comes from the translate plugin via setup (module-level
// so the route handler can call it — handlers don't receive plugin context).
let resolveRouteModel: ((env: any, uid: string) => Promise<string>) | null = null;

async function meGetRoute(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  // effective: the model a model=auto request actually resolves to
  // (stored route if usable, else the usable fallback). The panel shows
  // this as "current" so a user without a manual choice still sees what
  // they're actually using.
  const model = await getUserRoute(env, user.id);
  const effective = resolveRouteModel ? await resolveRouteModel(env, user.id) : model;
  return jsonOk({ model, effective });
}

async function mePutRoute(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const body = await readJson(request);
  const model = body?.model ?? null;
  if (model !== null && !MODELS.some((m) => m.id === model)) {
    return jsonError(400, `Unknown model: ${model}`, "invalid_request");
  }
  await setUserRoute(env, user.id, model);
  return jsonOk({ ok: true, model });
}

async function meRegenerateToken(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const token = await regenerateToken(env, user.id);
  return jsonOk({ ok: true, token });
}

// 美国出口开关(全局设置):GET 读当前值;PUT 改(仅管理员)。
// 网关在每次请求路由时读 KV,开关立即生效,无需重启。
async function meGetUsproxy(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const v = await getGlobalSetting(env, "US_PROXY");
  return jsonOk({ enabled: !!v });
}

async function mePutUsproxy(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  if (user.role !== "admin") {
    return jsonError(403, "Admin only", "forbidden");
  }
  const body = await readJson(request);
  // round-94: an explicit OFF is persisted as "0" (not deleted) so it
  // shadows an env/US_PROXY Worker var — deleting let the env fallback
  // bounce the toggle straight back ON.
  await setGlobalSetting(env, "US_PROXY", body?.enabled ? "1" : "0");
  const v = await getGlobalSetting(env, "US_PROXY");
  return jsonOk({ ok: true, enabled: globalSettingEnabled(v) });
}

async function mePutKeys(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const body = await readJson(request);
  const { name, value } = body || {};
  if (!USER_KEY_NAMES.includes(name))
    return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
  if (typeof value !== "string" || !value.trim())
    return jsonError(400, "value must not be empty", "invalid_request");
  const v = value.trim();
  await setUserKey(env, user.id, name, v);
  return jsonOk({ ok: true, name, masked: maskKey(v) });
}

async function meDeleteKeys(request: Request, env: any, url: URL): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const name = url.searchParams.get("name") || "";
  if (!USER_KEY_NAMES.includes(name))
    return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
  await deleteUserKey(env, user.id, name);
  return jsonOk({ ok: true, name });
}

async function meTestKeys(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const body = await readJson(request);
  const name = body?.name;
  if (!USER_KEY_NAMES.includes(name))
    return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
  const ukeys = await getUserKeys(env, user.id);
  return testKey(env, name, ukeys[name]);
}

async function meKeyUsage(request: Request, env: any): Promise<Response> {
  const user = await requireSession(request, env);
  if (!user) return jsonError(401, "Not logged in or session expired", "authentication_error");
  const body = await readJson(request);
  const name = body?.name;
  if (name !== "OPENROUTER_API_KEY" && name !== "OPENCODE_GO_API_KEY")
    return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
  const ukeys = await getUserKeys(env, user.id);
  const key = ukeys[name];
  if (!key) return jsonOk({ ok: false, name, detail: "Key not configured" });

  if (name === "OPENROUTER_API_KEY") {
    try {
      const res = await fetchWithTimeout("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok)
        return jsonOk({ ok: false, name, status: res.status, detail: `Upstream ${res.status}` });
      const payload = await res.json();
      const data = (payload as any)?.data;
      if (!data || typeof data !== "object")
        return jsonOk({ ok: false, name, status: res.status, detail: "Invalid upstream response" });
      const out: any = { ok: true, name, status: res.status };
      for (const field of ["label", "usage", "limit"]) {
        if (
          field in data &&
          (data[field] === null || typeof data[field] === "string" || typeof data[field] === "number")
        )
          out[field] = data[field];
      }
      if (typeof data.is_free_tier === "boolean") out.isFreeTier = data.is_free_tier;
      if (data.rate_limit && typeof data.rate_limit === "object") {
        const rateLimit: any = {};
        if (typeof data.rate_limit.limit === "number") rateLimit.limit = data.rate_limit.limit;
        if (typeof data.rate_limit.interval === "string")
          rateLimit.interval = data.rate_limit.interval;
        if (typeof data.rate_limit.reset === "string") rateLimit.reset = data.rate_limit.reset;
        if (Object.keys(rateLimit).length) out.rateLimit = rateLimit;
      }
      return jsonOk(out);
    } catch {
      return jsonOk({ ok: false, name, detail: "Usage query failed" });
    }
  }

  if (name === "OPENCODE_GO_API_KEY") {
    // OpenCode Go subscription usage endpoint (undocumented, discovered via
    // farion1231/cc-switch#6433). Returns three rolling quota windows.
    try {
      const res = await fetchWithTimeout("https://opencode.ai/zen/go/v1/usage", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok)
        return jsonOk({ ok: false, name, status: res.status, detail: `Upstream ${res.status}` });
      const payload: any = await res.json();
      // Expected shape: { used, limit, balance, plan, windows: { "5h": {...}, weekly: {...}, monthly: {...} } }
      // Surface whatever the API returns, adapting to known shapes.
      const out: any = { ok: true, name, status: res.status };
      if (payload && typeof payload === "object") {
        // Single-window flat shape: { used, limit, balance, plan }
        if (typeof payload.used === "number") out.usage = payload.used;
        if ("limit" in payload && (typeof payload.limit === "number" || payload.limit === null))
          out.limit = payload.limit;
        if (typeof payload.balance === "number") out.balance = payload.balance;
        if (typeof payload.plan === "string") out.label = payload.plan;
        // Multi-window shape: { windows: { "5h": {...}, weekly: {...}, monthly: {...} } }
        if (payload.windows && typeof payload.windows === "object") {
          out.windows = {};
          for (const [wk, wv] of Object.entries(payload.windows) as [string, any][]) {
            if (wv && typeof wv === "object") {
              out.windows[wk] = {
                ...(typeof wv.used === "number" ? { used: wv.used } : {}),
                ...(typeof wv.limit === "number" || wv.limit === null ? { limit: wv.limit } : {}),
                ...(typeof wv.remaining === "number" ? { remaining: wv.remaining } : {}),
                ...(typeof wv.reset_at === "string" || wv.reset_at === null
                  ? { resetAt: wv.reset_at }
                  : {}),
              };
            }
          }
        }
      }
      return jsonOk(out);
    } catch {
      return jsonOk({ ok: false, name, detail: "Usage query failed" });
    }
  }

  return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
}

/* ---- Connectivity tests ---- */

async function testKey(env: any, name: string, key: string): Promise<Response> {
  if (!key) return jsonOk({ ok: false, name, detail: "Key not configured" });
  try {
    if (name === "DEEPSEEK_API_KEY") {
      const res = await fetchWithTimeout("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      return jsonOk({
        ok: res.ok,
        name,
        status: res.status,
        detail: res.ok ? "DeepSeek auth OK" : `Upstream ${res.status}`,
      });
    }
    if (name === "OPENROUTER_API_KEY") {
      const res = await fetchWithTimeout("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${key}` },
      });
      return jsonOk({
        ok: res.ok,
        name,
        status: res.status,
        detail: res.ok ? "OpenRouter auth OK" : `Upstream ${res.status}`,
      });
    }
    if (name === "OPENCODE_GO_API_KEY") {
      // Do not send the literal "[1m]" suffix — zen rejects it with 401
      // 尊重 US_PROXY 开关:开启时经美国代理探测(实测 chat/completions
      // 走代理 1-3s vs 直连 12-13s);关闭时直连。
      const usProxy = await getGlobalSetting(env, "US_PROXY");
      const probeUrl = usProxy
        ? `${usProxyBase(env)}/api/zen?target=og&path=${encodeURIComponent("/v1/chat/completions")}`
        : OG_ZEN_CHAT;
      const res = await fetchWithTimeout(probeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: true,
        }),
      });
      if (!res.ok) {
        return jsonOk({ ok: false, name, status: res.status, detail: `Upstream ${res.status}` });
      }
      // 流式探测:收到首个 SSE data 块即判定连通(auth OK + 连接建立),
      // 不等 thinking 结束(非流式要等完整响应 ~10s)。提前 cancel 释放连接。
      const firstChunk = await (async () => {
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        await reader.cancel().catch(() => {});
        return new TextDecoder().decode(value || new Uint8Array());
      })();
      const ok = firstChunk.includes("data:");
      return jsonOk({
        ok,
        name,
        status: res.status,
        detail: ok ? "OpenCode Go auth OK" : "OpenCode Go auth FAILED (no stream data)",
      });
    }
    if (name === "QWEN_API_KEY") {
      const res = await fetchWithTimeout(
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "qwen3.8-max-preview",
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
        },
      );
      return jsonOk({
        ok: res.ok,
        name,
        status: res.status,
        detail: res.ok ? "Qwen MaaS auth OK" : `Upstream ${res.status}`,
      });
    }
  } catch (e: any) {
    return jsonOk({ ok: false, name, detail: "Test failed: " + e.message });
  }
  return jsonError(400, `Unknown key name: ${name}`, "invalid_request");
}

function userKeysStatus(
  ukeys: Record<string, string>,
): Record<string, { configured: boolean; masked: string }> {
  const out: Record<string, { configured: boolean; masked: string }> = {};
  for (const n of USER_KEY_NAMES) {
    const v = ukeys[n];
    out[n] = { configured: !!v, masked: maskKey(v || "") };
  }
  return out;
}

export default {
  name: "auth",
  deps: ["translate"],
  setup(ctx: PluginContext) {
    // meGetRoute resolves the effective model via the translate plugin's
    // resolveAutoModel (dep registered before this setup runs).
    resolveRouteModel = (ctx.api?.translate as any)?.resolveAutoModel || null;
    // Exact method+path match, same as the index.js if/else chain (the
    // registry's route() helper does prefix matching — exact here so
    // /api/me never swallows /api/me/route etc.). Order mirrors index.js.
    const add = (method: string, path: string, handler: (...args: any[]) => any) =>
      ctx.routes.push({ match: (m: string, p: string) => m === method && p === path, handler });
    // `secure` derived exactly as handleConsole did: url.protocol === "https:"
    const withSecure =
      (fn: (request: Request, env: any, secure: boolean) => Response | Promise<Response>) =>
      (request: Request, env: any, url: URL): Response | Promise<Response> =>
        fn(request, env, url.protocol === "https:");
    add("POST", `${AUTH_BASE}/register`, withSecure(authRegister));
    add("POST", `${AUTH_BASE}/login`, withSecure(authLogin));
    add("POST", `${AUTH_BASE}/reset-password`, authResetPassword);
    add("POST", `${AUTH_BASE}/logout`, withSecure(authLogout));
    add("GET", ME_BASE, meGet);
    add("GET", `${ME_BASE}/route`, meGetRoute);
    add("PUT", `${ME_BASE}/route`, mePutRoute);
    add("POST", `${ME_BASE}/token/regenerate`, meRegenerateToken);
    add("GET", `${ME_BASE}/usproxy`, meGetUsproxy);
    add("PUT", `${ME_BASE}/usproxy`, mePutUsproxy);
    add("PUT", `${ME_BASE}/keys`, mePutKeys);
    add("DELETE", `${ME_BASE}/keys`, meDeleteKeys);
    add("POST", `${ME_BASE}/keys/test`, meTestKeys);
    add("POST", `${ME_BASE}/keys/usage`, meKeyUsage);
  },
};
