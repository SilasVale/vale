#!/usr/bin/env node
// model-drift.mjs — what the model CHANNELS advertise vs what their upstreams offer.
//
// WHY. The gateway advertises a model catalogue at `/v1/models` that comes from a
// HARDCODED registry (`gateway/src/channels.ts`'s MODEL_REGISTRY). Adding or
// retiring a model means editing that source and redeploying — so when an
// upstream adds a model, or silently RETIRES one, nothing tells anyone. The
// dangerous direction is the second: the gateway goes on promising a model the
// upstream no longer serves, and the first caller to pick it gets an error.
//
// WHAT IT IS NOT. It is NOT a way to add models. A registry record carries SIX
// facets (advertised id, upstream wire slug, US-egress policy, web-search
// capability, health card, vision) and an upstream's model list tells you only
// the first. Auto-advertising everything an upstream offers would promise models
// for which this gateway has no policy at all — which is why the "offered but
// not advertised" list below is an OPPORTUNITY LIST FOR A HUMAN, never an
// automatic addition.
//
// HOW IT COMPARES, AND WHY THE OBVIOUS WAY IS WRONG. Stripping the channel prefix
// and diffing the names produces FALSE POSITIVES: the router normalises further
// (Claude Code appends a `[1m]` context marker, and `og/` has wire remaps) and
// some advertised ids are deliberate aliases no upstream lists. So a name that
// does not match is reported as CHECK, not as a defect — nothing here may claim
// an upstream retired a model on the strength of a string comparison.
//
// Usage: node scripts/model-drift.mjs [--json] [--strict] [--gateway <url>]
//   exit 0 = report produced (drift is normal); --strict exits 1 if any channel
//   advertises something no upstream lists.

const CHANNELS = {
  or: "https://openrouter.ai/api/v1/models",
  nv: "https://integrate.api.nvidia.com/v1/models",
  cm: "https://api.commandcode.ai/provider/v1/models",
  og: "https://opencode.ai/zen/go/v1/models",
  // gmi / qw / amd / ds answer 401 to an unauthenticated /models (verified), so
  // they are NOT compared rather than reported as empty — "could not check" and
  // "offers nothing" are different facts, and this repo has been bitten by
  // collapsing them before.
};

/** The router's own name normalisation, mirrored: Claude Code appends a
 *  `[context-window]` marker and `stripBracket` removes it before routing. */
export function normalise(name) {
  return String(name).replace(/\[[^\]]*\]$/, "").trim();
}

/** Advertised ids for one channel, normalised, prefix stripped. */
export function advertisedFor(ids, prefix) {
  return ids
    .filter((id) => typeof id === "string" && id.startsWith(prefix + "/"))
    .map((id) => normalise(id.slice(prefix.length + 1)));
}

/** The comparison, pure so it can be tested without a network.
 *
 *  `advertisedNotOffered` is the one that matters (a promise the upstream may not
 *  keep); `offeredNotAdvertised` is an opportunity list. Neither is a verdict —
 *  see the header. */
export function diffChannel(advertised, offered) {
  const o = new Set(offered.map(normalise));
  const a = new Set(advertised.map(normalise));
  return {
    advertisedNotOffered: [...a].filter((x) => !o.has(x)).sort(),
    offeredNotAdvertised: [...o].filter((x) => !a.has(x)).sort(),
  };
}

async function fetchIds(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "vale-model-drift/1 (+https://agent.saisi.online)", accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const list = body && (body.data || body.models);
  if (!Array.isArray(list)) throw new Error("no model list in the reply");
  return list.map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const strict = argv.includes("--strict");
  const gi = argv.indexOf("--gateway");
  const gateway = (gi >= 0 ? argv[gi + 1] : process.env.VALE_GATEWAY || "https://api.saisi.online").replace(/\/+$/, "");

  let advertised;
  try {
    advertised = await fetchIds(`${gateway}/v1/models`);
  } catch (e) {
    // SAY SO. An unreadable catalogue is not an empty one, and a report that
    // printed "everything matches" here would be the exact failure this repo
    // keeps finding.
    console.error(`model-drift: cannot read ${gateway}/v1/models — ${e.message}. Nothing was compared.`);
    process.exit(1);
  }

  const report = { gateway, advertisedTotal: advertised.length, channels: {} };
  let anyCheck = false;
  for (const [prefix, url] of Object.entries(CHANNELS)) {
    const adv = advertisedFor(advertised, prefix);
    let offered;
    try {
      offered = await fetchIds(url);
    } catch (e) {
      report.channels[prefix] = { error: e.message, advertised: adv.length };
      continue;
    }
    const d = diffChannel(adv, offered);
    report.channels[prefix] = { advertised: adv.length, offered: offered.length, ...d };
    if (d.advertisedNotOffered.length) anyCheck = true;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`model-drift: ${gateway} advertises ${report.advertisedTotal} models`);
    for (const [p, c] of Object.entries(report.channels)) {
      if (c.error) { console.log(`  ${p}/  could NOT be checked (${c.error}) — says nothing about its catalogue`); continue; }
      console.log(`  ${p}/  advertised ${c.advertised}, upstream offers ${c.offered}`);
      if (c.advertisedNotOffered.length) {
        console.log(`      CHECK — advertised but no upstream entry of that name (an alias, or a retired model):`);
        for (const x of c.advertisedNotOffered) console.log(`        ${p}/${x}`);
      }
      if (c.offeredNotAdvertised.length) {
        console.log(`      opportunity — upstream offers, we do not advertise: ${c.offeredNotAdvertised.length} (adding one needs the registry's other five facets)`);
      }
    }
    console.log("  NOTE: a CHECK is not a verdict. Nothing here may claim an upstream retired a model on a name comparison.");
  }
  process.exit(strict && anyCheck ? 1 : 0);
}

// Importable for tests without running the report.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  await main();
}
