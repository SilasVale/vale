/**
 * Body scanning — the 10ms CPU budget red line.
 *
 * The /v1/* hot path must NEVER fully JSON.parse / re-stringify a multi-MB
 * body (Workers Free plan 10ms CPU budget, Error 1102). This module only
 * provides O(n) raw-string scans: scanTopLevelModel, rawWithModel,
 * estimateTokens, MAX_BODY_BYTES. Extracted from index.js (2026-08-12).
 */

// Request body cap: Claude Code 1M-context bodies run ~4-10MB; anything larger
// would blow the Workers Free plan's 10ms CPU budget just to scan/parse it.
export const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Replace the top-level "model" value in a raw JSON body without parsing it.
 * Re-scans for the field's value span (cheap O(n), no object graph) and
 * rebuilds only that slice. Falls back to the unchanged body if the field
 * can't be located.
 */
export function rawWithModel(raw, newModel) {
  const { valueStart, valueEnd } = scanTopLevelModel(raw);
  if (valueStart < 0 || valueEnd <= valueStart) return raw;
  return raw.slice(0, valueStart) + JSON.stringify(newModel) + raw.slice(valueEnd);
}

/**
 * Lightweight scan of a JSON request body for the TOP-LEVEL "model" field,
 * WITHOUT building the object graph (avoids the full parse + re-stringify
 * that burns the Workers Free plan's 10ms CPU budget on multi-MB bodies).
 *
 * Walks the JSON once: skips strings (with escapes), objects, arrays, and
 * tracks depth. Returns { model, valueStart, valueEnd } where valueStart/End
 * bound the model string value (including its quotes) for in-place
 * replacement; model is null when absent.
 */
export function scanTopLevelModel(raw) {
  let i = 0;
  const n = raw.length;
  let depth = 0; // {} and [] nesting — model must sit at depth 0
  let inStr = false;
  let keyStart = -1; // first char of the key text (after its opening quote)
  let keyEnd = -1;   // index of the key's closing quote
  let pendingKey = false;
  while (i < n) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') {
        inStr = false;
        if (keyStart >= 0) keyEnd = i; // closing quote of a key string
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      if (pendingKey) {
        keyStart = i + 1; // start of the key text
        keyEnd = -1;
        pendingKey = false;
      }
      inStr = true;
      i += 1;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
      if (depth === 1) pendingKey = true; // entering the top-level object
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === ",") {
      // Top-level comma → the next token is a new key. Without this, any
      // field before "model" (system/tools, which Claude Code sends first)
      // leaves pendingKey false and "model" is never matched — the request
      // silently routes to the default (ds) channel.
      if (depth === 1) pendingKey = true;
      keyStart = -1;
      keyEnd = -1;
      i += 1;
      continue;
    }
    if (c === ":") {
      // key "model" at top level? keyStart..keyEnd bound the key text.
      if (depth === 1 && keyStart >= 0 && keyEnd > keyStart && raw.slice(keyStart, keyEnd) === "model") {
        // value follows — skip whitespace, expect a string.
        let j = i + 1;
        while (j < n && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\n" || raw[j] === "\r")) j += 1;
        if (j < n && raw[j] === '"') {
          const vs = j;
          let k = j + 1;
          let val = "";
          while (k < n) {
            if (raw[k] === "\\") { val += raw[k] + (raw[k + 1] || ""); k += 2; continue; }
            if (raw[k] === '"') break;
            val += raw[k];
            k += 1;
          }
          return { model: val, valueStart: vs, valueEnd: k + 1 };
        }
        return { model: null, valueStart: -1, valueEnd: -1 };
      }
      keyStart = -1;
      keyEnd = -1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { model: null, valueStart: -1, valueEnd: -1 };
}

/**
 * Rough token estimate. ASCII runs ~4 chars/token, CJK/other script chars are
 * ~1.8 tokens each — the plain `length / 4` underestimates Chinese-heavy
 * prompts, which skews the client's context accounting.
 *
 * CPU-safe: the char-by-char walk is O(n) and on a multi-MB body could alone
 * exceed the Workers Free plan 10ms CPU budget. Large bodies fall back to a
 * byte-length approximation (never stringify+walk them) — count_tokens only
 * needs a context-budget estimate, ±20% is fine.
 */
const ESTIMATE_WALK_LIMIT = 1_000_000; // chars: beyond this, approximate

export function estimateTokens(jsonStr) {
  const s = String(jsonStr);
  if (s.length > ESTIMATE_WALK_LIMIT) {
    // ~4 chars/token ASCII, CJK denser — the ceiling is enough for budgeting.
    return Math.ceil(s.length / 3);
  }
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other * 1.8);
}


