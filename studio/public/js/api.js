// api.js — fetch/WS wrappers with token handling
"use strict";
window.VS = window.VS || {};

VS.token = localStorage.getItem("vale-studio-token") || "";

VS.api = async function (path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (VS.token) headers["authorization"] = "Bearer " + VS.token;
  if (opts.body && typeof opts.body !== "string") {
    opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText || "request failed");
    err.status = res.status;
    err.code = data && data.error;
    err.currentSha256 = data && data.currentSha256;
    throw err;
  }
  return data;
};

VS.wsUrl = function (path) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sep = path.includes("?") ? "&" : "?";
  return `${proto}://${location.host}${path}${sep}token=${encodeURIComponent(VS.token)}`;
};
