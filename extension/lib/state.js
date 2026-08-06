// chrome.storage-backed state with an in-memory mirror.
export const state = {
  pairedDevice: null,   // { device, token }
  wsState: "disconnected",
  controlledTabs: {},   // device → tabId
  error: null,
};
const LS_KEY = "valePlugin";

export async function loadPairing() {
  const local = await chrome.storage.local.get(LS_KEY);
  if (local[LS_KEY]) state.pairedDevice = local[LS_KEY];
  return state.pairedDevice;
}
export async function savePairing(p) {
  state.pairedDevice = p;
  await chrome.storage.local.set({ [LS_KEY]: p });
}
export async function clearPairing() {
  state.pairedDevice = null;
  await chrome.storage.local.remove(LS_KEY);
}
