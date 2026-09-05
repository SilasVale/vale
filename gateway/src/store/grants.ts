/**
 * store/grants.ts — one-time device-panel grants (panelgrant:<code>).
 *
 * The console's DevicesPanel used to open the device panel with the device's
 * PERMANENT token in the URL (?token=<64hex>) — the credential rode in
 * browser history/journal, logs and the referer chain. The gateway instead
 * mints a SHORT-TTL, SINGLE-USE grant bound to one device; the agent redeems
 * it at /api/devices/panel-grant/redeem with its own Bearer token and serves
 * the panel with the token injected. The permanent token never touches a URL.
 */

import { randomHex } from "../auth.ts";
import type { Env } from "./cache.ts";

/* ---- Device panel grants ----
 *
 * panelgrant:<code> → JSON { device, mintedAt }
 *   device   → the registry name the grant is bound to (redeem 403s on any
 *              other caller, so a leaked URL is useless off-device)
 *   mintedAt → mint timestamp (diagnostics only; expiry is the KV TTL)
 *
 * TTL 120s: the grant only has to survive the click → browser navigation →
 * agent redeem window. KV's minimum expirationTtl is 60s; 120s keeps the
 * redeemable window comfortably above a slow page load while capping the
 * lifetime of a URL that sits in the address bar / history. Single-use: the
 * redeem handler deletes the grant BEFORE answering (best-effort at KV
 * consistency — see the race note in devices.ts).
 */

const PANELGRANT_TTL = 120; // seconds (KV floor is 60)

/// createPanelGrant mints exactly 32 lowercase hex chars — getPanelGrant
/// validates against this shape so garbage probes never cost a KV read.
const PANELGRANT_CODE_LEN = 32;

export interface PanelGrant {
  device: string;
  mintedAt: number;
}

/** Mint a one-time panel grant bound to `device`. Returns the raw code. */
export async function createPanelGrant(env: Env, device: string): Promise<string> {
  const code = randomHex(PANELGRANT_CODE_LEN / 2);
  if (env.KEYS) {
    await env.KEYS.put(
      `panelgrant:${code}`,
      JSON.stringify({ device, mintedAt: Date.now() } satisfies PanelGrant),
      { expirationTtl: PANELGRANT_TTL },
    );
  }
  return code;
}

/** Read a panel grant. Malformed codes (wrong shape) and missing/expired
 *  grants both return null — the caller answers 404 without distinguishing
 *  them, so probes learn nothing about which codes existed. */
export async function getPanelGrant(env: Env, code: string): Promise<PanelGrant | null> {
  const k = String(code || "").toLowerCase();
  if (!env.KEYS || !/^[0-9a-f]{32}$/.test(k)) return null;
  const raw = await env.KEYS.get(`panelgrant:${k}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.device === "string" && v.device) {
      return { device: v.device, mintedAt: typeof v.mintedAt === "number" ? v.mintedAt : 0 };
    }
  } catch {
    /* corrupted value behaves like a missing grant */
  }
  return null;
}

/** Consume a panel grant (delete the KV record). */
export async function deletePanelGrant(env: Env, code: string): Promise<void> {
  const k = String(code || "").toLowerCase();
  if (!env.KEYS || !k) return;
  await env.KEYS.delete(`panelgrant:${k}`);
}
