/**
 * The base URL a client should be given, from the operator-set `apiHost`.
 *
 * WHY THIS IS A FUNCTION AND NOT A TEMPLATE LITERAL. It used to be
 * `apiHost ? `https://${apiHost}` : "https://api.saisi.online"` — the scheme was
 * prefixed UNCONDITIONALLY. `API_HOST` is set by an operator, and
 * `https://api.saisi.online` is just as natural to type as `api.saisi.online`,
 * so the second spelling produced
 *
 *     "ANTHROPIC_BASE_URL": "https://https://api.saisi.online"
 *
 * in EVERY copied client config — a URL nothing validated, on the one screen
 * whose whole purpose is to be copy-pasted into Claude Code.
 *
 * It was found in a MOCK that happened to include the scheme, which is the
 * useful part of the story: the LIVE value is bare, so production was correct
 * and only the assumption was wrong. A mock that is more permissive than
 * production invents bugs; a mock that is less permissive hides them. This one
 * was more permissive, and it surfaced a real fragility rather than a real
 * outage.
 */
export function clientBase(apiHost?: string | null): string {
  const host = (apiHost || "").trim();
  if (!host) return "https://api.saisi.online";
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}
