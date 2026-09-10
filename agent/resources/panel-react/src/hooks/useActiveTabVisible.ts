import { useEffect, useRef } from "react";

/**
 * Keep the ACTIVE tab inside a horizontally scrolling tab strip.
 *
 * THE BUG THIS FIXES. The strip has always had `overflow-x: auto`, which makes
 * a BROWSER-initiated activation scroll the tab into view — clicking an
 * off-screen tab works, so the strip looks fine when driven by hand. But every
 * activation this app performs is PROGRAMMATIC: closing the active session
 * selects a neighbour, a new `terminal_open` appends and activates, the AI
 * opens sessions on its own, and a deep link selects one. None of those move
 * the scroll position, so the active tab can sit in the clipped region while
 * the pane below shows its content — the tab you are looking at is not the tab
 * you are typing into. Measured against the real budget: a 1840px window
 * leaves ~1412px for the strip, a tab is up to 204px, so the seventh tab and
 * beyond are already off-screen.
 *
 * WHY A HOOK, AND WHY `data-active`. Both tab strips need this — the panel's
 * `TabBar` and the desktop shell's inline strip — and the rule is identical
 * for both, so it lives here rather than being written twice (and drifting).
 * The lookup goes through a `data-active` attribute instead of the session id:
 * a raw id in a selector has to be escaped (`CSS.escape` is absent in jsdom),
 * and ids contain `:` and `@` often enough to matter.
 *
 * `block: "nearest"` keeps the page from jumping vertically, and
 * `inline: "nearest"` scrolls the strip by the minimum needed so a visible tab
 * does not move at all. The optional-chained call is deliberate: jsdom does
 * not implement `scrollIntoView`, and the strip must render fine in tests
 * (the tests assert the CALL, via a spy).
 *
 * `tabCount` is a dependency because the active tab can drift out of view
 * WITHOUT changing identity: appending a tab, or closing one, shifts every
 * later tab's position. Re-checking on the count keeps the reveal honest
 * without watching the whole session array (whose identity changes on every
 * poll, which would re-run this constantly).
 *
 * Returns the ref to attach to the scrolling container.
 */
export function useActiveTabVisible(activeSid: string | null, tabCount: number) {
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Nothing active → nothing to reveal. Skipping also avoids a pointless
    // query on every session-list change while no tab is selected.
    if (!activeSid) return;
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[data-active="1"]');
    // `inline: nearest` is the whole point: a tab already fully visible must
    // not move, or the strip would twitch on every unrelated re-render.
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSid, tabCount]);
  return stripRef;
}
