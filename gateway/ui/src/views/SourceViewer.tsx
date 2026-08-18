import { useState, useEffect } from "react";

interface SourceFile {
  name: string;
  path: string;
  group: string;
}

interface SourceManifest {
  files: SourceFile[];
}

export default function SourceViewer() {
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [selected, setSelected] = useState<SourceFile | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    fetch("/code/manifest.json")
      .then((r) => r.json())
      .then((m: SourceManifest) => setFiles(m.files || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetch(`/code/${selected.path}`)
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent("Failed to load"));
  }, [selected]);

  const groups: Record<string, SourceFile[]> = {};
  for (const f of files) {
    (groups[f.group] = groups[f.group] || []).push(f);
  }

  return (
    <div className="source-viewer">
      <aside className="source-sidebar">
        {Object.entries(groups).map(([group, list]) => (
          <div key={group}>
            <div className="source-group">{group}</div>
            {list.map((f) => (
              <button
                key={f.path}
                className={`source-file ${selected?.path === f.path ? "active" : ""}`}
                onClick={() => setSelected(f)}
              >
                {f.name}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <main className="source-content">
        <pre>{content || "Select a file from the left"}</pre>
      </main>
    </div>
  );
}
