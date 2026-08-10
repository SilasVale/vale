// IndexedDB persistence for terminal session logs.
//
// DB `vale-terminal` v1, single object store `sessions` keyed by sid. One
// record per session, append-only lines array (snapshot-rewrite policy):
//   { sid, kind, label, openedAt, closedAt, complete, endAbs, persistedSeq, lines }
//     lines: [{ t: ms, text }]  — receipt-timestamped clean lines
//     endAbs: renderedBytes at last flush (raw-byte coverage of `lines`)
//     persistedSeq: s.lines.length at last flush (memory may be ahead)
//
// Promise-wrapped; every helper degrades to rejection (callers catch) so the
// terminal page keeps working in memory-only mode if IDB is unavailable.

const DB_NAME = "vale-terminal";
const DB_VERSION = 1;
const STORE = "sessions";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "sid" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function idbPut(rec) {
  return tx(STORE, "readwrite", (store) => store.put(rec));
}

export function idbGet(sid) {
  return tx(STORE, "readonly", (store) => store.get(sid)).then((req) => req?.result || null);
}

export function idbGetAll() {
  return tx(STORE, "readonly", (store) => store.getAll()).then((req) => req?.result || []);
}

export function idbDelete(sid) {
  return tx(STORE, "readwrite", (store) => store.delete(sid));
}
