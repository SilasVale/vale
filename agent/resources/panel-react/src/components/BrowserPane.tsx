/**
 * BrowserPane — renders a headless browser session as a live screenshot.
 *
 * Unlike terminal sessions (xterm.js character grid), browser sessions show
 * a visual preview of the page the AI is interacting with. Screenshots are
 * captured after each browser action and streamed to this component.
 */
import { useState, useEffect, useCallback, useRef } from "react";

export interface BrowserSessionData {
  sid: string;
  url: string;
  active: boolean;
}

interface Props {
  session: BrowserSessionData;
  apiBase: string; // e.g. "" (same-origin) or gateway proxy base
  token: string;
}

export default function BrowserPane({ session, apiBase, token }: Props) {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [url, setUrl] = useState(session.url || "about:blank");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const capture = useCallback(async () => {
    if (!session.active) return;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/tools/mcp_client_call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tool: "browser_take_screenshot", arguments: {} }),
      });
      const data = await res.json();
      if (data.ok && data.result) {
        // playwright returns base64 PNG in content[0].text or data.content
        const b64 = typeof data.result === "string"
          ? data.result.replace(/^data:image\/png;base64,/, "")
          : data.result?.content?.find((c: any) => c.type === "image")?.data ?? "";
        if (b64) setScreenshot(`data:image/png;base64,${b64}`);
      }
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [session.active, token, apiBase]);

  const navigate = useCallback(async (targetUrl: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase}/api/tools/mcp_client_call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tool: "browser_navigate", arguments: { url: targetUrl } }),
      });
      setUrl(targetUrl);
      setTimeout(capture, 1000); // wait for page load then screenshot
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [capture, token, apiBase]);

  // Auto-capture every 3s while active
  useEffect(() => {
    if (!session.active) return;
    capture();
    intervalRef.current = setInterval(capture, 3000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [session.active, capture]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 0 }}>
      {/* URL bar */}
      <div style={{ display: "flex", gap: 6, padding: "6px 10px", background: "#f8f9fa", borderBottom: "1px solid #dee2e6" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate(url)}
          placeholder="Enter URL..."
          style={{ flex: 1, padding: "5px 8px", border: "1px solid #ced4da", borderRadius: 6, fontSize: 12 }}
        />
        <button onClick={() => navigate(url)} style={{ padding: "4px 10px", cursor: "pointer" }}>Go</button>
        <button onClick={capture} title="Refresh screenshot" style={{ padding: "4px 8px", cursor: "pointer" }}>⟳</button>
      </div>

      {/* Screenshot viewport */}
      <div style={{ flex: 1, overflow: "auto", background: "#1a1b1e", position: "relative" }}>
        {screenshot ? (
          <img src={screenshot} alt="Browser preview" style={{ width: "100%", display: "block" }} />
        ) : (
          <div style={{ color: "#6b7280", textAlign: "center", paddingTop: 40 }}>
            {loading ? "Loading..." : "No screenshot yet"}
          </div>
        )}
      </div>

      {error && <div style={{ color: "#dc2626", fontSize: 11, padding: "4px 8px" }}>{error}</div>}
    </div>
  );
}
