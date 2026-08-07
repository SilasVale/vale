// Options — consoleOrigin lives in chrome.storage.local; background is
// notified so it can refresh tools.js CONSOLE_ORIGIN and re-auth the WS.
const $ = (id) => document.getElementById(id);
const DEFAULT_ORIGIN = "https://ai.saisi.online";

async function load() {
  const { consoleOrigin } = await chrome.storage.local.get("consoleOrigin");
  $("consoleOrigin").value = consoleOrigin || DEFAULT_ORIGIN;
}

$("save").addEventListener("click", async () => {
  const value = ($("consoleOrigin").value.trim() || DEFAULT_ORIGIN).replace(/\/+$/, "");
  await chrome.storage.local.set({ consoleOrigin: value });
  await chrome.runtime.sendMessage({ type: "optionsChanged" }).catch(() => {});
  const s = $("saved");
  s.classList.remove("hidden");
  setTimeout(() => s.classList.add("hidden"), 1500);
});

load();
