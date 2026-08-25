/**
 * SSE in-band error guard for passthrough streaming routes.
 *
 * OpenRouter (and gateways like it) sometimes accept a streaming request with
 * HTTP 200 and SSE headers, then fail AFTER the headers are committed: the
 * stream's first meaningful frame is `data: {"error":{"message":"Provider
 * returned error","code":502,...}}`. Forwarding that stream verbatim hands the
 * client an error message with no status digits, which downstream classifiers
 * (DSH's pi-ai adapter) cannot recognize as transient — the turn fails as
 * non-retryable and the session pauses.
 *
 * `peekSseOutcome` inspects the stream BEFORE any byte is forwarded:
 *   - first meaningful frame is a content chunk / finish / [DONE] → the whole
 *     stream is replayed byte-identically (buffered prefix + remainder);
 *   - first meaningful frame is an in-band error object → the outcome is a
 *     structured failure the caller turns into a normal HTTP error carrying
 *     status digits (safe: nothing was sent to the client yet);
 *   - stream closes after only comment/keepalive lines → closed-empty (same
 *     treatment: nothing forwarded, attempt failed).
 *
 * An error frame arriving AFTER content has started is NOT retractable — it is
 * passed through untouched (the client already received partial output).
 */

/** Upper bound on bytes inspected before giving up and passing through. */
const PEEK_CAP_BYTES = 256 * 1024;

export type SsePeek =
  | { kind: "passthrough"; stream: ReadableStream }
  | { kind: "in-band-error"; /** Numeric upstream code when the frame carried one (502/429…). */ status?: number; message: string }
  | { kind: "closed-empty" };

interface ScanResult {
  decision:
    | { verdict: "pending" }
    | { verdict: "passthrough" }
    | { verdict: "in-band-error"; status?: number; message: string }
    | { verdict: "closed-empty" };
}

/** Classify one SSE payload line. Only complete `data:` lines decide anything. */
function classifyDataLine(payload: string): { verdict: "passthrough" } | { verdict: "in-band-error"; status?: number; message: string } {
  if (payload === "[DONE]") return { verdict: "passthrough" };
  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    // Not JSON — be liberal, forward whatever the upstream speaks.
    return { verdict: "passthrough" };
  }
  if (obj && typeof obj === "object" && obj.error !== undefined) {
    const err = obj.error;
    const message =
      (typeof err?.message === "string" && err.message) ||
      (typeof obj.message === "string" && obj.message) ||
      JSON.stringify(err).slice(0, 300) ||
      "upstream in-band error";
    // OpenRouter puts the HTTP-ish code on error.code; some providers use error.status.
    const rawCode = err?.code ?? err?.status;
    const status = typeof rawCode === "number" ? rawCode : undefined;
    return { verdict: "in-band-error", status, message };
  }
  return { verdict: "passthrough" };
}

/**
 * Read the stream until the first decisive event, then either replay it
 * byte-identically or report the pre-content failure.
 */
export async function peekSseOutcome(body: ReadableStream): Promise<SsePeek> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  const decoder = new TextDecoder();
  let decoded = "";
  let scannedUpTo = 0;

  const passthrough = (): SsePeek => {
    const chunks = buffered;
    const rest = reader;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      async pull(controller) {
        try {
          const { done, value } = await rest.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (e) {
          controller.error(e);
        }
      },
      cancel(reason) {
        return rest.cancel(reason);
      },
    });
    return { kind: "passthrough", stream };
  };

  const fail = async (
    outcome: { kind: "in-band-error"; status?: number; message: string } | { kind: "closed-empty" },
  ): Promise<SsePeek> => {
    try {
      await reader.cancel("sse-guard: failing before forwarding");
    } catch {
      /* cancel races the producer's own close */
    }
    return outcome;
  };

  const scanLine = (line: string): ScanResult["decision"] => {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.length === 0 || trimmed.startsWith(":")) return { verdict: "pending" };
    // Known SSE field lines keep the scan pending (waiting for their payload).
    if (/^(?:data|event|id|retry):/.test(trimmed)) {
      if (!trimmed.startsWith("data:")) return { verdict: "pending" };
      const payload = trimmed.slice(5).trim();
      return classifyDataLine(payload);
    }
    // Any other line shape means this body is not SSE at all — the caller's
    // content-type gate let something odd through; pass it through untouched.
    return { verdict: "passthrough" };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush any final partial line the decoder may still hold.
      decoded += decoder.decode();
      const tail = decoded.slice(scannedUpTo);
      if (tail.length > 0) {
        const d = scanLine(tail);
        if (d.verdict === "passthrough") {
          // Either a foreign (non-SSE) one-shot body, or… a frame the peer
          // died inside — indistinguishable here, and forwarding what we got
          // is the honest outcome for the former. The latter only matters
          // when a COMPLETE decisive frame already passed through earlier.
          return passthrough();
        }
        if (d.verdict === "in-band-error") return fail({ kind: "in-band-error", ...d });
      }
      return fail({ kind: "closed-empty" });
    }
    buffered.push(value);
    bufferedBytes += value.byteLength;
    decoded += decoder.decode(value, { stream: true });
    // Scan every COMPLETE line we have not looked at yet.
    let nl: number;
    while ((nl = decoded.indexOf("\n", scannedUpTo)) !== -1) {
      const line = decoded.slice(scannedUpTo, nl);
      scannedUpTo = nl + 1;
      const d = scanLine(line);
      if (d.verdict === "passthrough") return passthrough();
      if (d.verdict === "in-band-error") return fail({ kind: "in-band-error", ...d });
    }
    if (bufferedBytes > PEEK_CAP_BYTES) return passthrough();
  }
}
