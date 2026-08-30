// BrowserPage — the ONE browser entry (round-162/163). The old design had
// two entries (an injected tab-strip session AND this page); the injected
// row is gone — the browser is a page, not a session.
//
// round-163 layout fix: the LIVE VIEW is powered by the agent's bridge
// (port 9224) and is INDEPENDENT of the playwright runner. This page used
// to gate the whole viewport behind the runner status, which hid a working
// stream whenever the runner was stopped. The viewport now always renders;
// the runner gets a compact status chip (Start/Stop) — it controls AI
// automation + the evidence feed, not the live view.
import BrowserPane from "./BrowserPane";
import type { usePlugins } from "../hooks/usePlugins";

interface Props {
  plugins: ReturnType<typeof usePlugins>;
  token: string;
}

export function BrowserPage({ plugins, token }: Props) {
  const pw = plugins.playwright;
  const running = !!pw?.running;
  const pending = pw === null;
  const errored = plugins.playwrightRow?.state === "error";

  return (
    <div className="browser-page">
      <div className="browser-page-status">
        <span className={`bp-dot${running ? " ok" : pending ? "" : errored ? " err" : ""}`} />
        <span className="bp-status-text">
          {pending
            ? "Checking AI runner…"
            : running
              ? `AI runner on${pw?.port ? ` :${pw.port}` : ""}${pw?.started_at ? ` · ${new Date(pw.started_at).toLocaleTimeString()}` : ""}`
              : errored
                ? "AI runner failed — retry?"
                : "AI runner stopped"}
        </span>
        <button
          className="btn btn-ghost btn-mini"
          onClick={running ? plugins.stop : plugins.start}
          disabled={pending || plugins.busy !== null}
          title={running ? "Stop the playwright runner (AI automation)" : "Start the playwright runner (AI automation)"}
        >
          {plugins.busy === "start" ? "Starting…" : running ? "Stop" : errored ? "Retry" : "Start"}
        </button>
      </div>
      <BrowserPane session={{ sid: "browser", url: "", active: true }} apiBase="" token={token} />
    </div>
  );
}
