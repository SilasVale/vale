// Address-bar merge rule for embedded-browser nav pushes.
//
// Focus-trap fix: the pane drops nav pushes while the address bar is
// focused (so typing is never clobbered). But the focus flag is cleared
// only by DOM blur — clicking into the NATIVE view (a separate OS window
// over the SPA) never fires blur, so the flag sticks forever and every
// later push is dropped: the bar freezes until the pane remounts.
// Rule: follow the push unless the user has UNSENT edits (focused AND the
// value differs both from what it was at focus time and from the last
// pushed URL).
export interface NavPushMerge {
  editing: boolean;
  inputValue: string;
  valueAtFocus: string;
  lastPushedUrl: string;
}

export function shouldAcceptNavPush(m: NavPushMerge): boolean {
  if (!m.editing) return true;
  if (m.inputValue === m.valueAtFocus) return true;
  if (m.inputValue === m.lastPushedUrl) return true;
  return false;
}
