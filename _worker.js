// _worker.js - Entry point for Cloudflare Worker & Pages
import { onRequest } from "./functions/api/[[route]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route /api/* requests to the API router
    if (url.pathname.startsWith("/api/")) {
      const pathWithoutApi = url.pathname.replace(/^\/api\/?/, "");
      const routeParam = pathWithoutApi.split("/").filter(Boolean);
      return onRequest({ request, env, ctx, params: { route: routeParam } });
    }

    // All other requests serve static HTML/CSS/JS assets
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

