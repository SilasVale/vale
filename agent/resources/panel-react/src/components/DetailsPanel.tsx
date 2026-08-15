import { useEffect, useRef } from "react";
import type { CommandCard as CardData } from "../hooks/useCommandEvents";
import { CopyButton, cardState, fmtDuration } from "./CommandCard";

// Details column (round-admin-ui Task 4): the dsh single-call inspector —
// selected command card's parameters (the command/start payload, JsonTree
// style), full output, exit code / reason / duration. All text renders
// TEXT-ONLY (React text nodes, never innerHTML).
export function DetailsPanel({ card, onClose }: { card: CardData | null; onClose: () => void }) {
  return (
    <>
      <div className="details-header">
        <h2 className="details-title">Details</h2>
        <button className="details-close" title="Close details" onClick={onClose}>✕</button>
      </div>
      <div className="details-body">
        {card ? <CardDetails card={card} /> : (
          <p className="details-empty">Select a command card to inspect its parameters, output, and exit code.</p>
        )}
      </div>
    </>
  );
}

function CardDetails({ card }: { card: CardData }) {
  const st = cardState(card);
  const outRef = useRef<HTMLPreElement>(null);
  const prevLen = useRef(card.output.length);
  // Follow the live output while the selected command is running.
  useEffect(() => {
    if (!card.ended && outRef.current && card.output.length > prevLen.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
    prevLen.current = card.output.length;
  }, [card.output, card.ended]);

  const duration = card.ended ? fmtDuration(card.durationMs) : fmtDuration(Date.now() - card.startedAt * 1000);
  const started = new Date(card.startedAt * 1000).toLocaleTimeString();
  // Parameters: the command/start payload (JsonTree style, text-only rows).
  const params: [string, unknown][] = [
    ["command", card.command],
    ["seq", card.seq],
    ["started_at", card.startedAt],
  ];

  return (
    <div className="details-content">
      <div>
        <div className="details-block-label">Command</div>
        <p className="details-cmd">{card.command}</p>
      </div>
      <div className="details-meta">
        <span className="details-meta-label">Status</span>
        <span className="details-meta-value">
          <span className="cmd-dot" data-state={st.state} />
          {st.label}
        </span>
        <span className="details-meta-label">Exit code</span>
        <span className="details-meta-value">{card.exitCode !== null ? card.exitCode : "—"}</span>
        <span className="details-meta-label">Reason</span>
        <span className="details-meta-value">{card.reason || "—"}</span>
        <span className="details-meta-label">Duration</span>
        <span className="details-meta-value">{duration || "—"}</span>
        <span className="details-meta-label">Started</span>
        <span className="details-meta-value">{started}</span>
      </div>
      <div>
        <div className="details-block-label">Parameters</div>
        <div className="details-json">
          {params.map(([k, v]) => (
            <div key={k} className="details-json-row">
              <span className="details-json-key">{k}:</span>
              <span className="details-json-val">{JSON.stringify(v)}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="details-block-head">
          <div className="details-block-label">Output</div>
          <CopyButton text={card.output} title="Copy output" />
        </div>
        <pre className="details-output" ref={outRef}>{card.output || "(no output)"}</pre>
      </div>
    </div>
  );
}
