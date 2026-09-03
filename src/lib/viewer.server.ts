/**
 * viewer.server.ts — who is asking, and what tier are they.
 *
 * The generated `requireSupabaseAuth` middleware THROWS when there is no
 * Authorization header, which is right for a private endpoint and wrong for
 * every page here: an anonymous visitor must still get a response, just a
 * redacted one. So this is the soft equivalent — it never throws, and an
 * unauthenticated request simply resolves to the anonymous tier.
 *
 * SERVER ONLY. The middleware that pairs with this lives in viewer.ts, because
 * its client half would drag `getRequest` into the browser bundle if the two
 * shared a file.
 *
 * A failure anywhere in here degrades to anonymous rather than erroring. That
 * is the safe direction: a broken token check should hide predictions, never
 * reveal them.
 */

import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { Tier } from "./entitlements";

export type Viewer = { userId: string | null; tier: Tier; email: string | null };

export const ANONYMOUS: Viewer = { userId: null, tier: "anonymous", email: null };

/** Read the bearer token off the incoming request, if there is one. */
function bearerToken(): string | null {
  try {
    const auth = getRequest()?.headers?.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the viewer for this request.
 *
 * The tier is read with the SERVICE ROLE rather than the user's own client.
 * Not for convenience — `profiles` has no UPDATE policy for authenticated
 * users, so the tier cannot be forged from the browser either way — but because
 * it keeps the entitlement lookup working regardless of how RLS on that table
 * changes later. The user id still comes from verifying their token, so this
 * cannot be used to read someone else's tier.
 */
export async function resolveViewer(): Promise<Viewer> {
  const token = bearerToken();
  if (!token) return ANONYMOUS;

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return ANONYMOUS;

  try {
    const client = createClient<Database>(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getClaims(token);
    const userId = data?.claims?.sub;
    if (error || !userId) return ANONYMOUS;

    const email = (data.claims.email as string | undefined) ?? null;

    // A signed-in user is at least free, even if the profile row is missing or
    // the lookup fails. Failing to read a tier should not sign someone out.
    const admin = supabaseAdmin as unknown as
      | { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
      | undefined;
    if (!admin) return { userId, tier: "free", email };

    const { data: profile } = await admin
      .from("profiles")
      .select("tier")
      .eq("id", userId)
      .maybeSingle();
    const tier: Tier = profile?.tier === "premium" ? "premium" : "free";
    return { userId, tier, email };
  } catch (err) {
    console.error("[viewer] resolve failed, treating as anonymous:", err);
    return ANONYMOUS;
  }
}
