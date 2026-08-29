import { Component, type ReactNode } from "react";

// App-level error boundary (round-161): a crash in any page used to unmount
// the whole React tree — a silent white panel with no hint. Show an error
// card with a reload button instead. Reloading is always safe: terminal
// sessions live in the agent service, not in this window.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    try {
      console.error("[vale] render crash:", error, info?.componentStack || "");
    } catch { /* console unavailable */ }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-crash">
          <div className="app-crash-card">
            <div className="app-crash-mark">V</div>
            <h1>Something broke</h1>
            <p className="muted">{this.state.error.message || "Render error"}</p>
            <button
              className="btn"
              onClick={() => {
                this.setState({ error: null });
                location.reload();
              }}
            >
              Reload panel
            </button>
            <p className="hint">The agent service keeps terminal sessions alive — reloading is safe.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
