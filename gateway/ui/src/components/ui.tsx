/**
 * Shared UI primitives — the single vocabulary every view renders with.
 * Keeping them here means the markup stays consistent and the CSS for a
 * component lives in exactly one place.
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "../i18n.ts";

/* ── Page header ── */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/* ── Card ── */

export function Card({ title, description, headerExtra, noMargin, children }: {
  title?: ReactNode;
  description?: ReactNode;
  headerExtra?: ReactNode;
  noMargin?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || headerExtra) && (
        <div className={`card-header${noMargin ? " no-margin" : ""}`}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {description && <div className="card-description">{description}</div>}
          </div>
          {headerExtra && <div className="row">{headerExtra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ── Badge ── */

export type BadgeTone = "success" | "error" | "warning" | "info" | "muted";

export function Badge({ tone = "muted", dot, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/* ── Copy button (with transient ✓ feedback + toast hook) ── */

export function CopyButton({ text, label, onCopied, tone = "ghost", small }: {
  text: string;
  label?: string;
  onCopied?: () => void;
  tone?: "primary" | "ghost" | "secondary";
  small?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      onCopied?.();
    } catch {
      /* clipboard unavailable — user selects manually */
    }
  };
  return (
    <button
      className={`btn btn-${tone}${small ? " btn-mini" : ""}`}
      onClick={handle}
      title={text ? undefined : t("token.copyFail")}
    >
      {copied ? "✓" : label ?? t("btn.copy")}
    </button>
  );
}

/* ── Modal ── */

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-card">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Empty state ── */

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/* ── Status chip: neutral pill + small state dot (informational listings) ── */

export function StatusChip({ state, children }: { state: "ok" | "warn" | "err" | "off"; children: ReactNode }) {
  return <span className={`chip ${state}`}><span className="dot" />{children}</span>;
}
