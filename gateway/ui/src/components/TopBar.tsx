import { useTranslation } from "../i18n.ts";

interface TopBarProps {
  panel: string;
}

const PANEL_TITLES: Record<string, string> = {
  overview: "nav.overview",
  keys: "nav.keys",
  routes: "nav.routes",
  users: "nav.users",
  devices: "nav.devices",
};

export default function TopBar({ panel }: TopBarProps) {
  const { t } = useTranslation();
  const key = PANEL_TITLES[panel] || panel;
  return (
    <header className="topbar">
      <h1 className="topbar-title">{t(key as any)}</h1>
    </header>
  );
}
