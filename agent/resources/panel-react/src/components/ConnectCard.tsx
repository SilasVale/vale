// ConnectCard — the panel's AI-client onboarding (game-design proposal §4).
//
// WHY THIS EXISTS. Measured: the panel had ZERO onboarding for AI clients. A
// new user installs Vale, opens the panel, and sees a terminal. The product's
// promise — "AI can drive this machine" — is invisible until an external client
// is configured by hand, and nothing in the UI helped configure one. In game
// terms: no tutorial, and the game does not start until you edit a config file.
//
// The card does three things, in the order a new user needs them:
//   1. says WHAT this machine can be asked to do (the tool surface, grouped)
//   2. hands over the exact config for the user's AI client (generated from
//      the LIVE host and token, so it cannot be stale)
//   3. proves the connection actually works, on the spot
//
// SECURITY NOTE. The token is real and the panel already holds it (it IS the
// transport credential — see lib/boot.ts). Showing it here is the same
// deliberate, explicit-intent trade the gateway console already makes for BYOK
// keys: it is masked by default, revealed only on request, and the whole point
// of the card is to put it in the user's own client config. It is never put in
// a URL (ADR 0004) and never logged.

import { releaseVersionLabel } from "../lib/agentVersion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callApi, getHost, getToken } from "../lib/api";
import { copyText } from "../lib/clipboard";

/** One client the user might be connecting. `json` builds the snippet; the
 *  field paths differ per client, which is the only reason this is a table. */
interface ClientSpec {
  id: string;
  label: string;
  /** Where the snippet goes — the single most common source of "it didn't
   *  work" for a hand-rolled config, so it is stated rather than assumed. */
  where: string;
  build: (url: string, token: string) => string;
}

const CLIENTS: ClientSpec[] = [
  {
    id: "dsh",
    label: "DSH",
    where: "~/.dsh/mcp.json (or the Harness MCP settings)",
    build: (url, token) =>
      JSON.stringify(
        {
          mcpServers: {
            vale: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: "claude",
    label: "Claude Code",
    where:
      'claude mcp add --transport http vale <url> --header "Authorization: Bearer <token>"',
    build: (url, token) =>
      `claude mcp add --transport http vale ${url} \\\n  --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "curl",
    label: "curl (a quick check)",
    where: "any shell — this is the raw protocol, no client needed",
    build: (url, token) =>
      `curl -sS ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
];

/** Tool families, in the order a newcomer should meet them. Anything not
 *  listed still counts toward the total — this is a summary, not a registry. */
const FAMILIES: Array<{ prefix: string; label: string; blurb: string }> = [
  {
    prefix: "terminal_",
    label: "Terminal",
    blurb:
      "PTY / SSH / serial sessions — run commands, read output, drive hardware consoles",
  },
  {
    prefix: "system_",
    label: "System",
    blurb: "files, processes, network reachability",
  },
  {
    prefix: "browser_",
    label: "Browser",
    blurb: "a real browser the AI and you both watch",
  },
  {
    prefix: "memory_",
    label: "Memory",
    blurb: "device-local knowledge shared across AI clients",
  },
  {
    prefix: "mcp_client_",
    label: "MCP bridge",
    blurb: "connect further MCP servers",
  },
];

type Probe = { state: "idle" | "running" | "ok" | "fail"; detail?: string };

export function ConnectCard() {
  const [tools, setTools] = useState<string[] | null>(null);
  const [client, setClient] = useState<string>(CLIENTS[0].id);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  // The device's MCP endpoint. Built from the LIVE location rather than a
  // configured value: whatever host the operator reached this panel on is, by
  // definition, a host their AI client can reach too. A hardcoded value here
  // would be wrong for every remote/tunnel user.
  const mcpUrl = useMemo(() => `${location.protocol}//${getHost()}/mcp`, []);
  const token = getToken();

  useEffect(() => {
    let alive = true;
    callApi("/api/spec")
      .then((spec) => {
        if (!alive) return;
        const names: string[] = [];
        for (const p of spec?.plugins ?? []) {
          for (const t of p?.tools ?? []) if (t?.name) names.push(t.name);
        }
        setTools(names);
      })
      .catch(() => {
        if (alive) setTools([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const snippet = useMemo(() => {
    const spec = CLIENTS.find((c) => c.id === client) ?? CLIENTS[0];
    // Masked by default. A placeholder (not a redaction) so the snippet stays
    // copy-pasteable once revealed, and so a user who copies without revealing
    // gets an obviously-incomplete config rather than a silently broken one.
    return spec.build(mcpUrl, revealed ? token : "<your-device-token>");
  }, [client, mcpUrl, token, revealed]);

  const where = (CLIENTS.find((c) => c.id === client) ?? CLIENTS[0]).where;

  const doCopy = useCallback((what: string, text: string) => {
    copyText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
    });
  }, []);

  /** Self-test: hit the authenticated status endpoint with the SAME token the
   *  snippet carries. Proves the credential works, which is the part users get
   *  wrong — a config can be syntactically perfect and still 401. */
  const runProbe = useCallback(() => {
    setProbe({ state: "running" });
    callApi("/api/status")
      .then((s) =>
        setProbe({
          state: "ok",
          // The RELEASE, not the frozen Cargo protocol version — see
          // lib/agentVersion.ts. This probe reported v1.0.145 from Settings while the
          // status strip said v1.2.354 for the same device.
          detail: `${releaseVersionLabel(s)} · ${s?.live_sessions ?? 0} live session(s)`,
        }),
      )
      .catch((e) =>
        setProbe({ state: "fail", detail: String(e?.message ?? e) }),
      );
  }, []);

  const counts = useMemo(() => {
    const out: Array<{ label: string; blurb: string; n: number }> = [];
    let claimed = 0;
    for (const f of FAMILIES) {
      const n = (tools ?? []).filter((t) => t.startsWith(f.prefix)).length;
      claimed += n;
      if (n > 0) out.push({ label: f.label, blurb: f.blurb, n });
    }
    const rest = (tools?.length ?? 0) - claimed;
    if (rest > 0)
      out.push({ label: "Other", blurb: "updates, page inspection", n: rest });
    return out;
  }, [tools]);

  return (
    <>
      <div className="settings-section">
        <h3>Connect an AI client</h3>
        <p className="connect-lede">
          This panel is the <b>human</b> view of the machine. AI clients drive
          it over MCP — point one here and it can operate this device with the
          tools below.
        </p>

        {tools === null ? (
          <p className="connect-muted">Reading the tool surface…</p>
        ) : tools.length === 0 ? (
          <p className="connect-muted">
            Could not read the tool surface from this agent.
          </p>
        ) : (
          <>
            <div className="connect-total">
              <b>{tools.length}</b> tools available on this device
            </div>
            <ul className="connect-families">
              {counts.map((c) => (
                <li key={c.label}>
                  <span className="connect-fam-label">{c.label}</span>
                  <span className="connect-fam-n">{c.n}</span>
                  <span className="connect-fam-blurb">{c.blurb}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="settings-section">
        <h3>Give it to your client</h3>
        <div className="connect-tabs">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`connect-tab${c.id === client ? " on" : ""}`}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="connect-where">{where}</p>
        <pre className="connect-snippet">{snippet}</pre>
        <div className="settings-actions connect-actions">
          <button type="button" onClick={() => setRevealed((r) => !r)}>
            {revealed ? "Hide token" : "Reveal token"}
          </button>
          <button type="button" onClick={() => doCopy("snippet", snippet)}>
            {copied === "snippet" ? "Copied" : "Copy config"}
          </button>
          <button
            type="button"
            onClick={runProbe}
            disabled={probe.state === "running"}
          >
            {probe.state === "running" ? "Testing…" : "Test this credential"}
          </button>
        </div>
        {probe.state === "ok" && (
          <p className="connect-probe ok">Connected — {probe.detail}</p>
        )}
        {probe.state === "fail" && (
          <p className="connect-probe fail">Failed — {probe.detail}</p>
        )}
        <p className="connect-muted connect-foot">
          The token is this device's own credential. Anyone holding it can drive
          the machine, so treat the config like a password.
        </p>
      </div>
    </>
  );
}
