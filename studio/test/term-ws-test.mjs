import WebSocket from "ws";
const T = "dev-studio-token-2026-08-25-local";
const r = await fetch("http://127.0.0.1:7780/api/term", {
  method: "POST",
  headers: { authorization: `Bearer ${T}`, "content-type": "application/json" },
  body: JSON.stringify({ cwd: "/home/zhengsaisi/vale", cols: 80, rows: 24 }),
});
const { id } = await r.json();
console.log("term id:", id);
const ws = new WebSocket(`ws://127.0.0.1:7780/api/term/${id}?token=${T}`);
let out = "";
ws.on("open", () => setTimeout(() => ws.send(Buffer.from("echo WSLOOP_$((9*9))\r")), 800));
ws.on("message", (d) => { out += d.toString(); if (out.includes("WSLOOP_81")) { console.log("ECHO OK"); process.exit(0); } });
setTimeout(() => { console.log("TIMEOUT. tail:", JSON.stringify(out.slice(-150))); process.exit(1); }, 6000);
