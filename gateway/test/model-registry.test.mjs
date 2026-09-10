// The MODEL REGISTRY completeness contract (SOLID R120).
//
// WHY THIS EXISTS. Before the registry, one advertised model lived in up to
// SIX places (MODELS, OG_WIRE_REMAP, OG_FORCE_US_PROXY,
// SEARCH_CAPABLE_WIRE_MODELS, HEALTH_CHANNELS, the VISION_CAPABLE_MODELS env
// var) plus hardcoded conditions in translate.ts. There was no gate on the
// SET of places: measured, adding an id to MODELS alone left all 737 tests
// GREEN while the model was half-wired — the real state was five advertised
// models with no health probe, discovered only by hand.
//
// The tests below make the coverage BIDIRECTIONAL, which is what turns
// "remember six tables" into "the build tells you":
//
//   * every advertised model has a registry record (a new MODELS entry can
//     no longer appear without its facets);
//   * every registry record declares EVERY facet, or explains in `probeWhy`
//     why it has none — an omission must be typed out, not defaulted into;
//   * every DERIVED table agrees with the registry it derives from (so a
//     hand-edit to a derived table is caught);
//   * the facets only the registry knows about (wire, reasoningMax,
//     responsesOnly) are actually consulted by the code that needs them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MODEL_REGISTRY,
  MODELS,
  OG_WIRE_REMAP,
  OG_FORCE_US_PROXY,
  SEARCH_CAPABLE_WIRE_MODELS,
  HEALTH_CHANNELS,
  ROUTE_INFO,
  modelSpec,
  wireSpec,
  reasoningMaxRawFor,
  reasoningMaxParsedFor,
  isResponsesOnlyModel,
  routeModelsFor,
} from "../src/channels.ts";
import { AUTO_FALLBACK_LADDER, DEFAULT_ROUTE_MODEL } from "../src/plugins/model-route.ts";

const channelOf = (id) => id.slice(0, id.indexOf("/"));
const strippedOf = (id) => id.slice(id.indexOf("/") + 1);
const wireOf = (m) => m.wire ?? strippedOf(m.id);

test("every advertised model has a registry record (and vice versa)", () => {
  // The registry IS the source, so these are equal by construction — the
  // assertion is here to catch a hand-edit that reintroduces a literal
  // MODELS entry rather than going through the registry.
  assert.deepEqual(
    MODELS.map((m) => m.id),
    MODEL_REGISTRY.map((m) => m.id),
    "MODELS must derive from MODEL_REGISTRY in the same order",
  );
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length, "no duplicate ids");
  for (const m of MODELS) {
    const spec = modelSpec(m.id);
    assert.ok(spec, `${m.id} is advertised but has no registry record`);
    assert.equal(spec.ownedBy, m.owned_by, `${m.id}: owned_by must match the record`);
  }
});

test("the advertised ORDER is pinned (it is the /v1/models response)", () => {
  // Order is client-visible: /v1/models is served from MODELS verbatim. The
  // registry redistribution R120 did moved or/stealth/ox-alpha into the or/
  // group and changed the response — caught by comparing against a snapshot
  // of the pre-refactor output, and now pinned so it cannot drift again.
  const expected = [
    "og/deepseek-v4.1-flash",
    "og/minimax-m3",
    "og/mimo-v2.5",
    "og/ox-alpha-free",
    "og/muse-spark-1.3-contributor",
    "og/muse-spark-1.2-contributor",
    "og/gpt-5.6-luna",
    "og/openai/gpt-5.6-luna:floor[1m]",
    "or/openai/gpt-5.6-luna:floor[1m]",
    "or/z-ai/glm-5.2:free",
    "or/nvidia/nemotron-3-ultra-550b-a55b:free",
    "nv/nvidia/nemotron-3-ultra-550b-a55b",
    "nv/minimaxai/minimax-m3",
    "nv/moonshotai/kimi-k3",
    "gmi/MiniMaxAI/MiniMax-M3",
    "gmi/MiniMaxAI/MiniMax-M2.7",
    "or/stealth/ox-alpha",
    "qw/qwen3.8-max-preview",
    "qw/qwen3.8-flash",
    "cm/meituan/LongCat-2.0:free",
    "cm/poolside/laguna-s-2.1-free",
    "cm/deepseek/deepseek-v4.1-flash",
  ];
  assert.deepEqual(
    MODELS.map((m) => m.id),
    expected,
    "the /v1/models order changed — this is CLIENT-VISIBLE. If the new order is " +
      "intended, update this list; otherwise restore the registry order.",
  );
});

test("every registered model has a health probe OR an explicit reason it does not", () => {
  // THE CORE GATE. Five models (og/minimax-m3, og/muse-spark-1.2-contributor,
  // og/openai/gpt-5.6-luna:floor[1m], nv/minimaxai/minimax-m3,
  // nv/moonshotai/kimi-k3) had silently gone unprobed because nothing asked.
  // Now a model either carries `probe: true` or states WHY not — a new model
  // cannot default into the gap.
  const probed = new Set(HEALTH_CHANNELS.map((c) => c.model));
  for (const m of MODEL_REGISTRY) {
    if (m.probe === true) {
      assert.ok(
        probed.has(m.id),
        `${m.id} declares probe:true but has no HEALTH_CHANNELS card`,
      );
    } else if (m.probe === false) {
      assert.ok(
        typeof m.probeWhy === "string" && m.probeWhy.length > 0,
        `${m.id} sets probe:false without a probeWhy — the decision must be stated`,
      );
      assert.ok(
        !probed.has(m.id),
        `${m.id} declares probe:false but HAS a card — flip the facet`,
      );
    } else {
      assert.fail(
        `${m.id} declares no \`probe\` facet. Say \`probe: true\` (add a ` +
          `HEALTH_CHANNELS card) or \`probe: false, probeWhy: "..."\`.`,
      );
    }
  }
  // ...and no card may name a model that is not advertised: a probe for an
  // unlisted id reports health for something clients cannot call.
  for (const c of HEALTH_CHANNELS) {
    assert.ok(
      MODEL_REGISTRY.some((m) => m.id === c.model),
      `HEALTH_CHANNELS probes ${c.model}, which is not in the registry`,
    );
  }
});

test("every derived table agrees with the registry it derives from", () => {
  // The tables are computed, so this catches a hand-edit that bypasses the
  // registry — which is the whole failure mode the registry exists to remove.
  assert.deepEqual(
    [...OG_FORCE_US_PROXY].sort(),
    MODEL_REGISTRY.filter((m) => m.usEgress).map((m) => m.id).sort(),
    "OG_FORCE_US_PROXY must be exactly the usEgress records",
  );
  assert.deepEqual(
    [...SEARCH_CAPABLE_WIRE_MODELS].sort(),
    MODEL_REGISTRY.filter((m) => m.search).map(wireOf).sort(),
    "SEARCH_CAPABLE_WIRE_MODELS is keyed by WIRE name",
  );
  assert.deepEqual(
    OG_WIRE_REMAP,
    Object.fromEntries(
      MODEL_REGISTRY.filter((m) => m.wire && m.id.startsWith("og/")).map((m) => [
        strippedOf(m.id),
        m.wire,
      ]),
    ),
    "OG_WIRE_REMAP must be exactly the og/ wire facets",
  );
});

test("a `wire` facet is only meaningful on og/ — anywhere else it is ignored", () => {
  // wireModelName() (upstream.ts) consults OG_WIRE_REMAP for prefix "og" and
  // passes everything else through untouched. A wire on another channel would
  // be DEAD DATA that reads as if it did something — the exact trap this
  // registry is supposed to close.
  for (const m of MODEL_REGISTRY) {
    if (m.wire) {
      assert.equal(
        channelOf(m.id),
        "og",
        `${m.id} declares wire "${m.wire}", but only og/ wires are consulted`,
      );
    }
  }
});

test("wireSpec: unique wire names resolve, ambiguous ones refuse", () => {
  // My FIRST version of this test asserted that every record resolves from
  // its own wire name. It failed, and the implementation was right: stripping
  // the channel makes two channels collide when they advertise the same
  // upstream slug — `og/openai/gpt-5.6-luna:floor[1m]` and
  // `or/openai/gpt-5.6-luna:floor[1m]` share one wire name. Returning "the
  // first match" would let one channel's model inherit the other's facet.
  //
  // So the real contract is: exactly one match, or none. This test pins BOTH
  // halves — the refusal, and the fact that the refusal cannot silently
  // switch off a live rule.
  const byWire = new Map();
  for (const m of MODEL_REGISTRY) {
    const w = wireOf(m);
    byWire.set(w, [...(byWire.get(w) ?? []), m]);
  }

  // (a) every facet consulted BY WIRE NAME must be unambiguous, otherwise
  //     wireSpec's refusal would disable it in the field.
  for (const m of MODEL_REGISTRY) {
    if (!m.responsesOnly && !m.reasoningMax) continue;
    assert.equal(
      byWire.get(wireOf(m)).length,
      1,
      `${m.id} carries a wire-name facet but its wire name ` +
        `"${wireOf(m)}" is shared — wireSpec would refuse it and the facet ` +
        `would stop working silently`,
    );
    assert.equal(wireSpec(wireOf(m))?.id, m.id, `${m.id} must resolve to itself`);
  }

  // (b) an ambiguous name refuses rather than guessing.
  const ambiguous = [...byWire.entries()].filter(([, ms]) => ms.length > 1);
  for (const [w, ms] of ambiguous) {
    assert.equal(
      wireSpec(w),
      undefined,
      `"${w}" is shared by ${ms.map((m) => m.id).join(", ")} and must not guess`,
    );
  }
  // The known collision, named so a future de-duplication is a deliberate act.
  assert.deepEqual(
    ambiguous.map(([w]) => w),
    ["openai/gpt-5.6-luna:floor[1m]"],
    "the ambiguous wire set changed — re-check every wire-name facet",
  );

  // (c) unregistered names resolve to nothing.
  assert.equal(wireSpec("no-such-model"), undefined);
  assert.equal(wireSpec(""), undefined);
});

test("the reasoning facet is scoped to the mechanism the path uses", () => {
  // Two mechanisms, two facets: a passthrough route forwards RAW text (no
  // parse, for the CPU budget) so the default is injected textually, while a
  // translate route already holds the parsed object. Encoding the mechanism
  // stops a model from silently picking up the other path's injection.
  assert.equal(reasoningMaxRawFor("stealth/ox-alpha"), true, "or/ spelling, raw text");
  assert.equal(reasoningMaxRawFor("ox-alpha-free"), false, "the og/ spelling is parsed");
  assert.equal(reasoningMaxParsedFor("ox-alpha-free"), true, "og/ spelling, parsed object");
  assert.equal(reasoningMaxParsedFor("stealth/ox-alpha"), false);
  // Everything else has no default at all.
  for (const m of MODEL_REGISTRY) {
    if (m.reasoningMax) continue;
    assert.equal(reasoningMaxRawFor(wireOf(m)), false, `${m.id} must not default raw`);
    assert.equal(reasoningMaxParsedFor(wireOf(m)), false, `${m.id} must not default parsed`);
  }
});

test("the responses-only facet matches what /v1/responses actually serves", () => {
  const only = MODEL_REGISTRY.filter((m) => m.responsesOnly).map((m) => m.id);
  assert.deepEqual(
    only,
    ["og/muse-spark-1.3-contributor", "og/muse-spark-1.2-contributor"],
    "muse-spark Contributor are the /v1/responses models",
  );
  for (const id of only) {
    assert.equal(
      isResponsesOnlyModel(wireOf(modelSpec(id))),
      true,
      `${id} must be recognised by its wire name`,
    );
  }
  assert.equal(isResponsesOnlyModel("deepseek-flash"), false);
  assert.equal(isResponsesOnlyModel("unregistered"), false, "unlisted ids are refused too");
});

test("the facets the registry owns are actually CONSULTED (no dead data)", () => {
  // A facet nothing reads is worse than no facet: it documents behaviour that
  // does not happen. Each is checked against the module that must use it.
  const translate = readFileSync(
    new URL("../src/plugins/translate.ts", import.meta.url),
    "utf8",
  );
  for (const helper of [
    "isResponsesOnlyModel",
    "reasoningMaxRawFor",
    "reasoningMaxParsedFor",
  ]) {
    assert.ok(
      translate.includes(helper),
      `${helper} is exported but translate.ts never calls it — dead facet`,
    );
  }
  // The hardcoded spellings the registry replaced must NOT come back.
  assert.ok(
    !translate.includes('startsWith("muse-spark-")'),
    "the muse-spark string test is back — it belongs in the registry",
  );
  assert.ok(
    !translate.includes('upstreamModel === "ox-alpha-free"'),
    "the ox-alpha-free string test is back — it belongs in the registry",
  );
  assert.ok(
    !translate.includes('upstreamModel === "stealth/ox-alpha"'),
    "the stealth/ox-alpha string test is back — it belongs in the registry",
  );
});

test("ROUTE_INFO[].models is DERIVED — the console cannot drift from the catalogue", () => {
  // THE FIFTH COPY. ROUTE_INFO[].models was hand-maintained and had silently
  // drifted from MODELS in two ways that the old test could not see (it only
  // checked that each PREFIX was covered):
  //
  //   * the `og/` list OMITTED `openai/gpt-5.6-luna:floor[1m]` — a model
  //     /v1/models advertises and the console's route breakdown did not show;
  //   * `og/` and `cm/` listed their models in a DIFFERENT ORDER from the
  //     catalogue.
  //
  // /api/admin/public returns `routes: ROUTE_INFO` and `models: MODELS` in the
  // same payload, so the two disagreeing was a visible inconsistency.
  for (const r of ROUTE_INFO) {
    if (r.prefix === "none") continue; // not a prefix-filtered view — see below
    assert.deepEqual(
      r.models,
      MODEL_REGISTRY.filter((m) => m.id.startsWith(r.prefix)).map((m) =>
        m.id.slice(r.prefix.length),
      ),
      `${r.prefix}: the console route list must be exactly the advertised models ` +
        `on that channel, in catalogue order`,
    );
    // ...and it must be the DERIVED call, not a literal that happens to match.
    assert.ok(
      routeModelsFor(r.prefix).length === r.models.length,
      `${r.prefix}: routeModelsFor disagrees with the entry`,
    );
  }
  // Every prefix in MODELS appears as a route, and no route invents a prefix.
  const routed = new Set(ROUTE_INFO.map((r) => r.prefix));
  for (const p of new Set(MODEL_REGISTRY.map((m) => channelOf(m.id) + "/"))) {
    assert.ok(routed.has(p), `no ROUTE_INFO entry for ${p}`);
  }
  // The no-prefix entry is explicitly NOT derived: those ids carry no channel
  // prefix, so they cannot come from the registry (see routeModelsFor).
  assert.equal(routeModelsFor("none").length, 0, "none must not filter the registry");
  assert.deepEqual(
    routeModelsFor("none", ["x/y"]),
    ["x/y"],
    "none passes its explicit list through",
  );
  assert.deepEqual(
    ROUTE_INFO.find((r) => r.prefix === "none").models,
    ["deepseek/deepseek-v4.1-flash"],
    "the default channel's display name is unchanged",
  );
});

test("the `auto` fallback ladder is a subset of the catalogue", () => {
  // NOT derived from MODELS: the ORDER is the meaning (default channel first,
  // then alternatives), so it stays an explicit list. What it must be is a
  // SUBSET — a ladder entry that is not advertised (a typo, or a model dropped
  // from the catalogue) is a fallback `isModelUsable` can never accept, and
  // the loop would skip it in SILENCE while `auto` quietly picked something
  // else.
  const advertised = new Set(MODEL_REGISTRY.map((m) => m.id));
  for (const m of AUTO_FALLBACK_LADDER) {
    assert.ok(advertised.has(m), `${m} is in the fallback ladder but not advertised`);
  }
  // The default must be the FIRST rung — the ladder's own contract.
  assert.equal(
    AUTO_FALLBACK_LADDER[0],
    DEFAULT_ROUTE_MODEL,
    "the default channel must lead the ladder",
  );
  assert.ok(advertised.has(DEFAULT_ROUTE_MODEL), "the default must be advertised");
  // Every rung is distinct: a duplicate wastes a probe and hides a gap.
  assert.equal(
    new Set(AUTO_FALLBACK_LADDER).size,
    AUTO_FALLBACK_LADDER.length,
    "the ladder has a duplicate rung",
  );
});
