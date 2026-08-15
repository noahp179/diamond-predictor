import { createMiddleware } from "@tanstack/react-start";

import { supabase } from "@/integrations/supabase/client";
import type { Tier } from "./entitlements";

/**
 * withViewer — attaches the signed-in user and their tier to a server function.
 *
 * Split from viewer.server.ts on purpose. This middleware needs a `.client()`
 * half, which means the module is bundled for the browser; the resolution logic
 * needs `getRequest` and the service-role key, which must never be. So the
 * server half imports its implementation dynamically — the import is inside the
 * callback, so it is only ever evaluated on the server.
 *
 * The client half puts the Supabase access token on the request. Sessions live
 * in localStorage rather than a cookie, so the token has to be attached
 * explicitly; doing it here means no individual server function has to remember.
 *
 * Everything degrades to anonymous rather than throwing. That is the safe
 * direction: a broken token check should hide predictions, never reveal them.
 */

export type Viewer = { userId: string | null; tier: Tier; email: string | null };

export const withViewer = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    let token: string | null = null;
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token ?? null;
    } catch {
      // Not signed in, or Supabase is not configured. Anonymous is a valid state.
    }
    return next(token ? { headers: { authorization: `Bearer ${token}` } } : {});
  })
  .server(async ({ next }) => {
    const { resolveViewer } = await import("./viewer.server");
    return next({ context: { viewer: await resolveViewer() } });
  });
