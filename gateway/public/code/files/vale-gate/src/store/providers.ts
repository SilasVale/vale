/**
 * store/providers.ts — custom model PROVIDERS as DATA — the layer above
 * store/models.ts, and the same gap closed one level up.
 *
 * WHY THIS EXISTS. `store/models.ts` closed "adding a MODEL means editing
 * channels.ts and redeploying": a model is now a POST. It did not close the
 * layer those models sit on — the seven CHANNELS are still code (`ROUTE_INFO` in
 * channels.ts, `ROUTE_TABLE` in upstream.ts). An operator with a new
 * OpenAI-compatible endpoint (their own vLLM, a company gateway, another
 * aggregator) had no way in short of a rebuild. DSH — the harness this gateway
 * serves — closes it in `settings.yaml`:
 *
 *     providers:
 *       vale:
 *         api: openai-completions
 *         baseURL: https://api.saisi.online
 *         apiKeyEnv: VALE_API_KEY
 *         models: [{ id: og/mimo-v2.5, contextWindow: 1000000, maxTokens: 128000, input: [text, image] }]
 *
 * This module is that, in KV, under the key `providers:custom`.
 *
 * WHERE A PROVIDER IS CONSULTED. `resolveRoute` (upstream.ts) is the only
 * reader, and the order is the contract:
 *
 *     1. ROUTE_TABLE[prefix]        — a BUILT-IN channel always wins
 *     2. providers:custom[prefix]   — a custom provider (this file)
 *     3. defaultRoute               — no prefix / genuinely unknown prefix
 *
 * Built-ins win because a record that shadowed `og/` (hand-edited KV, or written
 * before a built-in channel existed) would silently re-point every existing
 * route — and the user's key with it — at a third party. Creation-time
 * validation refuses RESERVED_PREFIXES for operator feedback; step 1 is the
 * guard that does not depend on any write path. A provider record that exists
 * but cannot be routed (unknown dialect, no baseURL) is an ERROR route, never
 * the default channel: falling through would dial a built-in upstream under a
 * different provider's key.
 *
 * WHAT IS REPORTED WHERE (the rest of the integration):
 *   /v1/models            — yes, `prefix + wire` per model, `owned_by` = label,
 *                           plus `context_window`/`max_tokens`/`name` when the
 *                           record declares them (DSH's model discovery reads
 *                           exactly those).
 *   console catalogue     — yes: `catalogue()` merges one route card per
 *                           provider (backend = label, desc names host+protocol).
 *   /api/health           — NO card, deliberately. HEALTH_CHANNELS is a
 *                           compile-time probe list and every card costs an
 *                           upstream call on a PUBLIC, unauthenticated endpoint;
 *                           adding operator-declared third parties there would
 *                           turn /api/health into an amplifier aimed wherever a
 *                           provider record points. Reachability of a custom
 *                           provider is the operator's to check.
 *
 * THE RECORD STORES WIRE NAMES. `models[].id` is what the UPSTREAM is asked for;
 * the advertised id is `prefix + id` (see advertisedModelId). A model id that
 * already carries the prefix — the full-id spelling an operator may copy from a
 * client config — is normalized on the way in, so the record has exactly ONE
 * representation and cannot advertise `my/my/llama`.
 *
 * THE KEY. `apiKeyEnv` is DSH's spelling: the NAME of a Worker env binding /
 * secret, resolved against `env` at request time. `apiKey` is the inline
 * alternative, stored in the same KV namespace that already holds the BYOK user
 * keys and the Cloudflare API token (store/devices.ts) — a secret-binding-only
 * design would make a registry whose entire point is "no rebuild" require a
 * rebuild. Exactly one of the two may be set; the inline value is NEVER returned
 * by the admin API (see publicProvider, which reuses maskKey like the model
 * handlers do).
 */
import { cget, cset, cdel, withKeyLock, type Env } from "./cache.ts";
import { RESERVED_PREFIXES } from "../channels.ts";
import { deviceHostError } from "../device-fetch.ts";
import { maskKey } from "./users.ts";

const CUSTOM_KEY = "providers:custom";

/**
 * The wire dialects this registry can SERVE — dialect → the path appended to
 * `baseURL`. ONE table, because it backs both the creation-time validation and
 * the routing join (upstream.ts's providerRoute): a dialect that validates but
 * has no path here cannot exist, and vice versa.
 *
 * `openai-completions` is DSH's name for OpenAI chat/completions. It is served
 * by the code that already exists — the raw passthrough for OpenAI-format
 * clients, and `toOpenAIRequest` + `openAIUpstreamToAnthropicResponse` for
 * Anthropic-format ones — exactly the og/ and cm/ path. No new translator.
 *
 * `anthropic-messages` is DELIBERATELY absent: the gateway has no OpenAI →
 * Anthropic REQUEST translator, so such a provider would serve /v1/messages and
 * fail every OpenAI-format client upstream — precisely the "accepted at
 * creation, fails at request time" outcome a creation-time refusal exists to
 * prevent. See KNOWN_UNSUPPORTED_APIS for the message an operator gets.
 */
export const SUPPORTED_PROVIDER_APIS: Record<string, string> = {
  "openai-completions": "/chat/completions",
};

/** Named rejections: the dialects an operator is most likely to reach for, and
 *  WHY this build does not serve them. A generic "unsupported" would leave the
 *  reason to be rediscovered. */
const KNOWN_UNSUPPORTED_APIS: Record<string, string> = {
  "anthropic-messages":
    "this gateway has no OpenAI→Anthropic request translator, so the provider would serve /v1/messages and fail every OpenAI-format client",
};

/** One model of a custom provider. Mirrors what DSH's settings.yaml declares. */
export interface ProviderModel {
  /** The WIRE name — what the upstream is asked for. */
  id: string;
  /** Display name, advertised on /v1/models. */
  name?: string;
  /** DSH `input: [text, image]`: the model sees images itself, so gateway-side
   *  vision preprocessing must stay OUT of the way (preprocessImages). */
  vision?: boolean;
  /** Declared limits, advertised on /v1/models as context_window/max_tokens. */
  contextWindow?: number;
  maxTokens?: number;
}

/** A custom provider record (one `providers:custom` entry). */
export interface ProviderSpec {
  /** Routing prefix WITH its trailing slash — the ROUTE_INFO spelling ("my/"). */
  prefix: string;
  /** Console/route-card name. Defaults to the prefix without its slash. */
  label: string;
  /** Upstream root; the dialect's path is APPENDED to it (see providerRoute in
   *  upstream.ts for why it is a prefix and not a URL to resolve against). */
  baseURL: string;
  /** Wire dialect — a key of SUPPORTED_PROVIDER_APIS. */
  api: string;
  /** NAME of a Worker env binding/secret holding the key (DSH's apiKeyEnv). */
  apiKeyEnv?: string;
  /** Inline key. NEVER returned by the admin API. */
  apiKey?: string;
  models: ProviderModel[];
}

/** The admin/console view of a record — an inline key is replaced by maskKey(). */
export interface PublicProviderSpec {
  prefix: string;
  label: string;
  baseURL: string;
  api: string;
  /** As STORED (wire names), so a POST body round-trips. */
  models: ProviderModel[];
  /** What clients are advertised — `prefix + wire`, the ids /v1/models serves. */
  advertised: string[];
  /** The env NAME (never a value). "" when the key is inline. */
  keyEnv: string;
  /** maskKey() of the key this deployment would send — never the key. */
  keyMasked: string;
  /** Whether a key resolves in THIS deployment right now. */
  keyReady: boolean;
}

/** One advertised model, with the record it belongs to. The single shape every
 *  consumer reads (advertisedIds, catalogue, /v1/models, vision lookup), so the
 *  prefix+wire join exists once. */
export interface AdvertisedProviderModel {
  /** prefix + wire — the id clients send and /v1/models serves. */
  id: string;
  /** The wire name the upstream is asked for. */
  wire: string;
  provider: ProviderSpec;
  model: ProviderModel;
}

/** The bare routing form of a record prefix ("my/" → "my"). */
export function barePrefix(prefix: unknown): string {
  return String(prefix ?? "").replace(/\/+$/, "");
}

/** The advertised id of a wire model under a prefix — prefix ONCE, never twice. */
export function advertisedModelId(prefix: string, wire: string): string {
  const bare = barePrefix(prefix);
  const w = String(wire ?? "").replace(/^\/+/, "");
  return w.startsWith(bare + "/") ? w : `${bare}/${w}`;
}

/** Read a JSON array from KV, tolerating anything malformed — a registry that
 *  cannot be parsed must degrade to "no custom providers", never to a 500 that
 *  takes the whole gateway down (same discipline as store/models.ts). */
async function readList(env: Env): Promise<ProviderSpec[]> {
  const hit = cget(CUSTOM_KEY);
  if (hit !== undefined) return Array.isArray(hit) ? (hit as ProviderSpec[]) : [];
  let out: ProviderSpec[] = [];
  try {
    const raw = await env.KEYS.get(CUSTOM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out = parsed as ProviderSpec[];
    }
  } catch {
    // Malformed or unreadable: no custom providers. Silent to the CALLER,
    // visible to the operator — the prefix then resolves as unknown.
  }
  cset(CUSTOM_KEY, out);
  return out;
}

async function writeList(env: Env, value: unknown[]): Promise<void> {
  await env.KEYS.put(CUSTOM_KEY, JSON.stringify(value));
  cset(CUSTOM_KEY, value);
}

/** Every custom provider record. */
export async function customProviders(env: Env): Promise<ProviderSpec[]> {
  return readList(env);
}

/** The record for a routing prefix (bare or slashed), or null. */
export async function providerForPrefix(env: Env, prefix: string): Promise<ProviderSpec | null> {
  const bare = barePrefix(prefix);
  if (!bare) return null;
  for (const p of await readList(env)) {
    if (barePrefix(p?.prefix) === bare) return p;
  }
  return null;
}

/** Add or REPLACE a provider, keyed by prefix (the upsert the admin POST is).
 *  Serialized per key: two concurrent POSTs used to be able to read the same
 *  pre-write list and have the second clobber the first (the withKeyLock
 *  discipline store/devices.ts uses for the same reason). */
export async function putCustomProvider(env: Env, spec: ProviderSpec): Promise<ProviderSpec[]> {
  return withKeyLock(CUSTOM_KEY, async () => {
    const cur = await readList(env);
    const next = [...cur.filter((p) => barePrefix(p?.prefix) !== barePrefix(spec.prefix)), spec];
    await writeList(env, next);
    return next;
  });
}

/** Remove a provider this store owns. Returns false when the prefix is not one. */
export async function deleteCustomProvider(env: Env, prefix: string): Promise<boolean> {
  return withKeyLock(CUSTOM_KEY, async () => {
    const cur = await readList(env);
    const bare = barePrefix(prefix);
    const next = cur.filter((p) => barePrefix(p?.prefix) !== bare);
    if (next.length === cur.length) return false;
    await writeList(env, next);
    return true;
  });
}

/**
 * Every advertised custom-provider model, in record order.
 *
 * Malformed records are skipped HERE rather than at each call site: a
 * hand-edited KV blob (a `models` that is not an array, an entry without an id)
 * must not be able to break /v1/models for every client.
 */
export async function advertisedProviderModels(env: Env): Promise<AdvertisedProviderModel[]> {
  const out: AdvertisedProviderModel[] = [];
  for (const p of await readList(env)) {
    if (!p || typeof p !== "object") continue;
    const prefix = barePrefix(p.prefix);
    if (!prefix) continue;
    const models = Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      const wire = String(m?.id ?? "")
        .trim()
        .replace(/^\/+/, "");
      if (!wire) continue;
      out.push({ id: advertisedModelId(prefix, wire), wire, provider: p, model: m });
    }
  }
  return out;
}

/** The key this deployment would send for a provider: the inline value, else the
 *  named env binding/secret, else "". */
export function providerKey(env: any, p: ProviderSpec | undefined | null): string {
  if (!p) return "";
  if (p.apiKey) return String(p.apiKey);
  if (p.apiKeyEnv) return String(env?.[p.apiKeyEnv] ?? "");
  return "";
}

/** Does the provider's own record declare this WIRE model as seeing images?
 *  (DSH's `input: [text, image]`.) */
export function providerModelVision(p: ProviderSpec | undefined | null, wire: string): boolean {
  const models = Array.isArray(p?.models) ? (p?.models as ProviderModel[]) : [];
  return models.some((m) => m?.id === wire && m?.vision === true);
}

/** The admin/console view. An inline key leaves this function ONLY as
 *  maskKey(value) — the same rule adminListUsers and adminGetCfToken follow. */
export function publicProvider(p: ProviderSpec, env: any): PublicProviderSpec {
  const resolved = providerKey(env, p);
  const models = Array.isArray(p.models) ? p.models : [];
  return {
    prefix: p.prefix,
    label: p.label,
    baseURL: p.baseURL,
    api: p.api,
    models: models.map((m) => ({ ...m })),
    advertised: models.map((m) => advertisedModelId(p.prefix, String(m?.id ?? ""))),
    keyEnv: p.apiKeyEnv || "",
    keyMasked: resolved ? maskKey(resolved) : "",
    keyReady: !!resolved,
  };
}

/* ---------------- Validation ----------------
 *
 * Creation is the ONLY place an operator gets to hear about a mistake: a record
 * that is accepted here is dialled on the next request. So every field is
 * checked here — including the SSRF host check, which REUSES device-fetch's
 * guard stack (deviceHostError) instead of a second copy of the private-IP
 * rules that would drift from it.
 */

/** Why a provider record was refused, and with which HTTP status. */
export interface ProviderParseError {
  error: string;
  /** 400 = the record is wrong; 409 = it collides with a reserved prefix. */
  status: number;
}

const MODEL_FIELDS = ["id", "name", "input", "contextWindow", "maxTokens"];

/** `input` values this gateway understands; anything else is refused rather
 *  than stored-and-ignored. */
const KNOWN_MODALITIES = ["text", "image"];

function parseProviderModel(raw: any, at: number): { model?: ProviderModel; error?: string } {
  const where = `models[${at}]`;
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { model: { id } } : { error: `${where}: empty model id` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${where} must be a model id string or an object` };
  }
  const unknown = Object.keys(raw).filter((k) => !MODEL_FIELDS.includes(k));
  if (unknown.length) {
    return {
      error: `${where}: unsupported field(s) ${unknown.join(", ")} — this gateway stores ${MODEL_FIELDS.join(", ")}`,
    };
  }
  const id = String(raw.id ?? "").trim();
  if (!id) return { error: `${where}: id is required` };
  if (/\s/.test(id)) return { error: `${where}.id must not contain whitespace` };
  const model: ProviderModel = { id };
  if (raw.name !== undefined) {
    const name = String(raw.name).trim();
    if (name) model.name = name;
  }
  if (raw.input !== undefined) {
    if (!Array.isArray(raw.input)) {
      return { error: `${where}.input must be an array of ${KNOWN_MODALITIES.join("/")}` };
    }
    const bad = raw.input.filter((m: any) => !KNOWN_MODALITIES.includes(String(m)));
    if (bad.length) {
      return {
        error: `${where}.input: unsupported modalit${bad.length > 1 ? "ies" : "y"} ${bad
          .map((b: any) => JSON.stringify(String(b)))
          .join(", ")} — only ${KNOWN_MODALITIES.join(" and ")} are understood`,
      };
    }
    // A model that declares image input must NOT have its images described by
    // the gateway's vision model (preprocessImages) — it can see them itself.
    if (raw.input.map(String).includes("image")) model.vision = true;
  }
  for (const cap of ["contextWindow", "maxTokens"] as const) {
    const v = raw[cap];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: `${where}.${cap} must be a positive integer` };
    }
    model[cap] = n;
  }
  return { model };
}

/** Parse + validate a POST /api/admin/providers body. Pure — the admin handler
 *  only has to map the error onto a status. */
export function parseProviderSpec(
  body: any,
): { spec?: ProviderSpec } & Partial<ProviderParseError> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object", status: 400 };
  }
  // Lowercase only: routing derives the prefix by splitting the CLIENT's model
  // id on "/", so a mixed-case prefix could never match a lowercase one.
  const prefix = String(body.prefix ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,30}\/$/.test(prefix)) {
    return {
      error: `prefix must be a lowercase channel prefix ending in "/" (e.g. "my/") — got ${JSON.stringify(prefix)}`,
      status: 400,
    };
  }
  const bare = barePrefix(prefix);
  if (RESERVED_PREFIXES.includes(bare)) {
    return {
      error: `prefix ${JSON.stringify(prefix)} is reserved by a built-in channel (reserved: ${RESERVED_PREFIXES.join(", ")})`,
      status: 409,
    };
  }
  const label = String(body.label ?? "").trim() || bare;
  // eslint-disable-next-line no-control-regex
  if (label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    return {
      error: "label must be at most 80 characters, with no control characters",
      status: 400,
    };
  }
  const rawBase = String(body.baseURL ?? "").trim();
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return { error: `baseURL is not a URL — got ${JSON.stringify(rawBase)}`, status: 400 };
  }
  if (url.protocol !== "https:") {
    return {
      error: `baseURL must be https (got ${url.protocol}//) — a provider key must never travel in clear`,
      status: 400,
    };
  }
  if (url.username || url.password) {
    return { error: "baseURL must not embed credentials", status: 400 };
  }
  if (url.search || url.hash) {
    return { error: "baseURL must not carry a query or a fragment", status: 400 };
  }
  // The SSRF check, REUSED (device-fetch.ts) — loopback/private/link-local/
  // metadata hosts are refused here for the same reason a device hostname is:
  // the gateway would dial them with a credential attached.
  const hostErr = deviceHostError(url.hostname);
  if (hostErr) return { error: `baseURL host rejected: ${hostErr}`, status: 400 };
  // Treated as a PREFIX, not resolved against (see providerRoute): a deployment
  // path such as https://host/openai/v1 must survive.
  const baseURL = (url.origin + url.pathname).replace(/\/+$/, "");
  const api = String(body.api ?? "").trim();
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_PROVIDER_APIS, api)) {
    const why = KNOWN_UNSUPPORTED_APIS[api];
    return {
      error:
        `unsupported protocol ${JSON.stringify(api)} — this gateway serves ` +
        `${Object.keys(SUPPORTED_PROVIDER_APIS).join(", ")}${why ? ` (${api}: ${why})` : ""}`,
      status: 400,
    };
  }
  const apiKeyEnv = String(body.apiKeyEnv ?? "").trim();
  const apiKey = String(body.apiKey ?? "").trim();
  if (apiKeyEnv && apiKey) {
    return {
      error:
        "set apiKeyEnv (a deployed Worker secret) or apiKey (inline), not both — two key sources cannot both be the one this provider sends",
      status: 400,
    };
  }
  if (!apiKeyEnv && !apiKey) {
    return {
      error:
        "a key is required: apiKeyEnv (the NAME of a Worker secret, DSH's settings.yaml spelling) or apiKey (an inline value stored in KV)",
      status: 400,
    };
  }
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    return {
      error: `apiKeyEnv must be a Worker env/secret NAME (letters, digits, "_" — e.g. VALE_API_KEY), not a value — got ${JSON.stringify(apiKeyEnv)}`,
      status: 400,
    };
  }
  if (apiKey && (apiKey.length < 8 || /\s/.test(apiKey))) {
    // <8 also keeps the credential out of redactSecrets' "too generic to
    // replace safely" bucket, so an upstream echo of it is still redacted.
    return { error: "apiKey must be at least 8 characters with no whitespace", status: 400 };
  }
  if (!Array.isArray(body.models) || body.models.length === 0) {
    return { error: "models must be a non-empty array", status: 400 };
  }
  if (body.models.length > 200) {
    return { error: `models: at most 200 entries (got ${body.models.length})`, status: 400 };
  }
  const models: ProviderModel[] = [];
  for (let i = 0; i < body.models.length; i++) {
    const { model, error } = parseProviderModel(body.models[i], i);
    if (error || !model) return { error: error || `models[${i}] is invalid`, status: 400 };
    // Normalize to the WIRE form: the full-id spelling (prefix included) is
    // accepted, stored once, and never advertised twice.
    const wire = model.id.startsWith(bare + "/") ? model.id.slice(bare.length + 1) : model.id;
    if (!wire) return { error: `models[${i}]: empty model id after the prefix`, status: 400 };
    if (models.some((m) => m.id === wire)) {
      return {
        error: `models[${i}]: duplicate model id ${advertisedModelId(bare, wire)}`,
        status: 400,
      };
    }
    models.push({ ...model, id: wire });
  }
  const spec: ProviderSpec = { prefix, label, baseURL, api, models };
  if (apiKeyEnv) spec.apiKeyEnv = apiKeyEnv;
  if (apiKey) spec.apiKey = apiKey;
  return { spec };
}

/** Forget the per-isolate cache (tests, and any explicit resync). */
export function dropProviderCache(): void {
  cdel(CUSTOM_KEY);
}
