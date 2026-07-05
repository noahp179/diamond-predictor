import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// One-time canary: if Nitro's config ever regresses and its generic
// static-renderer fallback wins over the real SSR router again (see
// vite.config.ts's `nitro.renderer: false` comment for the full story), every
// page request would silently return the raw index.html shell — a white
// screen with a 200 status and no thrown error, which is exactly why that
// bug was so hard to find the first time. Detect it eagerly and log loudly
// instead of waiting for a support ticket. This marker text lives in
// index.html's <body> comment.
const STATIC_FALLBACK_MARKER = "No client script tag here on purpose";

function logRequest(request: Request, response: Response, durationMs: number, isStaticFallback: boolean) {
  const url = new URL(request.url);
  const line = `[ssr] ${request.method} ${url.pathname} -> ${response.status} (${durationMs.toFixed(0)}ms)`;
  if (isStaticFallback) {
    console.error(
      `${line} ⚠️ SERVED RAW index.html TEMPLATE INSTEAD OF THE RENDERED APP. ` +
        "This means Nitro's generic static-renderer fallback has re-activated " +
        "(see vite.config.ts nitro.renderer). The page will render as a blank " +
        "white screen for users even though this response is a 200.",
    );
  } else {
    console.log(line);
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const startedAt = Date.now();
    try {
      const handler = await getServerEntry();
      let response = await handler.fetch(request, env, ctx);
      response = await normalizeCatastrophicSsrResponse(response);

      const contentType = response.headers.get("content-type") ?? "";
      let isStaticFallback = false;
      if (contentType.includes("text/html")) {
        const body = await response.clone().text();
        isStaticFallback = body.includes(STATIC_FALLBACK_MARKER);
      }
      logRequest(request, response, Date.now() - startedAt, isStaticFallback);
      return response;
    } catch (error) {
      console.error(`[ssr] ${request.method} ${new URL(request.url).pathname} threw:`, error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
