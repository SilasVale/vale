// IconRail — shared by both densities: brand mark on top, 5 page icons,
// connection dot pinned to the foot. Uses the unified ui/Icon set.
//
// The foot dot reports the DEVICE state, not just connectivity: offline (no
// agent), idle (connected, nothing happening), working (activity within the
// last few seconds — see useDeviceActivity). Both densities render the same
// three states, because "is this machine busy" is a property of the machine and
// not of which shell is showing it.
import { useState } from "react";
import { Icon, BrandMark, type IconName } from "../ui/Icon";
import { getTheme, toggleTheme } from "../lib/theme";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
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
  const working = useDeviceActivity();
  const state = !connected ? "off" : working ? "working" : "idle";
  const label = !connected
    ? "disconnected"
    : working
      ? "device is working"
      : "device is idle";
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
          aria-current={page === p ? "page" : undefined}
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
          {/* data-state drives the colour in CSS (off / idle / working) — the
              same three-value vocabulary the panel dot uses, so the two
              densities cannot drift apart. */}
          <div className="desktop-rail-status" data-state={state} title={label}>
            <span className="dot" />
          </div>
        </>
      ) : (
        <div className="rail-spacer" />
      )}
      {!desktop && <div className="rail-dot" data-state={state} title={label} />}
    </>
  );
}
