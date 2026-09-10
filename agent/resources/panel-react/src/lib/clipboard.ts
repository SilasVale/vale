// lib/clipboard.ts — the ONE clipboard writer for the panel.
//
// Promoted from a private helper in CommandCard.tsx when the Connect card
// became its second real consumer (the repo's PROMOTION rule: promote on the
// second consumer, when an incident lesson needs pinning, and with no
// environment coupling — all three hold here).
//
// The lesson it carries is not obvious and was paid for once: the panel is
// frequently served over PLAIN HTTP on a LAN address (or through the console
// proxy), where `navigator.clipboard` is UNDEFINED because the page is not a
// secure context. A naive `navigator.clipboard.writeText(...)` therefore
// throws a TypeError rather than failing gracefully — so a copy button that
// works on loopback silently breaks for the exact remote user who needs it
// most. The execCommand fallback is deprecated but it is the only thing that
// works in that context, which is why it is kept.

/** Copy `text`, resolving whether or not the copy actually succeeded.
 *
 *  Deliberately never rejects: every caller treats copying as best-effort
 *  feedback (they flip a "copied" label and move on), and a rejected promise
 *  from a fire-and-forget handler is an unhandled rejection. Callers that need
 *  to distinguish success should not — the platform does not report it
 *  reliably in the fallback path either. */
export function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {});
  }
  if (typeof document === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* best-effort: see the header */
    }
    ta.remove();
    resolve();
  });
}
