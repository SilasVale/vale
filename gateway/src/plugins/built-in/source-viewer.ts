/**
 * Source viewer plugin — serves the code browsing UI from public/code/.
 *
 * Routes:
 *   GET /code/manifest.json → file manifest
 *   GET /code/<path>        → source file content
 */

import type { Plugin, PluginContext } from "../types.ts";

export const sourceViewerPlugin: Plugin = {
  name: "source-viewer",
  deps: [],
  setup(ctx: PluginContext) {
    // Serve source files from public/code/
    // This is handled by Cloudflare's asset serving (assets.directory in wrangler.jsonc)
    // The plugin just registers the /code/manifest.json route for the file list

    ctx.routes.push({
      match: (method, path) => method === "GET" && path === "/code/manifest.json",
      handler: async (_request, _env, _ctx) => {
        // The manifest is served by Cloudflare assets
        // This route is a fallback for environments without asset serving
        return new Response(JSON.stringify({ files: [] }), {
          headers: { "Content-Type": "application/json", ...ctx.helpers.CORS_HEADERS },
        });
      },
    });
  },
};
