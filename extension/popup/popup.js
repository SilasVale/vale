// Popup — talks to background.js via chrome.runtime messages.
const $ = (id) => document.getElementById(id);

async function refresh() {
  // The background service worker can be dead (boot crash, mid-update
  // reload) — sendMessage then rejects. Surface it instead of silently
  // freezing on stale state with unhandled rejections every 2s.
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: "status" });
  } catch (e) {
    showError("extension background not responding — reload the extension");
    return;
  }
  const pill = $("wsState");
  pill.textContent = s.wsState;
  pill.className = `pill ${s.wsState}`;
  // Show the paired card whenever we know the DEVICE — after a browser
  // restart the session TOKEN is cleared (chrome.storage.session) but the
  // device name persists; the Terminal button still works (the 30-day
  // per-device cookie authenticates a tokenless navigation). Hiding the
  // card on a missing token made the round-29 fix unreachable, and
  // needsRepair = missing session token alone (which is EVERY restart — the
  // extension cannot read the HttpOnly cookie) would hide a perfectly
  // working card. So the paired card STAYS; the re-pair hint is shown when
  // the token is gone, and re-pairing is a manual Unpair → pair flow.
  if (s.device || s.pairedDeviceName) {
    $("pairedCard").classList.remove("hidden");
    $("pairCard").classList.add("hidden");
    $("device").textContent = s.device || s.pairedDeviceName;
    $("tabCount").textContent = String(s.controlledTabs?.length || 0);
    const repair = $("needsRepair");
    if (repair) repair.classList.toggle("hidden", !s.needsRepair);
  } else {
    $("pairedCard").classList.add("hidden");
    $("pairCard").classList.remove("hidden");
  }
  showError(s.error || "");
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").classList.toggle("hidden", !msg);
}

$("pair").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!code) return;
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "pair", code }); }
  catch { showError("background not responding — reload the extension"); return; }
  if (r?.ok) { $("code").value = ""; await refresh(); }
  else showError(r?.error || "pair failed");
});

$("openTab").addEventListener("click", async () => {
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "openTab" }); }
  catch { showError("background not responding — reload the extension"); return; }
  if (!r?.ok) showError(r?.error || "open failed");
});

$("openTerminal").addEventListener("click", () => {
  // The terminal panel is served through the GATEWAY proxy
  // (/api/devices/<name>/proxy/panel/) — the console origin + /panel/ was a
  // dead link (gateway has no /panel route) and the device's own hostname is
  // never stored. The gateway authenticates proxied API calls with the
  // PLUGIN TOKEN (session storage, not local): browser navigation cannot
  // carry an Authorization header, so the token goes in the URL as ?token=
  // (the panel reads it and sends Bearer on every fetch; gateway accepts
  // ?token= only for this top-level navigation).
  chrome.storage.local.get(["consoleOrigin", "valePlugin"]).then(({ consoleOrigin, valePlugin }) => {
    const device = valePlugin?.device;
    const base = (consoleOrigin || "https://api.saisi.online").replace(/\/+$/, "");
    if (device) {
      // round-124/126: the gateway 302s a ?token= top-level navigation to
      // the STRIPPED url with Set-Cookie — the token never reaches the
      // omnibox/history (even if the panel fails to boot), and the cookie is
      // minted regardless. A tokenless navigation can NEVER mint the cookie
      // (the gateway only accepts ?token= for navigations), so a fresh
      // pairing or an expired cookie would dead-end at the re-pair page.
      // Navigate WITH the token when we have one; keep the tokenless
      // fallback for the already-cookied restart case.
      chrome.storage.session.get("valePluginToken").then(({ valePluginToken }) => {
        const q = valePluginToken ? `?token=${encodeURIComponent(valePluginToken)}` : "";
        chrome.tabs.create({ url: `${base}/api/devices/${device}/proxy/panel/${q}` });
      });
      return;
    }
    chrome.tabs.create({ url: `${base}/` });
  });
});

$("unpair").addEventListener("click", async () => {
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "unpair" }); }
  catch { showError("background not responding — reload the extension"); return; }
  if (r?.ok) { showError(""); await refresh(); }
  else showError(r?.error || "unpair failed");
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2000);
