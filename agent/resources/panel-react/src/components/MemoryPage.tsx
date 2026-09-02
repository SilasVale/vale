// MemoryPane — the desktop shell's memory page: browse/search/delete/export
// over the agent's /api/tools/memory_* surface (the same 6 MCP tools the AI
// clients use). Text-only rendering (no innerHTML), consistent with the rest
// of the panel.
//
// round-161 redesign: one merged filter bar (Enter or button triggers; tag is
// passed to SEARCH too — it used to be silently ignored), busy state, inline
// delete confirmation (was window.confirm), export copy button, Icon glyphs,
// and the toast timer is cleaned up on unmount.
import { useCallback, useEffect, useRef, useState } from "react";
import { callTool } from "../lib/api";
import { Icon } from "../ui/Icon";

interface MemEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  namespace: string;
  source: string;
  created_at: number;
  updated_at: number;
  deleted?: boolean;
}

const PAGE = 50;
// stage-n: sentinel edit id meaning "create a new entry" (real ids are
// random hex and never collide).
const NEW_ID = "__new__";

export function MemoryPage() {
  const [entries, setEntries] = useState<MemEntry[]>([]);
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exportText, setExportText] = useState("");
  const [toast, setToast] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // stage-n: inline edit — the entry surface had browse/delete/export but
  // no way to correct a saved memory from the UI (memory_update existed in
  // the API but was AI-only).
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const loaded = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const toastMsg = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2000);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params: Record<string, unknown> = {};
      if (namespace) params.namespace = namespace;
      if (tag) params.tag = tag;
      params.limit = PAGE;
      const r = await callTool("memory_list", params);
      const rows = (r?.results || []) as MemEntry[];
      setEntries(rows);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [namespace, tag]);

  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      load();
    }
  }, [load]);

  const search = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (query.trim()) {
        // round-161 bug fix: the tag filter is now passed to SEARCH too (it
        // used to be silently ignored unless you switched to List).
        const r = await callTool("memory_search", {
          query,
          limit: PAGE,
          ...(namespace ? { namespace } : {}),
          ...(tag ? { tag } : {}),
        });
        setEntries((r?.results || []) as MemEntry[]);
      } else {
        await load();
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [query, namespace, tag, load]);

  const del = useCallback(async (id: string) => {
    try {
      await callTool("memory_delete", { id });
      toastMsg("deleted");
      setConfirmId(null);
      load();
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [load, toastMsg]);

  // stage-n: inline edit — fill the form from the entry, save via memory_update.
  const startEdit = useCallback((e: MemEntry) => {
    setEditId(e.id);
    setEditTitle(e.title);
    setEditContent(e.content);
    setEditTags(e.tags.join(", "));
    setError("");
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editId) return;
    setEditBusy(true);
    try {
      const tags = editTags.split(",").map((t) => t.trim()).filter(Boolean);
      if (editId === NEW_ID) {
        // stage-n: create from the UI — memory_save was AI-only until now.
        if (!editTitle.trim() || !editContent.trim()) {
          setError("title and content are required");
          return;
        }
        await callTool("memory_save", { title: editTitle.trim(), content: editContent, tags });
        toastMsg("entry created");
      } else {
        await callTool("memory_update", {
          id: editId,
          title: editTitle.trim(),
          content: editContent,
          tags,
        });
        toastMsg("saved");
      }
      setEditId(null);
      load();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setEditBusy(false);
    }
  }, [editId, editTitle, editContent, editTags, load, toastMsg]);

  // stage-n: start a NEW entry — same inline form, empty fields.
  const startNew = useCallback(() => {
    setEditId(NEW_ID);
    setEditTitle("");
    setEditContent("");
    setEditTags("");
    setError("");
  }, []);

  const doExport = useCallback(async () => {
    // SPA audit LOW-5: the Export button's disabled={busy} was VACUOUS —
    // doExport never set busy, so double-clicks ran two full exports.
    setBusy(true);
    try {
      const r = await callTool("memory_export", namespace ? { namespace } : {});
      setExportText(r?.export || "");
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [namespace]);

  const copyExport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      toastMsg("export copied");
    } catch { toastMsg("clipboard unavailable"); }
  }, [exportText, toastMsg]);

  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString();

  return (
    <div className="mem-pane">
      <div className="mem-toolbar">
        <input
          className="mem-input"
          placeholder="Search title/content/tags… (Enter)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <input
          className="mem-input mem-narrow"
          placeholder="namespace"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <input
          className="mem-input mem-narrow"
          placeholder="tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <button className="btn btn-ghost btn-mini" onClick={search} disabled={busy}>Search</button>
        <button className="btn btn-ghost btn-mini" onClick={load} disabled={busy}>List</button>
        <button className="btn btn-ghost btn-mini" onClick={doExport} disabled={busy}>Export</button>
        {/* stage-n: create entries from the UI (was AI-only via memory_save) */}
        <button className="btn btn-mini" onClick={startNew} disabled={editId !== null}>+ New</button>
        {busy && <span className="mem-busy" title="loading">◌</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {toast && <div className="hint">{toast}</div>}
      <div className="mem-list">
        {editId === NEW_ID && (
          /* stage-n: new-entry card (same form as inline edit) */
          <div className="mem-card">
            <div className="mem-edit">
              <input className="mem-edit-input" autoFocus value={editTitle} onChange={(ev) => setEditTitle(ev.target.value)} placeholder="Title (required)" />
              <textarea className="mem-edit-content" value={editContent} onChange={(ev) => setEditContent(ev.target.value)} placeholder="Content (required)" rows={3} />
              <input className="mem-edit-input" value={editTags} onChange={(ev) => setEditTags(ev.target.value)} placeholder="Tags (comma separated)" />
              <div className="mem-edit-actions">
                <button className="btn btn-mini" onClick={saveEdit} disabled={editBusy}>{editBusy ? "Saving…" : "Create"}</button>
                <button className="btn btn-ghost btn-mini" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )}
        {entries.length === 0 && !busy && <p className="muted">No memory entries yet — AI clients save knowledge via memory_save.</p>}
        {entries.length >= 50 && <p className="muted">Showing the first 50 entries — narrow the namespace filter or search to reach older knowledge.</p>}
        {entries.map((e) => (
          <div className="mem-card" key={e.id} data-deleted={e.deleted || undefined}>
            {editId === e.id ? (
              /* stage-n: inline edit form */
              <div className="mem-edit">
                <input className="mem-edit-input" value={editTitle} onChange={(ev) => setEditTitle(ev.target.value)} placeholder="Title" />
                <textarea className="mem-edit-content" value={editContent} onChange={(ev) => setEditContent(ev.target.value)} placeholder="Content" rows={3} />
                <input className="mem-edit-input" value={editTags} onChange={(ev) => setEditTags(ev.target.value)} placeholder="Tags (comma separated)" />
                <div className="mem-edit-actions">
                  <button className="btn btn-mini" onClick={saveEdit} disabled={editBusy}>{editBusy ? "Saving…" : "Save"}</button>
                  <button className="btn btn-ghost btn-mini" onClick={() => setEditId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="mem-card-head">
                  <span className="mem-title">{e.title}</span>
                  <span className="mem-meta">{e.namespace} · {e.source} · {fmt(e.updated_at)}</span>
                  <span className="mem-actions">
                    <button className="btn btn-ghost btn-mini" title="Edit entry" aria-label="Edit entry" onClick={() => startEdit(e)}>
                      <Icon name="edit" size={11} />
                    </button>
                    {confirmId === e.id ? (
                      <>
                        <span className="mem-confirm-hint">delete?</span>
                        <button className="btn btn-danger btn-mini" onClick={() => del(e.id)}>Delete</button>
                        <button className="btn btn-ghost btn-mini" onClick={() => setConfirmId(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-danger btn-mini" title="Delete entry" aria-label="Delete entry" onClick={() => setConfirmId(e.id)}>
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </span>
                </div>
                {e.tags.length > 0 && (
                  <div className="mem-tags">{e.tags.map((t) => <span className="mem-tag" key={t}>{t}</span>)}</div>
                )}
                <pre className="mem-content">{e.content}</pre>
              </>
            )}
          </div>
        ))}
      </div>
      {exportText && (
        <div className="mem-export">
          <div className="mem-export-head">
            <span>Export ({exportText.split("\n").length} lines)</span>
            <span className="mem-export-actions">
              <button className="btn btn-ghost btn-mini" onClick={copyExport}>Copy</button>
              <button className="btn btn-ghost btn-mini" onClick={() => setExportText("")}>Close</button>
            </span>
          </div>
          <pre>{exportText}</pre>
        </div>
      )}
    </div>
  );
}
