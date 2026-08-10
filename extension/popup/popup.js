// Popup — talks to background.js via chrome.runtime messages.
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  const pill = $("wsState");
  pill.textContent = s.wsState;
  pill.className = `pill ${s.wsState}`;
  if (s.device) {
    $("pairedCard").classList.remove("hidden");
    $("pairCard").classList.add("hidden");
    $("device").textContent = s.device;
    $("tabCount").textContent = String(s.controlledTabs?.length || 0);
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
  const r = await chrome.runtime.sendMessage({ type: "pair", code });
  if (r?.ok) { $("code").value = ""; await refresh(); }
  else showError(r?.error || "pair failed");
});

$("openTab").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "openTab" });
  if (!r?.ok) showError(r?.error || "open failed");
});

$("openTerminal").addEventListener("click", () => {
  // Terminal moved to a standalone web panel (no extension needed): open the
  // panel at the console origin. The panel asks for the device hostname +
  // token once and stores them in localStorage.
  chrome.storage.local.get("consoleOrigin").then(({ consoleOrigin }) => {
    const base = (consoleOrigin || "https://api.saisi.online").replace(/\/+$/, "");
    chrome.tabs.create({ url: `${base}/panel/` });
  });
});

$("unpair").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "unpair" });
  if (r?.ok) { showError(""); await refresh(); }
  else showError(r?.error || "unpair failed");
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2000);
