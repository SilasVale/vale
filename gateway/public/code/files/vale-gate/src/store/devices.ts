/**
 * store/devices.ts — the Vale Agent device registry (devices:v1, admin-
 * managed) plus the account-level Cloudflare tunnel API token (cf:api_token)
 * the Windows install fetches with a registration key.
 */

import { cdel, cget, cset, withKeyLock, type Env } from "./cache.ts";

export interface Device {
  name: string;
  hostname: string;
  token: string;
  /// round-103: the device's proxy secret (X-Vale-Auth) — read from the
  /// device at registration so the gateway proxy can present it and the
  /// agent will inject the panel token ONLY for gateway-authenticated
  /// requests (the R102 marker header was client-spoofable).
  proxySecret?: string;
  /// Console-visible metadata. All optional so pre-existing records keep
  /// loading; they are filled opportunistically (registration / status
  /// probes) under the KV write budget — see touchDeviceSeen.
  registeredAt?: number;
  lastSeenAt?: number;
  lastVersion?: string;
}

/* ---- Devices (Vale Agent device registry, admin-managed) ----
 *
 * devices:v1 → JSON array of { name, hostname, token }
 *   name     → device id (also the console key), e.g. "d1"
 *   hostname → the device's public host, e.g. "d1.<dist-host>"
 *   token    → the vale-agent Bearer token (MCP + panel auth). Stored here so
 *              the console can show the MCP config and the proxy can inject it
 *              server-side; NEVER auto-dispensed to non-admin callers.
 */

const DEVICES_KEY = "devices:v1";

async function readDevicesRaw(env: Env): Promise<Device[]> {
  if (!env.KEYS) return [];
  const raw = await env.KEYS.get(DEVICES_KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export async function listDevices(env: Env): Promise<Device[]> {
  const hit = cget(DEVICES_KEY);
  if (hit !== undefined) return hit;
  const arr = await readDevicesRaw(env);
  cset(DEVICES_KEY, arr);
  return arr;
}

export async function saveDevices(env: Env, devices: Device[]): Promise<void> {
  if (!env.KEYS) return;
  await env.KEYS.put(DEVICES_KEY, JSON.stringify(devices));
  cset(DEVICES_KEY, devices); // covers upsertDevice / deleteDevice / /api/register
}

export async function getDevice(env: Env, name: string): Promise<Device | null> {
  const devs = await listDevices(env);
  return devs.find((d) => d.name === name) || null;
}

export async function upsertDevice(env: Env, device: Device): Promise<Device> {
  // Serialized RMW: two concurrent writes used to both read [] and the
  // second save clobbered the first's device (registry loss → proxy 404).
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const i = devs.findIndex((d) => d.name === device.name);
    if (i >= 0) {
      // round-106: an admin edit REPLACED the whole record and wiped
      // proxySecret — /panel/ token injection broke permanently until
      // re-registration. Preserve the secret unless the caller sets one.
      if (!device.proxySecret && devs[i]!.proxySecret) {
        device = { ...device, proxySecret: devs[i]!.proxySecret };
      }
      devs[i] = device;
    } else {
      devs.push(device);
    }
    await saveDevices(env, devs);
    return device;
  });
}

/** Insert a device ONLY if the name is not already registered (round-122:
 *  /api/register's getDevice→409 guard was check-then-act — two concurrent
 *  same-name registrations both passed and the serialized upserts ended with
 *  the second party's hostname/token pointing at the name (device takeover,
 *  the exact round-68 hijack). The existence check now runs INSIDE the
 *  DEVICES_KEY critical section. Returns null when the name exists. */
export async function insertDevice(env: Env, device: Device): Promise<Device | null> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    if (devs.some((d) => d.name === device.name)) return null;
    devs.push(device);
    await saveDevices(env, devs);
    return device;
  });
}

export async function deleteDevice(env: Env, name: string): Promise<boolean> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const out = devs.filter((d) => d.name !== name);
    await saveDevices(env, out);
    return out.length !== devs.length;
  });
}

/** Rename a device (and optionally re-hostname it) PRESERVING the token,
 *  proxySecret and metadata — the old flow forced delete + re-add, which
 *  rotated the token and invalidated the device's own config.yaml. Callers
 *  still own the plugin-link migration + hub socket close (see devices.ts
 *  handleDeviceRename). Returns the updated device, or an error string:
 *  "not_found" | "name_taken". */
export async function renameDevice(
  env: Env,
  oldName: string,
  newName: string,
  hostname?: string,
): Promise<Device | "not_found" | "name_taken"> {
  return withKeyLock(DEVICES_KEY, async () => {
    const devs = await readDevicesRaw(env);
    const i = devs.findIndex((d) => d.name === oldName);
    if (i < 0) return "not_found";
    if (devs.some((d, j) => j !== i && d.name === newName)) return "name_taken";
    const updated: Device = {
      ...devs[i]!,
      name: newName,
      ...(hostname ? { hostname } : {}),
    };
    devs[i] = updated;
    await saveDevices(env, devs);
    return updated;
  });
}

/** Bounded-write "last seen" touch from the status probe loop. The probe
 *  runs every 30s per device — writing KV per poll would burn the daily
 *  write quota (round-102 discipline), so the record is written ONLY when
 *  the agent version changed or the last write is over an hour old. The
 *  cheap cached-list check short-circuits before any lock or raw KV read. */
const SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export async function touchDeviceSeen(env: Env, name: string, version?: string): Promise<void> {
  const devs = await listDevices(env); // cached read — no KV cost when warm
  const d = devs.find((x) => x.name === name);
  if (!d) return;
  const now = Date.now();
  const versionChanged = !!version && version !== d.lastVersion;
  const staleSeen = !d.lastSeenAt || now - d.lastSeenAt > SEEN_WRITE_INTERVAL_MS;
  if (!versionChanged && !staleSeen) return;
  await withKeyLock(DEVICES_KEY, async () => {
    const raw = await readDevicesRaw(env);
    const i = raw.findIndex((x) => x.name === name);
    if (i < 0) return;
    raw[i] = { ...raw[i]!, lastSeenAt: now, ...(version ? { lastVersion: version } : {}) };
    await saveDevices(env, raw);
  });
}

/* ---- Cloudflare tunnel API token (account-level, admin-managed) ----
 *
 * cf:api_token — the API token used by the Windows install to set up the
 * Cloudflare tunnel (Tunnel:Edit + Zone:DNS:Edit). Stored here so the install
 * can fetch it with a registration key instead of the user pasting it on the
 * machine. Account-level credential: admin-only read/write in the console.
 */

export async function getCfToken(env: Env): Promise<string> {
  const key = "cf:api_token";
  const hit = cget(key);
  if (hit !== undefined) return hit;
  const v = (env.KEYS ? await env.KEYS.get(key) : null) || "";
  cset(key, v);
  return v;
}

export async function setCfToken(env: Env, value: string): Promise<string> {
  if (!env.KEYS) throw new Error("KV not bound");
  const v = String(value || "").trim();
  if (v) {
    await env.KEYS.put("cf:api_token", v);
    cset("cf:api_token", v);
  } else {
    await env.KEYS.delete("cf:api_token");
    cdel("cf:api_token");
  }
  return v;
}
