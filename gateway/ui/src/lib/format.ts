/** Shared display formatters. */

/** Mask a secret for display: `vk-1ab…cdef`. */
export function maskToken(tok: string | undefined | null): string {
  if (!tok) return "";
  if (tok.length <= 8) return tok[0] + "…" + tok.slice(-3);
  return tok.slice(0, 6) + "…" + tok.slice(-4);
}
