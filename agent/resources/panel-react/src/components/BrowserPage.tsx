// BrowserPage — the ONE browser entry (round-162/163). The old design had
// two entries (an injected tab-strip session AND this page); the injected
// row is gone — the browser is a page, not a session.
//
// round-163 layout fix: the LIVE VIEW is powered by the agent's bridge
// (port 9224) and is INDEPENDENT of the playwright runner. This page used
// to gate the whole viewport behind the runner status, which hid a working
// stream whenever the runner was stopped. The viewport now always renders.
//
// round-refactor: the runner (playwright-mcp, AI automation + evidence feed)
// no longer owns a full status bar across the top of the page — it shrinks
// to a compact chip in BrowserPane's view-switch row, so the page reads as a
// browser (tabs + URL + live view), not as a service dashboard.
import BrowserPane from "./BrowserPane";
import { EmbeddedBrowserPane } from "./EmbeddedBrowserPane";
import type { usePlugins } from "../hooks/usePlugins";

interface Props {
  plugins: ReturnType<typeof usePlugins>;
  token: string;
}

export function BrowserPage({ plugins, token }: Props) {
  // round-246: in the Electron shell the main process embeds a REAL
  // WebContentsView (window.valeEmbedded) — render the controller for it
  // instead of the JPEG screencast pane. Plain browsers keep the stream.
  const embedded = !!((window as any).valeEmbedded);
  if (embedded) {
    return (
      <div className="browser-page">
        <EmbeddedBrowserPane token={token} />
      </div>
    );
  }
  const pw = plugins.playwright;
  const running = !!pw?.running;
  const pending = pw === null;
  const errored = plugins.playwrightRow?.state === "error";

  return (
    <div className="browser-page">
      <BrowserPane
        session={{ sid: "browser", url: "", active: true }}
        apiBase=""
        token={token}
        runner={{
          running,
          pending,
          errored,
          busy: plugins.busy,
          onToggle: () => (running ? plugins.stop() : plugins.start()),
        }}
      />
    </div>
  );
}
