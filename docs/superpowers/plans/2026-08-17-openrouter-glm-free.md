# OpenRouter GLM Free Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `or/z-ai/glm-5.2:free` to Vale's OpenRouter BYOK model list, routing UI, health cards, tests, and production gateway.

**Architecture:** Reuse the existing `or/` passthrough route. The Vale prefix is stripped only at the gateway boundary; the complete upstream model `z-ai/glm-5.2:free` is sent to OpenRouter with the user's `OPENROUTER_API_KEY`. The health UI gets a second `or` card that shares the existing OpenRouter circuit state.

**Tech Stack:** Cloudflare Worker, TypeScript, Node test runner, OpenRouter API, Wrangler.

## Global Constraints

- Use the existing OpenRouter BYOK route and `OPENROUTER_API_KEY`.
- Do not route GLM through OpenCode Go, the Luna remap, or Anthropic/OpenAI translation.
- Preserve the exact upstream model name `z-ai/glm-5.2:free`.
- Keep the existing OpenRouter Luna model and health card unchanged.
- Use English conventional commit messages with the repository's stage tag convention.
- Run the full gateway test suite before deployment.

---

### Task 1: Register GLM model and health card

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/src/channels.ts:30-88`
- Test: `/home/zhengsaisi/vale/gateway/test/health.test.mjs:40-46`

**Interfaces:**
- Consumes: existing `MODELS`, `ROUTE_INFO`, `HEALTH_CHANNELS`, and duplicate-id health behavior.
- Produces: public model id `or/z-ai/glm-5.2:free`, OpenRouter route-card entry `z-ai/glm-5.2:free`, and health card `{ id: "or", model: "or/z-ai/glm-5.2:free" }`.

- [ ] **Step 1: Update the registry and metadata**

Add the model to the OpenRouter section of `MODELS`:

```ts
{ id: "or/z-ai/glm-5.2:free", owned_by: "openrouter" },
```

Add the upstream name to the existing `or/` route's `models` array:

```ts
models: ["openai/gpt-5.6-luna:floor[1m]", "z-ai/glm-5.2:free"],
```

Append the health card after the existing OpenRouter Luna card:

```ts
{ id: "or", model: "or/z-ai/glm-5.2:free" },
```

Update only comments that describe the number of cards or the OpenRouter card contents; do not alter circuit logic or the existing Luna entry.

- [ ] **Step 2: Update the health-card test**

Change the expected channel model sequence to include the new card while preserving duplicate `or` IDs:

```js
assert.deepEqual(
  h.channels.map((c) => c.id),
  ["ds", "qw", "og", "og", "or", "or"],
);
assert.deepEqual(
  h.channels.map((c) => c.model),
  [
    "ds/deepseek-v4-flash",
    "qw/qwen3.8-max-preview",
    "og/deepseek-v4-flash",
    "og/gpt-5.6-luna",
    "or/openai/gpt-5.6-luna:floor[1m]",
    "or/z-ai/glm-5.2:free",
  ],
);
```

Keep the existing deduplicated prefix assertion unchanged:

```js
assert.deepEqual([...new Set(h.channels.map((c) => c.id))], ["ds", "qw", "og", "or"]);
```

- [ ] **Step 3: Run focused health tests**

Run:

```bash
cd /home/zhengsaisi/vale/gateway && node --test test/health.test.mjs
```

Expected: all health tests pass, including the six-card sequence and four unique prefixes.

- [ ] **Step 4: Commit the registry slice**

```bash
cd /home/zhengsaisi/vale
git add gateway/src/channels.ts gateway/test/health.test.mjs
git commit -m "feat(stage-k): add OpenRouter GLM free model"
```

---

### Task 2: Add OpenRouter passthrough regression coverage

**Files:**
- Modify: `/home/zhengsaisi/vale/gateway/test/gateway.test.mjs:72-125`

**Interfaces:**
- Consumes: existing `gwEnv`, `post`, `withFetch`, `handleGateway`, and OpenRouter route behavior.
- Produces: a test proving GLM uses OpenRouter BYOK and does not require OpenCode Go.

- [ ] **Step 1: Add the failing behavioral test**

Add this test beside the existing OpenRouter/OpenCode route tests:

```js
test("or/z-ai/glm-5.2:free uses OpenRouter BYOK passthrough", async () => {
  __clearCaches();
  const { env, token } = gwEnv({
    keys: {
      OPENCODE_GO_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-openrouter-glm",
    },
  });
  let seen;
  const res = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "glm" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, () => post(env, token, {
    model: "or/z-ai/glm-5.2:free",
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.match(String(seen.url), /openrouter/);
  const auth = seen.init.headers.get
    ? seen.init.headers.get("authorization")
    : seen.init.headers.Authorization;
  assert.equal(auth, "Bearer sk-openrouter-glm");
  assert.equal(JSON.parse(seen.init.body).model, "z-ai/glm-5.2:free");
  assert.equal(res.status, 200);
});
```

The response shape should match the existing `or/` passthrough tests if the current implementation expects an Anthropic response; if the test fails because the mock shape is invalid, use the existing successful `or/` response fixture without changing production behavior.

- [ ] **Step 2: Run the focused test**

Run:

```bash
cd /home/zhengsaisi/vale/gateway && node --test test/gateway.test.mjs
```

Expected: the new GLM test passes and no existing gateway test fails.

- [ ] **Step 3: Run the complete gateway suite**

Run:

```bash
cd /home/zhengsaisi/vale/gateway && npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Commit the regression test**

```bash
cd /home/zhengsaisi/vale
git add gateway/test/gateway.test.mjs
git commit -m "test(stage-k): verify OpenRouter GLM passthrough"
```

---

### Task 3: Deploy and verify production routing

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the committed registry and regression tests from Tasks 1–2.
- Produces: deployed gateway and live evidence that the GLM card and route work.

- [ ] **Step 1: Run the final gateway test suite**

```bash
cd /home/zhengsaisi/vale/gateway && npm test
```

Expected: zero failures.

- [ ] **Step 2: Deploy the gateway**

```bash
cd /home/zhengsaisi/vale && ./scripts/build.sh gateway
```

Expected: Wrangler uploads `vale-gate` and prints a new Current Version ID.

- [ ] **Step 3: Verify the live health card**

```bash
curl -fsSL https://api.saisi.online/api/health
```

Expected JSON contains both:

```text
or/openai/gpt-5.6-luna:floor[1m]
or/z-ai/glm-5.2:free
```

and both report `ok` or an explicit upstream health result, not a missing model card.

- [ ] **Step 4: Verify the live model registry**

```bash
curl -fsSL https://api.saisi.online/api/admin/public
```

Expected JSON includes:

```text
or/z-ai/glm-5.2:free
```

and the `or/` route metadata includes `z-ai/glm-5.2:free`.

- [ ] **Step 5: Send a real small request**

Use an authorized Vale gateway token and the configured user's OpenRouter key to send a one-token request:

```bash
curl -fsS https://api.saisi.online/v1/messages \
  -H 'x-api-key: <authorized-vale-token>' \
  -H 'content-type: application/json' \
  --data '{"model":"or/z-ai/glm-5.2:free","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}'
```

Expected: a successful Anthropic-format response or a provider rate-limit response from OpenRouter; the response must not say that `OPENCODE_GO_API_KEY` is missing and must not route to OpenCode.

- [ ] **Step 6: Commit any only-if-needed test adjustment and push all commits**

```bash
cd /home/zhengsaisi/vale
git push origin main
git status --short
```

Expected: push succeeds and the working tree is clean.
