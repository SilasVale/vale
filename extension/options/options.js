// Options — consoleOrigin lives in chrome.storage.local; background is
// notified so it can refresh tools.js CONSOLE_ORIGIN and re-auth the WS.
const $ = (id) => document.getElementById(id);
const DEFAULT_ORIGIN = "https://api.saisi.online";

async function load() {
  const { consoleOrigin } = await chrome.storage.local.get("consoleOrigin");
  $("consoleOrigin").value = consoleOrigin || DEFAULT_ORIGIN;
}

$("save").addEventListener("click", async () => {
  let value = ($("consoleOrigin").value.trim() || DEFAULT_ORIGIN).replace(/\/+$/, "");
  // https-only: an http:// origin would let a MITM steal the plugin token
  // and pairing codes over cleartext; a lookalike domain exfiltrates them.
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") throw new Error("must be https://");
    value = u.origin; // strip path/query — only the origin is used
  } catch {
    const s = $("saved");
    s.textContent = "必须使用 https:// 地址";
    s.classList.remove("hidden");
    s.style.color = "var(--danger)";
    setTimeout(() => { s.classList.add("hidden"); s.style.color = ""; }, 3000);
    return;
  }
  await chrome.storage.local.set({ consoleOrigin: value });
  await chrome.runtime.sendMessage({ type: "optionsChanged" }).catch(() => {});
  const s = $("saved");
  s.classList.remove("hidden");
  setTimeout(() => s.classList.add("hidden"), 1500);
});

load();
