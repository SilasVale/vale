// chrome.storage-backed state with an in-memory mirror.
export const state = {
  pairedDevice: null,   // { device, token }
  wsState: "disconnected",
  controlledTabs: {},   // device → tabId
  error: null,
};
// The plugin TOKEN lives in chrome.storage.session (in-memory, cleared when
// the browser/profile closes) — a 30-day credential was previously written
// plaintext to storage.local (profile disk) for anyone with file access.
// The device NAME stays in local (non-sensitive, survives restart).
const LS_KEY = "valePlugin";          // { device } — local
const SESSION_KEY = "valePluginToken"; // token — session

export async function loadPairing() {
  const [local, sess] = await Promise.all([
    chrome.storage.local.get(LS_KEY),
    chrome.storage.session.get(SESSION_KEY),
  ]);
  let device = local[LS_KEY]?.device;
  let token = sess[SESSION_KEY];
  // LEGACY MIGRATION: pre-1.0.27 stored {device, token} in storage.local, and
  // round-34+ (v:2) writes {device, token} to local deliberately (so Unpair can
  // revoke after a restart). Both write the token to local, so the migration
  // only needs to surface the token into session storage when session is empty
  // — it must NEVER strip the local token (a v-less round-34-era 1.0.47 record
  // is indistinguishable from pre-1.0.27, and stripping it resurfaced the
  // post-restart revoke gap after one restart).
  if (!token && local[LS_KEY]?.token) {
    device = local[LS_KEY].device;
    token = local[LS_KEY].token;
    await chrome.storage.session.set({ [SESSION_KEY]: token });
    // Keep the local token (needed for post-restart revoke); just refresh
    // the version marker so the record is recognized as current.
    await chrome.storage.local.set({ [LS_KEY]: { device, token, v: 2 } });
  }
  if (device && token) state.pairedDevice = { device, token };
  return state.pairedDevice;
}
export async function savePairing(p) {
  state.pairedDevice = p;
  await Promise.all([
    // The token ALSO goes to storage.local (in addition to session) — Unpair
    // must be able to revoke it server-side after a browser restart clears
    // the session storage. Exposure is equivalent to the gateway's HttpOnly
    // vale_pt cookie (30-day terminal control); a local copy lets the user
    // actually revoke that credential. v:2 marks records written by this
    // savePairing so loadPairing's legacy migration never strips them.
    chrome.storage.local.set({ [LS_KEY]: { device: p.device, token: p.token, v: 2 } }),
    chrome.storage.session.set({ [SESSION_KEY]: p.token }),
  ]);
}
/** Set state.error WITHOUT clobbering a pending "revoke failed — unpair not
 *  completed" warning: every error writer (ws.js ticket/reconnect, cdp.js
 *  detach, tools.js browser_close, background) must go through this so the
 *  one security-relevant message survives until the user resolves it. */
export function setStateError(msg) {
  if (!state.error || !/revoke failed/i.test(state.error)) {
    state.error = msg || null;
  }
}
export async function clearPairing() {
  state.pairedDevice = null;
  await Promise.all([
    chrome.storage.local.remove(LS_KEY),
    chrome.storage.session.remove(SESSION_KEY),
  ]);
}
