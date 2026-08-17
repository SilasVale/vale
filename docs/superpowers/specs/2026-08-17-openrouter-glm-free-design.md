# OpenRouter GLM Free Model Design

## Context

Vale already exposes OpenRouter models through the `or/` route. The requested `z-ai/glm-5.2:free` model is an OpenRouter free-tier model, so it must use the existing OpenRouter BYOK passthrough and the user's `OPENROUTER_API_KEY`. It must not be routed through OpenCode Go, the Luna remap, or the Anthropic/OpenAI translation path.

## Recommended design

Add the public model identifier `or/z-ai/glm-5.2:free` to the single channel registry in `gateway/src/channels.ts` with `owned_by: "openrouter"`. Add `z-ai/glm-5.2:free` to the OpenRouter route-card model list so it appears in the model-routing UI.

Add a second OpenRouter health card:

```ts
{ id: "or", model: "or/z-ai/glm-5.2:free" }
```

The existing OpenRouter Luna card remains unchanged. Duplicate `or` IDs intentionally share the existing OpenRouter circuit state while the UI receives separate model cards.

The existing `pickRoute("or", ...)` path remains the only runtime route. It strips only the Vale `or/` prefix, forwards the complete upstream model `z-ai/glm-5.2:free`, and authenticates with `OPENROUTER_API_KEY`. No new provider/channel or translation logic is needed.

## Testing and verification

Add gateway regression coverage that asserts:

- the model registry exposes `or/z-ai/glm-5.2:free`;
- a `/v1/messages` request with that model reaches the OpenRouter route;
- the upstream request body keeps `z-ai/glm-5.2:free`;
- the upstream authorization uses the OpenRouter key;
- the request succeeds without an OpenCode Go key;
- `/api/health` contains the GLM model card while retaining the existing OpenRouter Luna card.

Run the full gateway test suite before deployment. Deploy the gateway, verify the live health response, and send a small real request using `or/z-ai/glm-5.2:free` to confirm the production path. Commit the verified change with an English conventional commit.

## Scope

Only the gateway model registry, route metadata, health-card data, and corresponding tests are in scope. Do not add a separate GLM provider, change OpenRouter credential storage, modify OpenCode routing, or alter installer/domain configuration.
