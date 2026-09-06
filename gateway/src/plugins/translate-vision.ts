/**
 * translate-vision — gateway-side vision pre-processing (structure refactor:
 * extracted verbatim from plugins/translate.ts; the vision subsystem has its
 * own env vars (VISION_MODEL / VISION_CAPABLE_MODELS), its own KV cache
 * namespace and its own upstream call shapes, so it lives on its own).
 *
 * The gateway's own models (deepseek, minimax, ...) are text-only. If an incoming
 * request carries Anthropic image blocks and the target model isn't on the
 * vision-capable allowlist, describe each image with a vision model (default
 * og/mimo-v2.5, configurable via env VISION_MODEL) and replace the image blocks
 * with the returned text so every model can "see" the picture.
 */

import { getGlobalSetting, globalSettingEnabled } from "../store.ts";
import { toOpenAIRequest } from "../anthropic-translate.ts";
import { fetchWithTimeout, upstreamTimeoutMs } from "../reliability.ts";
import { pickRoute, passthroughHeaders, stripBracket } from "../upstream.ts";

export function isVisionCapable(model: string, upstreamModel: string, env: any): boolean {
  const list = String(env.VISION_CAPABLE_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(model) || list.includes(upstreamModel);
}

export async function preprocessImages(
  messages: any,
  env: any,
  ukeys: any,
  model: string,
  upstreamModel: string,
  uid: string,
): Promise<{ messages: any[]; changed: boolean }> {
  if (!Array.isArray(messages)) return { messages, changed: false };
  if (isVisionCapable(model, upstreamModel, env)) return { messages, changed: false };
  const visionModel = env.VISION_MODEL || "og/mimo-v2.5";
  let changed = false;
  const out: any[] = [];
  // Every image block gets a REAL description (round-43's placeholder carried
  // no content — a turn-2 follow-up about a turn-1 screenshot was answered
  // blind because the description existed only in the forwarded body, never
  // in the client transcript). describeImage has a KV cache (keyed by the
  // base64 data hash), so re-sent history images hit the cache — no vision
  // call, no extra cost. Image conversations parse every turn (they must, to
  // swap history images for their cached descriptions) — acceptable: image
  // sessions are rare and the 1102 risk is bounded to them.
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content !== "object" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    if (!m.content.some((b: any) => b.type === "image")) {
      out.push(m);
      continue;
    }
    const newContent = [];
    for (const b of m.content) {
      if (b.type === "image") {
        const desc = await describeImage(env, ukeys, b.source, visionModel, uid);
        // round-119: a describe failure was silently injected as
        // "[图片内容描述]\n(图片描述失败…)" — the client believed the image
        // was seen and answered blind. A failed describe must FAIL the
        // request (the client sees the error and retries/removes the image)
        // instead of fabricating a description.
        if (/图片描述失败|图片描述为空|图片数据为空/.test(desc)) {
          throw new Error(
            `vision preprocessing failed: ${desc.replace(/^\((图片描述失败|图片描述为空|图片数据为空)[：:]?/, "")}`,
          );
        }
        newContent.push({ type: "text", text: `[图片内容描述]\n${desc}` });
        changed = true;
      } else {
        newContent.push(b);
      }
    }
    out.push({ ...m, content: newContent });
  }
  return { messages: out, changed };
}
async function cacheImageDesc(cacheKey: string, env: any, desc: string): Promise<void> {
  if (!cacheKey || !env?.KEYS) return;
  if (!desc || /图片描述失败|图片描述为空/.test(desc)) return;
  try {
    await env.KEYS.put(cacheKey, desc, { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    /* KV write failed */
  }
}
async function describeImage(
  env: any,
  ukeys: any,
  source: any,
  visionModel: string,
  uid: string,
): Promise<string> {
  const mediaType = source?.media_type || "image/png";
  const data = source?.data || "";
  if (!data) return "(图片数据为空)";
  // round-119: vision preprocessing must respect the US exit too — the old
  // pickRoute(prefix, env) resolved the upstream DIRECT (no usProxy arg),
  // so with US_PROXY=1 the describe call went straight to a blocked/slow
  // zen while ordinary requests rode the proxy (and every image turned
  // into "(图片描述失败…)" placeholders for US users).
  // round-491: a KV outage must not fail the describe — every other KV read
  // on this path is best-effort (cache read/write catch below); the proxy
  // switch defaults to direct when unreadable.
  const usProxyRaw = await getGlobalSetting(env, "US_PROXY").catch(() => null);
  // KV description cache: the client re-sends the same base64 image every
  // turn, so a per-image cache turns N vision calls per follow-up into 1.
  // Key = user id + SHA-256(model ":" data), 32 hex chars. The user prefix
  // makes round-45 Medium #1's invariant ACTUALLY true (the old comment
  // claimed user-scoping while the key was content-derived — a foreign
  // description could be served to another user who sent the same bytes);
  // SHA-256 replaces the two-pass 64-bit FNV, which is not
  // collision-resistant (a ~2^32 offline collision could spoof a
  // description onto a colliding image). Security-regression round fix.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${visionModel}:${data}`),
  );
  const h = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cacheKey = data.length > 16 ? `img-desc:${uid || "anon"}:${h}` : "";
  if (cacheKey && env.KEYS) {
    try {
      const hit = await env.KEYS.get(cacheKey);
      if (hit) return hit;
    } catch {
      /* KV read failed */
    }
  }
  const prefix = visionModel.split("/")[0] || "";
  const route = pickRoute(prefix, env, globalSettingEnabled(usProxyRaw) ? "1" : null);
  const upstreamModel = stripBracket(
    route.stripPrefix ? visionModel.slice(prefix.length + 1) : visionModel,
  );
  const content = [
    { type: "image", source: { type: "base64", media_type: mediaType, data } },
    {
      type: "text",
      text: "请用中文详细描述这张图片的内容，包括所有可见文字（OCR）、界面元素、布局。若是截图或表格，请逐行说明关键内容。只输出描述，不要额外说明。",
    },
  ];
  const miniReq = { model: visionModel, max_tokens: 1500, messages: [{ role: "user", content }] };

  if (route.type === "passthrough") {
    // or/ (openrouter) or ds/ (deepseek) vision model — Anthropic passthrough
    const bearerKey =
      route.kind === "openrouter" ? ukeys.OPENROUTER_API_KEY : ukeys.DEEPSEEK_API_KEY;
    if (!bearerKey) return "(图片描述失败：视觉模型后端未配置)";
    let resp: any;
    try {
      resp = await fetchWithTimeout(
        route.upstream,
        {
          method: "POST",
          headers: passthroughHeaders(bearerKey),
          body: JSON.stringify({ ...miniReq, model: upstreamModel }),
        },
        upstreamTimeoutMs(env),
      );
    } catch (e: any) {
      return `(图片描述失败：${e.message})`;
    }
    if (!resp.ok) return `(图片描述失败：${resp.status})`;
    let json: any;
    try {
      json = await resp.json();
    } catch {
      return "(图片描述失败：响应解析失败)";
    }
    const text = (json.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    const descPt = text || "(图片描述为空)";
    await cacheImageDesc(cacheKey, env, descPt);
    return descPt;
  }

  // og/ vision model (opencode zen) — needs the Anthropic→OpenAI translation,
  // which now forwards image_url parts (see toOpenAIRequest).
  if (!ukeys.OPENCODE_GO_API_KEY) return "(图片描述失败：OPENCODE_GO_API_KEY 未配置)";
  const openaiReq = toOpenAIRequest(miniReq, upstreamModel);
  let resp: any;
  try {
    resp = await fetchWithTimeout(
      route.upstream,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ukeys.OPENCODE_GO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openaiReq),
      },
      upstreamTimeoutMs(env),
    );
  } catch (e: any) {
    return `(图片描述失败：${e.message})`;
  }
  if (!resp.ok) return `(图片描述失败：${resp.status})`;
  let json: any;
  try {
    json = await resp.json();
  } catch {
    return "(图片描述失败：响应解析失败)";
  }
  const desc = (json.choices?.[0]?.message?.content || "").trim() || "(图片描述为空)";
  await cacheImageDesc(cacheKey, env, desc);
  return desc;
}
