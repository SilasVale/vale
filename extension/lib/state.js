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
  if (!device && local[LS_KEY]?.token) {
    // LEGACY MIGRATION: pre-1.0.27 stored {device, token} in storage.local.
    // Move the token to session storage (never write it back to local).
    device = local[LS_KEY].device;
    token = local[LS_KEY].token;
    await Promise.all([
      chrome.storage.session.set({ [SESSION_KEY]: token }),
      chrome.storage.local.set({ [LS_KEY]: { device } }),
    ]);
  }
  if (device && token) state.pairedDevice = { device, token };
  return state.pairedDevice;
}
export async function savePairing(p) {
  state.pairedDevice = p;
  await Promise.all([
    chrome.storage.local.set({ [LS_KEY]: { device: p.device } }),
    chrome.storage.session.set({ [SESSION_KEY]: p.token }),
  ]);
}
export async function clearPairing() {
  state.pairedDevice = null;
  await Promise.all([
    chrome.storage.local.remove(LS_KEY),
    chrome.storage.session.remove(SESSION_KEY),
  ]);
}
