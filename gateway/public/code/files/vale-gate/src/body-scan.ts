/**
 * Body scanning — the 10ms CPU budget red line.
 *
 * The /v1/* hot path must NEVER fully JSON.parse / re-stringify a multi-MB
 * body (Workers Free plan 10ms CPU budget, Error 1102). This module only
 * provides O(n) raw-string scans: scanTopLevelModel, rawWithModel,
 * estimateTokens. Extracted from index.js (2026-08-12).
 *
 * NO app-level body size limit (round-61): passthrough routes never parse
 * the body, and the scans are bounded by design (2MB sampling window +
 * cheap indexOf image scan) — rejecting large bodies broke legitimate
 * 1M-context requests. The platform's own request-body ceiling is the only
 * bound.
 */

// stage-n body-scan audit (HIGH): cap the char-by-char model scan at a
// fixed ceiling regardless of body size. A multi-MB body walked char-by-char
// blows the Workers Free 10ms CPU budget (Error 1102).
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // 2 MiB

/**
 * Replace the top-level "model" value in a raw JSON body without parsing it.
 * Re-scans for the field's value span (cheap O(n), no object graph) and
 * rebuilds only that slice. Falls back to the unchanged body if the field
 * can't be located. Pass a prior scan result to skip the second pass
 * (round-55: the handler already scanned for routing; re-scanning a multi-MB
 * body just to swap the model doubled the CPU).
 */
export function rawWithModel(
  raw: string,
  newModel: any,
  scanned?: { valueStart: number; valueEnd: number },
) {
  const { valueStart, valueEnd } = scanned || scanTopLevelModel(raw);
  if (valueStart < 0 || valueEnd <= valueStart) return raw;
  return raw.slice(0, valueStart) + JSON.stringify(newModel) + raw.slice(valueEnd);
}

/** Force a top-level JSON object field without parsing the full request body. */
export function rawWithTopLevelField(raw: string, field: string, value: unknown): string {
  const found = scanTopLevelField(raw, field);
  const encoded = JSON.stringify(value);
  if (found) return raw.slice(0, found.valueStart) + encoded + raw.slice(found.valueEnd);
  const close = raw.lastIndexOf("}");
  if (close < 0) return raw;
  const before = raw.slice(0, close).trimEnd();
  const separator = before.endsWith("{") ? "" : ",";
  return before + separator + JSON.stringify(field) + ":" + encoded + raw.slice(close);
}

function scanTopLevelField(
  raw: string,
  field: string,
): { valueStart: number; valueEnd: number } | null {
  let depth = 0;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      const start = i++;
      while (i < raw.length) {
        if (raw[i] === "\\") i += 2;
        else if (raw[i++] === '"') break;
      }
      if (depth === 1 && raw.slice(start + 1, i - 1) === field) {
        while (/\s/.test(raw[i] || "")) i++;
        if (raw[i++] !== ":") continue;
        while (/\s/.test(raw[i] || "")) i++;
        const valueStart = i;
        let braces = 0;
        let inString = false;
        while (i < raw.length) {
          const c = raw[i];
          if (inString) {
            if (c === "\\") i += 2;
            else {
              if (c === '"') inString = false;
              i++;
            }
            continue;
          }
          if (c === '"') {
            inString = true;
            i++;
            continue;
          }
          if (c === "{" || c === "[") braces++;
          else if (c === "}" || c === "]") {
            if (braces === 0) break;
            braces--;
          } else if (braces === 0 && (c === "," || c === "}")) break;
          i++;
        }
        let valueEnd = i;
        while (valueEnd > valueStart && /\s/.test(raw[valueEnd - 1]!)) valueEnd--;
        return { valueStart, valueEnd };
      }
      continue;
    }
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") depth--;
    i++;
  }
  return null;
}

export function rawWithDeepSeekProvider(raw: string): string {
  return rawWithTopLevelField(raw, "provider", { order: ["deepseek"], allow_fallbacks: false });
}

/** Ox Alpha's unified reasoning param: respect a client-sent top-level
 *  "reasoning" field as-is; only when absent default it to effort=max.
 *  (2026-08-22: was an unconditional max override — clients had no say.) */
export function rawWithOxAlphaReasoningDefault(raw: string): string {
  if (scanTopLevelField(raw, "reasoning")) return raw;
  return rawWithTopLevelField(raw, "reasoning", { effort: "max" });
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
export function scanTopLevelModel(raw: string): {
  model: string | null;
  valueStart: number;
  valueEnd: number;
} {
  let i = 0;
  const n = Math.min(raw.length, MAX_SCAN_BYTES); // stage-n: cap scan length
  let depth = 0; // {} and [] nesting — model must sit at depth 0
  let inStr = false;
  let keyStart = -1; // first char of the key text (after its opening quote)
  let keyEnd = -1; // index of the key's closing quote
  let pendingKey = false;
  while (i < n) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") {
        i += 2;
        continue;
      }
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
      if (
        depth === 1 &&
        keyStart >= 0 &&
        keyEnd > keyStart &&
        raw.slice(keyStart, keyEnd) === "model"
      ) {
        // value follows — skip whitespace, expect a string.
        let j = i + 1;
        while (j < n && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\n" || raw[j] === "\r"))
          j += 1;
        if (j < n && raw[j] === '"') {
          const vs = j;
          let k = j + 1;
          let val = "";
          while (k < n) {
            if (raw[k] === "\\") {
              val += raw[k] + (raw[k + 1] || "");
              k += 2;
              continue;
            }
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

// Sampling window: walking every char of a 1M-char body costs ~17ms and alone
// blows the Workers Free 10ms CPU budget (Error 1102). Sampling the first
// ESTIMATE_SAMPLE chars and extrapolating keeps it O(1) with ±20% accuracy —
// which the module's own doc says is fine for a context-budget estimate.
const ESTIMATE_SAMPLE = 128 * 1024; // 128K chars sampled ≈ 1-2ms

export function estimateTokens(jsonStr: any): number {
  // Strip base64 image/document payloads BEFORE estimating: image blocks are
  // ~1.33 chars/byte, so counting them as text overestimated by ~580x — a
  // screenshot-heavy conversation looked far beyond the 1M context and the
  // client rejected requests / compacted prematurely. Each image gets a fixed
  // allowance (~1600 tokens, the real vision cost).
  const s = String(jsonStr);
  const len = s.length;

  // Bound the scan to the last user message (round-340): images only appear
  // in the last user message, so scanning the whole body wastes CPU on
  // multi-MB histories. Find the last "role":"user" and scan from there.
  const USER_ROLE = '"role":"user"';
  const lastUserRole = s.lastIndexOf(USER_ROLE);
  const scanStart = lastUserRole >= 0 ? lastUserRole : 0;

  // Image scan over the bounded region (round-57): counting `"data":"`
  // fields with indexOf jumps is O(n) but far cheaper than the old full-string
  // regex + match passes (a few dozen indexOf hops for real bodies), and it
  // is the ONLY way to see images BEYOND a 2MB sampling window — windowed
  // bodies' tail images were previously charged as text (~280x over the
  // real vision cost) or silently missed.
  let images = 0;
  let removedChars = 0; // ALL base64 chars (the scan sees the whole body)
  let searchFrom = scanStart;
  let idx: number;
  const DATA_KEY = '"data":"';
  // Base64 charset via charCode ranges (round-58): the old per-char regex
  // test on a 12MB all-base64 body was ~12M regex calls — alone enough to
  // eat the 10ms Free-plan budget. Range compares are ~10x faster, same
  // semantics (A-Z a-z 0-9 + / =).
  const isB64 = (c: number) =>
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 43 ||
    c === 47 ||
    c === 61;
  while ((idx = s.indexOf(DATA_KEY, searchFrom)) !== -1) {
    // Only count when it looks like a base64 payload (long alnum run).
    let j = idx + DATA_KEY.length;
    const start = j;
    while (j < len && isB64(s.charCodeAt(j))) j += 1;
    if (j - start >= 512) {
      images += 1;
      removedChars += j - start;
      searchFrom = j;
    } else {
      searchFrom = idx + DATA_KEY.length;
    }
  }

  // Text estimate: subtract ALL base64 bytes (the scan covered the full
  // body) — the per-image 1600 charge replaces them.
  const textLen = len - removedChars;
  if (textLen <= 0) return images * 1600;
  const base = (() => {
    // round-119: the old >ESTIMATE_WALK_LIMIT branch returned
    // Math.ceil(textLen/3) — discarding the CJK-aware sample. A Chinese-
    // heavy body just over 1M chars estimated ~0.33 tokens/char vs the real
    // ~1.8 (~5.4x under): the client's context accounting said it fit, no
    // compaction, then the upstream rejected with request_too_large — and
    // the estimate DROPPED discontinuously (1.78M → 337K) at the boundary.
    // Sampling is bounded (ESTIMATE_SAMPLE head) and cheap at any size, so
    // use it for the large branch too.
    const sample = s.slice(0, Math.min(ESTIMATE_SAMPLE, len));
    const stripped = sample.replace(/"data":"[A-Za-z0-9+/=]{512,}"/g, '"data":"<base64>"');
    let ascii = 0;
    let other = 0;
    for (let i = 0; i < stripped.length; i++) {
      if (stripped.charCodeAt(i) < 128) ascii += 1;
      else other += 1;
    }
    // stripped contains the <base64> markers (18 chars each) — their text
    // density is negligible; extrapolate by the stripped length.
    const r = textLen / stripped.length;
    return Math.ceil((ascii * r) / 4 + other * r * 1.8);
  })();
  return base + images * 1600; // ~1600 tokens per image (real vision cost)
}
