import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import type { Tier } from "./entitlements";

/**
 * The signed-in user, in the browser.
 *
 * This drives what the nav shows and nothing else. It is NOT what decides which
 * predictions you can see — that happens on the server, where the tier is read
 * from the database and the locked rows are stripped before the payload is
 * built. If this hook were wrong, or edited in a console, the user would see a
 * different badge and exactly the same predictions.
 *
 * The tier here is read from the user's own `profiles` row through RLS, which
 * grants SELECT on your own row and no UPDATE to anyone.
 *
 * EVERY Supabase access here is wrapped, including the property access itself.
 * The exported client is a Proxy that builds the real client on first touch and
 * THROWS synchronously if the environment variables are missing — so
 * `supabase.auth.getSession().catch(...)` does not catch anything, because the
 * throw happens while evaluating `supabase.auth`, before a promise exists. That
 * took down every page on a deploy without those variables. Signed-out is
 * always a valid answer here, so failure resolves to it rather than escaping.
 */

export type ClientViewer = {
  loading: boolean;
  userId: string | null;
  email: string | null;
  tier: Tier;
};

const SIGNED_OUT: ClientViewer = {
  loading: false,
  userId: null,
  email: null,
  tier: "anonymous",
};

export function useViewer(): ClientViewer & { signOut: () => Promise<void> } {
  const [state, setState] = useState<ClientViewer>({ ...SIGNED_OUT, loading: true });

  const load = useCallback(async (userId: string | null, email: string | null) => {
    if (!userId) {
      setState(SIGNED_OUT);
      return;
    }
    // A signed-in user is at least free; a failed tier lookup must not present
    // as signed out.
    let tier: Tier = "free";
    try {
      const { data } = await supabase
        .from("profiles" as never)
        .select("tier")
        .eq("id" as never, userId as never)
        .maybeSingle();
      if ((data as { tier?: string } | null)?.tier === "premium") tier = "premium";
    } catch {
      // Keep the free default. A signed-in user whose tier cannot be read is
      // free, never signed out.
    }
    setState({ loading: false, userId, email, tier });
  }, []);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;

    // Touching `supabase.auth` can throw synchronously — see the note above —
    // so the property access lives inside the try, not just the await.
    (async () => {
      try {
        const auth = supabase.auth;
        const { data } = await auth.getSession();
        if (!alive) return;
        const u = data.session?.user;
        await load(u?.id ?? null, u?.email ?? null);

        const { data: sub } = auth.onAuthStateChange((_e, session) => {
          const su = session?.user;
          void load(su?.id ?? null, su?.email ?? null);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      } catch {
        // No Supabase configured, or no session. Signed out is a valid state.
        if (alive) setState(SIGNED_OUT);
      }
    })();

    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Already effectively signed out.
    }
    setState(SIGNED_OUT);
  }, []);

  return { ...state, signOut };
}
