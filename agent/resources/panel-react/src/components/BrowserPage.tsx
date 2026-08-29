// BrowserPage — the ONE browser entry (round-162). The old design had two:
// an injected "Browser" row in the terminal tab strip AND this page, which
// read as a confusing duplicate ("why is browser also a session?"). The
// injected row is gone — the browser is a page, not a session.
//
// The page is STATE-AWARE: playwright-mcp behind it is an on-demand process,
// so a stopped state renders an inline Start card (the old UI showed a dead
// black viewport with the Start button buried in the Plugins page). Running
// state shows a compact status chip with an inline Stop.
import { Icon } from "../ui/Icon";
import BrowserPane from "./BrowserPane";
import type { usePlugins } from "../hooks/usePlugins";

interface Props {
  plugins: ReturnType<typeof usePlugins>;
  token: string;
}

export function BrowserPage({ plugins, token }: Props) {
  const pw = plugins.playwright;
  const running = !!pw?.running;

  if (running) {
    return (
      <div className="browser-page running">
        <div className="browser-page-status">
          <span className="bp-dot ok" />
          <span className="bp-status-text">
            Playwright running{pw?.port ? ` · port ${pw.port}` : ""}
            {pw?.started_at ? ` · since ${new Date(pw.started_at).toLocaleTimeString()}` : ""}
          </span>
          <button
            className="btn btn-ghost btn-mini"
            onClick={plugins.stop}
            disabled={plugins.busy !== null}
            title="Stop the playwright runner"
          >Stop</button>
        </div>
        <BrowserPane session={{ sid: "browser", url: "", active: true }} apiBase="" token={token} />
      </div>
    );
  }

  // Stopped / error / first status poll still pending → a state card instead
  // of a dead viewport. `playwright === null` = poll hasn't landed yet.
  const pending = pw === null;
  const errored = plugins.playwrightRow?.state === "error";

  return (
    <div className="browser-page stopped">
      <div className="browser-boot-card">
        <div className="browser-boot-icon"><Icon name="browser" size={34} /></div>
        <h2>{pending ? "Checking browser runner…" : errored ? "Browser runner failed" : "Browser is not running"}</h2>
        <p className="browser-boot-sub">
          {pending
            ? "Talking to the agent to get the playwright status."
            : errored
              ? "The last start attempt failed. Retry below — the agent error body lands in Plugins."
              : "The playwright runner is a start-on-demand process. Start it here, then the live viewport, tabs, and AI evidence all come online in one place."}
        </p>
        {!pending && (
          <button
            className="btn btn-primary browser-boot-start"
            onClick={plugins.start}
            disabled={plugins.busy !== null}
          >
            {plugins.busy === "start" ? "Starting…" : errored ? "Retry start" : "Start browser"}
          </button>
        )}
        {plugins.loadError && <div className="browser-boot-err">{plugins.loadError}</div>}
      </div>
    </div>
  );
}
