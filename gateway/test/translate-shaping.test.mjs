// Direct pins for the /v1/messages request-SHAPING decision cores.
//
// SOLID R117. These five functions were inline in `handleGatewayImpl` — a
// 798-line function with 57 branches — and between them they carry FOUR
// recorded incidents (round-41's 1102 regression, round-42 + round-43 Medium
// on the tools region, and round-46 High where a declaration-only web_search
// check hijacked the user's model on EVERY ordinary Claude Code turn). They
// had ZERO direct coverage: the 14 test files that reference translate.ts all
// exercise the MONOLITH, so a regression in one decision was only visible as
// an end-to-end failure, if at all.
//
// Each test below names the incident it protects, because the incident is the
// only reason the behaviour is what it is — several of these look wrong until
// you read why.

import test from "node:test";
import assert from "node:assert/strict";
import {
  toolsRegionOf,
  needsBodyParse,
  isSearchOnlyRequest,
  isForcedWebSearch,
  searchTargetFor,
  REQUIRED_KEY_BY_KIND,
  isKeyMissing,
  extractByokKeys,
} from "../src/plugins/translate.ts";

/** A tool schema whose property is literally named "messages" — the shape
 *  that broke BOTH earlier region-bounding schemes. */
const SCHEMA_WITH_MESSAGES_PROP = {
  name: "lookup",
  input_schema: { type: "object", properties: { messages: { type: "array" } } },
};
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

test("toolsRegionOf: a schema property named 'messages' does not truncate the region", () => {
  // round-42 Medium cut the region at the FIRST `"messages"` anchor; round-43
  // Medium bounded at the NEXT one. Both lost a web_search declared after such
  // a property, so the request silently stopped searching. The fixture puts
  // the trap BEFORE the declaration.
  const raw = JSON.stringify({
    tools: [SCHEMA_WITH_MESSAGES_PROP, WEB_SEARCH_TOOL],
    messages: [{ role: "user", content: "search for me" }],
  });
  const region = toolsRegionOf(raw);
  assert.ok(region.startsWith('"tools":['), region);
  assert.ok(
    region.includes("web_search_20250305"),
    "the declaration AFTER a 'messages' property must survive inside the region",
  );
  assert.ok(
    !region.includes('"messages"') || region.includes("properties"),
    "the region is the tools array, not an arbitrary cut into it",
  );
});

test("toolsRegionOf: nested braces inside a schema are balanced, not counted naively", () => {
  const deep = {
    type: "object",
    properties: { a: { type: "object", properties: { b: { type: "object" } } } },
  };
  const raw = JSON.stringify({ tools: [{ name: "t", input_schema: deep }, WEB_SEARCH_TOOL] });
  const region = toolsRegionOf(raw);
  // The region must close at the tools array's OWN bracket, so the tool after
  // the deeply-nested schema is included and everything past it is not.
  assert.ok(region.includes("web_search_20250305"), region.slice(-200));
  assert.ok(!region.includes('"messages"'), "nothing past the tools array leaks in");
  assert.equal(region[region.length - 1], "]", "the region ends at the closing bracket");
});

test("toolsRegionOf: the region STOPS at the tools array (regression: it did not)", () => {
  // THE BUG this pins. The scan starts ON the tools array's own `[`, so that
  // bracket takes the depth to 1 and the array's closing `]` brings it back to
  // 0 — but the loop used to stop only BELOW zero, so it ran one level OUT and
  // the region swallowed `messages` too.
  //
  // Consequence, and why this is not cosmetic: a conversation whose HISTORY
  // carries a previous search has `{"type":"server_tool_use","name":"web_search"}`
  // in a message (Claude Code keeps those blocks in its transcript). With the
  // region swallowing messages, that literal matched the `/"web_search"/`
  // trigger, so needsBodyParse fired and the ENTIRE body was parsed on every
  // later turn even though the current request's tools declared no web_search
  // at all. Parsing a ~2 MB body measures ~2.4 ms — about a quarter of the
  // 10 ms Free-plan budget (Error 1102) this guard exists to protect — and it
  // repeated for every turn of the conversation.
  const withHistorySearch = JSON.stringify({
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "assistant", content: [{ type: "server_tool_use", name: "web_search" }] },
      { role: "user", content: "keep going" },
    ],
  });
  const region = toolsRegionOf(withHistorySearch);
  assert.ok(
    !region.includes("messages"),
    `the region must not swallow messages: ${region}`,
  );
  assert.ok(
    !region.includes("server_tool_use"),
    "nothing past the tools array may leak in",
  );
  assert.equal(
    needsBodyParse(withHistorySearch, region),
    false,
    "no web_search in THIS request's tools → the body must be skipped, not parsed",
  );

  // ...while a REAL declaration (Anthropic's shape carries name:"web_search")
  // still triggers the parse — the fix must not have silenced detection.
  const realDecl = JSON.stringify({
    tools: [{ name: "Read" }, { type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: [{ role: "user", content: "search" }],
  });
  const realRegion = toolsRegionOf(realDecl);
  assert.ok(realRegion.includes("web_search_20250305"), realRegion);
  assert.equal(
    needsBodyParse(realDecl, realRegion),
    true,
    "a declared web_search must still trigger the parse",
  );
});

test("toolsRegionOf: no tools array yields an empty region", () => {
  assert.equal(toolsRegionOf(JSON.stringify({ messages: [] })), "");
  assert.equal(toolsRegionOf(""), "");
  assert.equal(toolsRegionOf("not json at all"), "");
});

test("needsBodyParse: image and web_search are the only parse triggers", () => {
  const img = JSON.stringify({
    messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
  });
  assert.equal(needsBodyParse(img, ""), true, "an image must trigger the parse");

  const plain = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(needsBodyParse(plain, ""), false, "a plain text body must SKIP the parse");

  const search = JSON.stringify({ tools: [WEB_SEARCH_TOOL], messages: [] });
  assert.equal(
    needsBodyParse(search, toolsRegionOf(search)),
    true,
    "a declared web_search must trigger the parse",
  );

  // The whitespace-tolerant form the regex deliberately accepts.
  assert.equal(needsBodyParse('{"type" : "image"}', ""), true);
});

test("needsBodyParse: the removed suffix clause was provably redundant", () => {
  // The inline version was:
  //     test(lastUserMsg) || test(rawText) || test(toolsRegion)
  // where lastUserMsg is a SUFFIX of rawText (or rawText itself). A regex that
  // matches a substring also matches the containing string, so the first
  // clause could never be true while the second was false. This test asserts
  // that equivalence over the shapes that could plausibly distinguish them —
  // i.e. it would FAIL if the collapse were wrong, and it documents the proof
  // for the next reader instead of leaving a silent deletion.
  const imageRe = /"type"\s*:\s*"image"/;
  const shapes = [
    // image only in the last user message
    { messages: [{ role: "user", content: [{ type: "image" }] }] },
    // image only in HISTORY (the round-41 shape: a text-only follow-up)
    {
      messages: [
        { role: "user", content: [{ type: "image" }] },
        { role: "assistant", content: "seen" },
        { role: "user", content: "what was in it?" },
      ],
    },
    // no image at all
    { messages: [{ role: "user", content: "plain" }] },
    // the marker inside a STRING value, not a block type
    { messages: [{ role: "user", content: 'literally "type":"image"' }] },
    // no messages key
    { tools: [WEB_SEARCH_TOOL] },
  ];
  for (const shape of shapes) {
    const raw = JSON.stringify(shape);
    const start = raw.lastIndexOf('"role":"user"');
    const lastUserMsg = start >= 0 ? raw.slice(start) : raw;
    const threeClause = imageRe.test(lastUserMsg) || imageRe.test(raw);
    const twoClause = imageRe.test(raw);
    assert.equal(
      threeClause,
      twoClause,
      `the suffix clause must be redundant for ${raw.slice(0, 60)}`,
    );
  }
});

test("isSearchOnlyRequest: EXACTLY one web_search tool and no tool_choice", () => {
  assert.equal(
    isSearchOnlyRequest({ tools: [WEB_SEARCH_TOOL] }),
    true,
    "a search-only request gets the force injected",
  );
  // Claude Code's ordinary turns carry many tools — never forced.
  assert.equal(isSearchOnlyRequest({ tools: [WEB_SEARCH_TOOL, SCHEMA_WITH_MESSAGES_PROP] }), false);
  // An explicit tool_choice is the caller's decision, not ours to inject.
  assert.equal(
    isSearchOnlyRequest({ tools: [WEB_SEARCH_TOOL], tool_choice: { type: "auto" } }),
    false,
  );
  // A different single tool is not a search request.
  assert.equal(isSearchOnlyRequest({ tools: [{ type: "custom" }] }), false);
  // Defensive shapes.
  assert.equal(isSearchOnlyRequest(null), false);
  assert.equal(isSearchOnlyRequest({}), false);
  assert.equal(isSearchOnlyRequest({ tools: "web_search" }), false);
  assert.equal(isSearchOnlyRequest({ tools: [] }), false);
});

test("isForcedWebSearch: round-46 High — DECLARING web_search is not forcing it", () => {
  // THE regression this pins: Claude Code declares web_search_20250305 in the
  // tools array of EVERY ordinary turn. A declaration-only check therefore
  // hijacked the user's chosen model on every request. The tools array below
  // is exactly that shape, and the verdict MUST be false.
  assert.equal(
    isForcedWebSearch(undefined),
    false,
    "a bare declaration (no tool_choice) must NOT count as search intent",
  );

  // Real forced intent, both spellings.
  assert.equal(isForcedWebSearch({ type: "tool", name: "web_search" }), true);
  assert.equal(
    isForcedWebSearch({ type: "any", tools: [{ name: "web_search" }] }),
    true,
    "type:any naming web_search is a force",
  );

  // Near misses that must NOT force.
  assert.equal(isForcedWebSearch({ type: "tool", name: "other" }), false);
  assert.equal(isForcedWebSearch({ type: "auto" }), false);
  assert.equal(isForcedWebSearch({ type: "any" }), false);
  assert.equal(isForcedWebSearch({ type: "any", tools: [] }), false);
  assert.equal(isForcedWebSearch({ type: "any", tools: [{ name: "other" }] }), false);
  assert.equal(isForcedWebSearch({ type: "any", tools: [null] }), false);
});

test("searchTargetFor: only a search-capable WIRE model keeps the caller's choice", () => {
  // The caller already names a search-capable model → honours it (2026-09-10).
  const kept = searchTargetFor("og/deepseek-v4.1-flash", "deepseek-flash");
  assert.equal(kept.capable, true);
  assert.equal(kept.model, "og/deepseek-v4.1-flash", "the caller's model is preserved");
  assert.equal(kept.wireModel, "deepseek-flash");

  // Any other model is forced onto the native search lane: the translate-only
  // models (minimax/mimo/kimi/glm) fabricate a query and return NO
  // web_search_tool_result (verified 2026-08-13), so answering from them is
  // worse than swapping the model.
  const forced = searchTargetFor("og/minimax-m3", "minimax-m3");
  assert.equal(forced.capable, false);
  assert.equal(forced.model, "og/deepseek-v4.1-flash", "forced to the search-capable lane");
  assert.equal(forced.wireModel, "deepseek-flash", "and to its WIRE slug");

  // The capability test is on the WIRE model, not the advertised name.
  const wireOnly = searchTargetFor("og/whatever-alias", "deepseek-flash");
  assert.equal(wireOnly.capable, true, "capability follows the wire slug");
  assert.equal(wireOnly.model, "og/whatever-alias", "the advertised name is kept as-is");
});

test("REQUIRED_KEY_BY_KIND: every mapped field is a REAL byok field", () => {
  // THE FAILURE MODE THIS EXISTS FOR. `isKeyMissing` returns false for an
  // unknown kind, so a TYPO in the table (`opencodeGo` -> `opencodeG`) makes a
  // REQUIRED key look present. The route then goes out HEADERLESS and the user
  // gets a bare "Upstream 401" instead of a config error — the exact bug class
  // the amd/ and og-native guard comments record. A typo is silent; this is
  // not.
  const realFields = new Set(Object.keys(extractByokKeys({})));
  for (const [kind, field] of Object.entries(REQUIRED_KEY_BY_KIND)) {
    assert.ok(
      realFields.has(field),
      `kind "${kind}" maps to byok.${field}, which extractByokKeys does not produce ` +
        `(real fields: ${[...realFields].join(", ")})`,
    );
  }
});

test("REQUIRED_KEY_BY_KIND: every byok field is reachable from some kind", () => {
  // The other direction: a key the user can store but no route ever checks is
  // dead weight, and more importantly a NEW route wired to an existing field
  // would leave the table silently incomplete.
  const mapped = new Set(Object.values(REQUIRED_KEY_BY_KIND));
  for (const field of Object.keys(extractByokKeys({}))) {
    assert.ok(
      mapped.has(field),
      `byok.${field} is never required by any route kind — either a route is ` +
        `missing its entry or the key is unused`,
    );
  }
});

test("REQUIRED_KEY_BY_KIND: the irregular spellings are the ones that matter", () => {
  // Three of the eight fields do NOT match their kind name. These are pinned
  // by name because a "tidy-up" that renames them for symmetry would break the
  // lookup in exactly the way the typo pin above describes.
  assert.equal(REQUIRED_KEY_BY_KIND.nvidia, "nv");
  assert.equal(REQUIRED_KEY_BY_KIND.opencode, "opencodeGo");
  assert.equal(REQUIRED_KEY_BY_KIND.commandgoat, "cmd");
  // ...and the five that do match.
  for (const kind of ["deepseek", "openrouter", "qwen", "gmi", "amd"]) {
    assert.ok(REQUIRED_KEY_BY_KIND[kind], `kind ${kind} lost its entry`);
  }
});

test("isKeyMissing: present key passes, absent/empty/null fails", () => {
  const full = {
    deepseek: "k",
    opencodeGo: "k",
    openRouter: "k",
    qwen: "k",
    nv: "k",
    gmi: "k",
    cmd: "k",
    amd: "k",
  };
  for (const kind of Object.keys(REQUIRED_KEY_BY_KIND)) {
    assert.equal(isKeyMissing(kind, full), false, `${kind} with its key must pass`);
  }
  // Each kind fails when ITS key is removed, and ONLY then.
  for (const [kind, field] of Object.entries(REQUIRED_KEY_BY_KIND)) {
    const without = { ...full, [field]: null };
    assert.equal(isKeyMissing(kind, without), true, `${kind} without ${field} must fail`);
    for (const other of Object.keys(REQUIRED_KEY_BY_KIND)) {
      if (other === kind) continue;
      assert.equal(
        isKeyMissing(other, without),
        false,
        `${other} must not be affected by ${kind}'s missing ${field}`,
      );
    }
  }
  // The empty-string case: extractByokKeys uses `|| null`, so "" and null are
  // the same "absent" — pinned so a `!== undefined` rewrite cannot slip in.
  assert.equal(isKeyMissing("deepseek", { deepseek: "" }), true);
  assert.equal(isKeyMissing("deepseek", {}), true);
});

test("isKeyMissing: an UNKNOWN kind reports false, not missing", () => {
  // Deliberate: a route with no table entry is a programming error that the
  // routing layer or the upstream will surface. Inventing a "missing key" for
  // it would mask that behind a config error and send the user hunting for a
  // key they cannot set.
  assert.equal(isKeyMissing("no-such-kind", {}), false);
  assert.equal(isKeyMissing("", {}), false);
});

test("the key guards agree with the table end-to-end through extractByokKeys", () => {
  // The table names fields on extractByokKeys' OUTPUT — not on the raw user
  // key record, whose names are the env-var spellings. Wiring them up wrong
  // (mapping `nvidia` -> "NVAPI_KEY") would typecheck and pass every unit pin
  // above, so the round-trip is asserted here.
  const userKeys = {
    DEEPSEEK_API_KEY: "d",
    OPENCODE_GO_API_KEY: null,
    OPENROUTER_API_KEY: "o",
    QWEN_API_KEY: "q",
    NVAPI_KEY: "n",
    GMI_API_KEY: "g",
    CMD_API_KEY: "c",
    AMD_API_KEY: "a",
  };
  const byok = extractByokKeys(userKeys);
  assert.equal(
    isKeyMissing("opencode", byok),
    true,
    "OPENCODE_GO_API_KEY:null must be read as the og route having no key",
  );
  assert.equal(isKeyMissing("nvidia", byok), false, "NVAPI_KEY must reach the nvidia route");
  assert.equal(isKeyMissing("commandgoat", byok), false, "CMD_API_KEY must reach cm/");
});
