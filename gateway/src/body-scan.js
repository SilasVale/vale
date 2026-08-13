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
// 12 MB (was 20 MB, round-55): 20 MB bodies were themselves blowing the budget
// on the scan — 10 MB is the practical 1M-context ceiling, 12 MB leaves margin
// without letting a budget-buster through.
export const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MB

/**
 * Replace the top-level "model" value in a raw JSON body without parsing it.
 * Re-scans for the field's value span (cheap O(n), no object graph) and
 * rebuilds only that slice. Falls back to the unchanged body if the field
 * can't be located. Pass a prior scan result to skip the second pass
 * (round-55: the handler already scanned for routing; re-scanning a multi-MB
 * body just to swap the model doubled the CPU).
 */
export function rawWithModel(raw, newModel, scanned) {
  const { valueStart, valueEnd } = scanned || scanTopLevelModel(raw);
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
// Sampling window: walking every char of a 1M-char body costs ~17ms and alone
// blows the Workers Free 10ms CPU budget (Error 1102). Sampling the first
// ESTIMATE_SAMPLE chars and extrapolating keeps it O(1) with ±20% accuracy —
// which the module's own doc says is fine for a context-budget estimate.
const ESTIMATE_SAMPLE = 128 * 1024; // 128K chars sampled ≈ 1-2ms

export function estimateTokens(jsonStr) {
  // Strip base64 image/document payloads BEFORE estimating: image blocks are
  // ~1.33 chars/byte, so counting them as text overestimated by ~580x — a
  // screenshot-heavy conversation looked far beyond the 1M context and the
  // client rejected requests / compacted prematurely. Each image gets a fixed
  // allowance (~1600 tokens, the real vision cost).
  const s = String(jsonStr);
  const len = s.length;
  // CPU budget (round-55): the base64 strip regex walked the WHOLE body —
  // on a 4-10MB body that alone was ~20-60ms of the 10ms Free-plan budget.
  // Bodies over 2 MB get their HEAD stripped + counted and the result
  // extrapolated by length (same sampling stance as the token estimate).
  const str = len > 2_000_000 ? s.slice(0, 2_000_000) : s;
  const sampledLen = str.length;
  let images = 0;
  const stripped = str.replace(/"data":"[A-Za-z0-9+/=]{512,}"/g, () => {
    images += 1;
    return '"data":"<base64>"';
  });
  const ratio = len / sampledLen;
  const base = (() => {
    if (len > ESTIMATE_WALK_LIMIT) {
      // ~4 chars/token ASCII, CJK denser — the ceiling is enough for budgeting.
      return Math.ceil(len / 3);
    }
    if (len > ESTIMATE_SAMPLE) {
      // Sample the head (model + system prompt live there) and extrapolate.
      let ascii = 0;
      let other = 0;
      const n = Math.min(ESTIMATE_SAMPLE, sampledLen);
      for (let i = 0; i < n; i++) {
        if (stripped.charCodeAt(i) < 128) ascii += 1;
        else other += 1;
      }
      const r = len / n;
      return Math.ceil((ascii * r) / 4 + (other * r) * 1.8);
    }
    let ascii = 0;
    let other = 0;
    for (const ch of stripped) {
      if (ch.charCodeAt(0) < 128) ascii += 1;
      else other += 1;
    }
    return Math.ceil(ascii / 4 + other * 1.8);
  })();
  // Image count from the head, scaled (ratio is 1 when no windowing applied).
  // round-56 fix: with a >2MB window the old code charged the window's tail
  // (base64 bytes beyond the window) as TEXT — a 1.3MB screenshot was ~440k
  // tokens instead of 1600 (~280x). Scale the head's image count to the full
  // body: base64 images outside the window are then charged per-image, not
  // as text. (Text outside the window is still approximated by len/3 when
  // len > ESTIMATE_WALK_LIMIT — the ±20% stance of the module doc.)
  const imagesFull = Math.max(images, Math.round(images * ratio));
  return base + imagesFull * 1600; // ~1600 tokens per image
}


