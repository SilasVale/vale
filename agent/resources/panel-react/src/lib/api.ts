// Transport layer — migrated from the original panel.js callApi/callTool.
// Every device request carries Authorization: Bearer <token>; a 401 triggers
// the onUnauthorized callback (the UI drops back to the connection form).

let hostname = "";
let token = "";
let onUnauthorizedCb: (() => void) | null = null;

export function initTransport(host: string, tok: string, on401: () => void) {
  hostname = host;
  token = tok;
  onUnauthorizedCb = on401;
}
export function hasTransport() { return !!hostname && !!token; }
export function getHost() { return hostname; }

/** Fetch a path on the device with the bearer token. Returns parsed JSON. */
export async function callApi(path: string, init: RequestInit = {}): Promise<any> {
  // round-107: the protocol was hardcoded https:// — the loopback on-device
  // panel (http://127.0.0.1:18080/panel) could never reach the agent.
  const proto = window.location.protocol === "http:" ? "http:" : "https:";
  const res = await fetch(`${proto}//${hostname}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    onUnauthorizedCb?.();
    throw new Error("unauthorized");
  }
  // round-86: a transient 502/500 must THROW — the old code returned the
  // error body as a successful result, so the poll mapped its characters
  // into junk sessions (sid: undefined) and tombstoned the list.
  if (!res.ok) {
    // round-86: a transient 502/500 must THROW — the old code returned the
    // error body as a successful result, so the poll mapped its characters
    // into junk sessions (sid: undefined) and tombstoned the list.
    // Agent error bodies ({ok:false,error}) carry the actionable message
    // (e.g. a playwright spawn failure) — surface it verbatim when the body
    // is parseable JSON; otherwise keep the HTTP status.
    let detail = "";
    try {
      const body = await res.text();
      if (body) {
        const j = JSON.parse(body);
        if (j && typeof j.error === "string") detail = j.error;
      }
    } catch { /* non-JSON error body — the HTTP status is the message */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

/** Call a device tool (POST /api/tools/{name}). */
export async function callTool(name: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await callApi(`/api/tools/${name}`, { method: "POST", body: JSON.stringify(body) });
  // The agent returns tool errors as HTTP 200 + {ok:false,error:...}.
  if (res && typeof res === "object" && res.ok === false) throw new Error(res.error || `tool ${name} failed`);
  if (res && typeof res === "object" && "result" in res) return res.result;
  return res;
}
