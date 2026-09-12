// DeviceLogsCard — the device's OWN logs, and the update verdict they answer.
//
// WHY THIS EXISTS. `GET /api/logs` was built to let a remote client see why the
// agent behaved oddly "without asking someone to open files (or guessing a path
// and cat-ing it over a PTY)" — and then NOTHING consumed it. Same shape as
// `/api/sessions` before the Archive page: a served route with no reader.
//
// The concrete thing it unblocks is the question the release docs answer with a
// four-way table: after `vale update` the connection ALWAYS drops for ~10s, and
// that drop is the documented signature of a successful swap — which makes it
// useless as evidence, because a command that never arrived looks identical. The
// only honest answer is the log, and reading it meant a Get-Content on the box.
//
// It is a DIAGNOSTIC, not a control: nothing here updates anything. The update
// still happens through the CLI or the console.
import { useEffect, useState } from "react";
import { callApi } from "../lib/api";
import { diagnoseUpdate, type UpdateDiagnosis } from "../lib/updateDiagnosis";

interface LogFile {
  name: string;
  /** FALSE means the agent never wrote this file — a different fact from an
   *  empty one, and the route distinguishes them on purpose. */
  present: boolean;
  log: string;
}

const VERDICT_TONE: Record<UpdateDiagnosis["verdict"], string> = {
  "cli-swap-launched": "ok",
  "rust-swap": "ok",
  "cli-only": "warn",
  "never-arrived": "warn",
  "no-log": "quiet",
};

export function DeviceLogsCard() {
  const [logs, setLogs] = useState<LogFile[] | null>(null);
  const [dir, setDir] = useState<string>("");
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    callApi("/api/logs")
      .then((r) => {
        if (!alive) return;
        // A DEVICE THAT ANSWERED "NO" DID NOT GIVE US LOGS. Checking only the
        // rejection meant a `{ok:false}` body fell through to `setLogs([])`,
        // which renders exactly like a healthy device that has written nothing —
        // a claim about the device made from a response that refused to make it.
        // The route's contract is `ok:true` plus a `logs` array; anything else is
        // a failure to report, not an empty result to draw.
        if (r?.ok !== true || !Array.isArray(r.logs)) {
          setFailed(true);
          return;
        }
        setLogs(r.logs as LogFile[]);
        setDir(typeof r?.dir === "string" ? r.dir : "");
      })
      // A FAILED read says so. Rendering "no logs" for an unreachable device
      // would be a claim about the device, and it is not one we can make.
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const update = logs?.find((l) => l.name === "vale-update.log");
  const d = diagnoseUpdate(update ? update.log : null);

  return (
    <div className="settings-section">
      <h3>Device logs</h3>
      {failed ? (
        <p className="muted">
          The device did not answer, so its logs could not be read. This is not the same
          as a device with no logs.
        </p>
      ) : logs === null ? (
        <p className="muted">Reading the device's logs…</p>
      ) : (
        <>
          <p className={`device-logs-verdict device-logs-verdict-${VERDICT_TONE[d.verdict]}`} data-verdict={d.verdict}>
            {d.summary}
          </p>
          {d.receipt && <p className="device-logs-receipt">{d.receipt}</p>}
          {dir && <p className="muted device-logs-dir">Read from {dir}</p>}
          <div className="device-logs-list">
            {logs.map((l) => (
              <div key={l.name} className="device-logs-file">
                <button
                  type="button"
                  className="device-logs-toggle"
                  onClick={() => setOpen((cur) => (cur === l.name ? null : l.name))}
                  aria-expanded={open === l.name}
                >
                  {l.name}
                  {/* An ABSENT file is named as absent. The route reports the
                      difference deliberately; flattening it here would throw
                      that away. */}
                  {!l.present && <span className="device-logs-absent">not written yet</span>}
                </button>
                {open === l.name && l.present && <pre className="device-logs-tail">{l.log}</pre>}
                {open === l.name && !l.present && (
                  <p className="muted">
                    This device has never written {l.name}, so there is nothing to show.
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
