import { useEffect, useRef, useState } from "react";
import type { CommandCard as CardData } from "../hooks/useCommandEvents";
import { Icon } from "../ui/Icon";

// dsh ToolCallTree-style command card (round-admin-ui Task 4): StateDot +
// command + live output (TEXT-ONLY — never innerHTML; React text nodes are
// the only content that reaches the DOM here) + exit code + duration +
// expand/copy. Clicking the card head selects it (opens the details column);
// the chevron + copy are separate buttons so selection and expansion don't
// collide.

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) {
    const s = Math.round((ms % 60_000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Card state → dsh StateDot/badge state + labels (shared by card + details). */
export function cardState(card: CardData): { state: "running" | "ok" | "fail" | "warn" | "muted"; label: string; compact: string } {
  if (!card.ended) return { state: "running", label: "Running", compact: "running" };
  if (card.exitCode !== null) {
    return card.exitCode === 0
      ? { state: "ok", label: "Success (exit 0)", compact: "0" }
      : { state: "fail", label: `Failed (exit ${card.exitCode})`, compact: `exit ${card.exitCode}` };
  }
  switch (card.reason) {
    case "backgrounded": return { state: "warn", label: "Backgrounded", compact: "backgrounded" };
    case "interrupted": return { state: "warn", label: "Interrupted", compact: "interrupted" };
    case "closed": return { state: "muted", label: "Closed", compact: "closed" };
    default: return { state: "muted", label: card.reason || "Ended", compact: card.reason || "ended" };
  }
}

/** Copy with a clipboard-API fallback (the LAN panel may not be a secure
 *  context, where navigator.clipboard is undefined). */
function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {});
  }
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
    resolve();
  });
}

export function CopyButton({ text, title = "Copy output" }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button className={`cmd-btn cmd-copy${copied ? " copied" : ""}`} title={title} onClick={onCopy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CommandCard({ card, selected, onSelect }: {
  card: CardData;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const st = cardState(card);
  // Auto-expand while running (dsh streams the live call); once seen, the
  // expansion STICKS so a finishing command doesn't snap closed. A manual
  // toggle overrides. round-161: the "seen" set is updated in an EFFECT —
  // the old code mutated a ref DURING RENDER (React anti-pattern, breaks
  // under concurrent rendering).
  const [autoSeen, setAutoSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!card.ended && !autoSeen.has(card.id)) {
      setAutoSeen((prev) => { const next = new Set(prev); next.add(card.id); return next; });
    }
  }, [card.ended, card.id, autoSeen]);
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const expanded = override[card.id] !== undefined ? override[card.id] : autoSeen.has(card.id);
  const outRef = useRef<HTMLPreElement>(null);
  const prevLen = useRef(card.output.length);

  // Follow the live output: scroll the running card's block to the bottom
  // when new text arrives (its own container — the list scroll is untouched).
  useEffect(() => {
    if (expanded && !card.ended && outRef.current && card.output.length > prevLen.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
    prevLen.current = card.output.length;
  }, [card.output, expanded, card.ended]);

  const duration = card.ended ? fmtDuration(card.durationMs) : fmtDuration(Date.now() - card.startedAt * 1000);

  return (
    <div className={`cmd-card${selected ? " selected" : ""}`}>
      <div
        className="cmd-card-head"
        role="button"
        tabIndex={0}
        title={selected ? "Close details" : "Show details"}
        onClick={() => onSelect(card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(card.id);
          }
        }}
      >
        <span className="cmd-dot" data-state={st.state} />
        <span className="cmd-name" title={card.command}>{card.command}</span>
        {duration && <span className="cmd-duration">{duration}</span>}
        <span className="cmd-badge" data-state={st.state}>{st.compact}</span>
        <button
          className={`cmd-btn cmd-toggle${expanded ? " open" : ""}`}
          title={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            setOverride((o) => ({ ...o, [card.id]: !expanded }));
          }}
        >
          <Icon name="chevron" size={12} />
        </button>
        <CopyButton text={card.output} />
      </div>
      {expanded && (
        <pre className="cmd-out" ref={outRef}>{card.output || "(no output)"}</pre>
      )}
    </div>
  );
}

/** The command card stream — rendered below the terminal pane. Height is
 *  RESERVED (fixed, see #cmd-stream CSS) so the xterm container above keeps
 *  a stable height from mount and never needs a refit when cards appear. */
export function CommandStream({ cards, selectedId, onSelect }: {
  cards: CardData[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastIds = useRef("");
  // Follow the stream: when a NEW running card appears, scroll the list to
  // the bottom (new commands are what the operator is watching).
  useEffect(() => {
    const ids = cards.map((c) => c.id).join(",");
    if (ids !== lastIds.current && listRef.current) {
      const newest = cards[cards.length - 1];
      if (newest && !newest.ended) listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    lastIds.current = ids;
  }, [cards]);

  return (
    <div id="cmd-stream">
      <div className="cmd-stream-header">
        <span className="cmd-stream-title">Commands</span>
        <span className="cmd-stream-count">{cards.length}</span>
      </div>
      <div className="cmd-list" ref={listRef}>
        {cards.length === 0 ? (
          <p className="cmd-empty">Commands run in this session appear here.</p>
        ) : cards.map((c) => (
          <CommandCard key={c.id} card={c} selected={c.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
