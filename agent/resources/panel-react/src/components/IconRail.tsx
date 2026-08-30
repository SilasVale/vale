// IconRail — shared by both densities: brand mark on top, 5 page icons,
// connection dot pinned to the foot. Uses the unified ui/Icon set.
import { useState } from "react";
import { Icon, BrandMark, type IconName } from "../ui/Icon";
import { getTheme, toggleTheme } from "../lib/theme";
import type { Page } from "./Shell";

const PAGE_ICONS: Record<Page, IconName> = {
  terminal: "terminal",
  browser: "browser",
  memory: "memory",
  plugins: "plugins",
  settings: "settings",
};

export function IconRail({ page, onPageChange, connected, desktop }: {
  page: Page;
  onPageChange: (p: Page) => void;
  connected: boolean;
  desktop?: boolean;
}) {
  const btn = (active: boolean) => (desktop ? `desktop-rail-btn${active ? " active" : ""}` : `rail-btn${active ? " active" : ""}`);
  const [theme, setThemeState] = useState(getTheme());
  const themeBtnClass = desktop ? "desktop-rail-btn" : "rail-btn";
  const flipTheme = () => setThemeState(toggleTheme());
  return (
    <>
      {desktop ? (
        <div className="desktop-rail-brand" title="Vale"><BrandMark size={26} /></div>
      ) : (
        <div className="rail-brand" title="Vale"><BrandMark size={20} /></div>
      )}
      {(Object.keys(PAGE_ICONS) as Page[]).map((p) => (
        <button
          key={p}
          type="button"
          className={btn(page === p)}
          title={p[0].toUpperCase() + p.slice(1)}
          aria-label={p[0].toUpperCase() + p.slice(1)}
          onClick={() => onPageChange(p)}
        >
          <Icon name={PAGE_ICONS[p]} size={desktop ? 18 : 20} />
        </button>
      ))}
      {/* theme toggle — light is the default; dark is the optional cockpit */}
      <button
        type="button"
        className={themeBtnClass}
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        aria-label="theme"
        onClick={flipTheme}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={desktop ? 16 : 18} />
      </button>
      {desktop ? (
        <>
          <div className={`desktop-rail-status ${connected ? "ok" : ""}`} title={connected ? "agent connected" : "connecting"}>
            <span className="dot" />
          </div>
        </>
      ) : (
        <div className="rail-spacer" />
      )}
      {!desktop && <div className={`rail-dot${connected ? " on" : ""}`} title={connected ? "connected" : "disconnected"} />}
    </>
  );
}
