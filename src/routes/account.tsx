import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useViewer } from "@/lib/useViewer";
import { FREE_PREDICTIONS_PER_SPORT } from "@/lib/entitlements";

/**
 * Sign in, sign up, and see which tier you are on.
 *
 * Payments are not wired up yet, so there is no way to become premium from this
 * page and it does not pretend otherwise — the premium column says what it
 * would include and the button says it is not available. A fake checkout that
 * goes nowhere would be worse than an honest "not yet".
 */

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [
      { title: "Account — Diamond Edge" },
      {
        name: "description",
        content:
          "Create a free account for the strongest calls on every sport each day, or see what premium adds.",
      },
    ],
  }),
  component: AccountPage,
});

type Mode = "signin" | "signup";

function AccountPage() {
  const viewer = useViewer();
  const [mode, setMode] = useState<Mode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Property access on the Supabase proxy throws when the project is not
      // configured, so it is inside the try rather than outside it.
      const auth = supabase.auth;
      if (mode === "signup") {
        const { error: err } = await auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/account` },
        });
        if (err) throw err;
        setNotice(
          "Account created. If your project has email confirmation switched on, check your inbox before signing in.",
        );
      } else {
        const { error: err } = await auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const signedIn = Boolean(viewer.userId);

  return (
    <AppShell
      eyebrow="Diamond Edge · Account"
      title={signedIn ? "Your account" : "Free or premium"}
      blurb={
        signedIn
          ? "What your account currently opens, and what it does not."
          : `A free account opens the ${FREE_PREDICTIONS_PER_SPORT} strongest match calls on every sport, every day. Premium opens the rest of the slate and every player-prop market.`
      }
      footerNote="Accounts are handled by Supabase · No card is stored, because payments are not wired up yet"
    >
      {signedIn ? (
        <section className="mb-8 border border-border bg-card px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Signed in as
              </div>
              <div className="mt-1 font-display text-2xl">{viewer.email ?? "—"}</div>
              <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-primary">
                {viewer.tier === "premium" ? "Premium" : "Free tier"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void viewer.signOut()}
              className="border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </section>
      ) : (
        <section className="mb-8 border border-border bg-card">
          <div className="flex border-b border-border">
            {(["signup", "signin"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                  setNotice(null);
                }}
                aria-pressed={mode === m}
                className={`px-5 py-3 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  mode === m ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "signup" ? "Create account" : "Sign in"}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="grid max-w-md gap-3 px-6 py-6">
            <label className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-border bg-secondary px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Password
              <input
                type="password"
                required
                minLength={8}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full border border-border bg-secondary px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            {error && (
              <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive-foreground">
                {error}
              </div>
            )}
            {notice && (
              <div className="border border-border bg-secondary px-3 py-2 font-mono text-xs text-muted-foreground">
                {notice}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              {busy ? "Working…" : mode === "signup" ? "Create free account" : "Sign in"}
            </button>
          </form>
        </section>
      )}

      <section className="grid gap-px bg-border md:grid-cols-2">
        <Plan
          name="Free"
          price="£0"
          current={viewer.tier === "free"}
          points={[
            `The ${FREE_PREDICTIONS_PER_SPORT} strongest match calls per sport, per day`,
            "Every model page, every backtest, every track record",
            "Elo tables and power ratings in full",
            "No player props",
            "The rest of each day's slate stays locked",
          ]}
        />
        <Plan
          name="Premium"
          price="—"
          current={viewer.tier === "premium"}
          highlight
          points={[
            "Every match on every slate, no daily limit",
            "All sixteen MLB prop markets",
            "All ten soccer prop markets, across five leagues",
            "NFL touchdown scorers",
            "The parlay builder, at 5, 10 and 15 legs",
          ]}
          footer="Payments are not wired up yet. Nothing here can be bought today."
        />
      </section>

      <p className="mt-8 max-w-3xl font-mono text-[11px] text-muted-foreground">
        What is locked is withheld on the server, not hidden in the browser: a free account&apos;s
        response never contains the probabilities it is not entitled to. The blur is what a withheld
        number looks like, not what makes it withheld.
      </p>
    </AppShell>
  );
}

function Plan({
  name,
  price,
  points,
  current,
  highlight,
  footer,
}: {
  name: string;
  price: string;
  points: string[];
  current?: boolean;
  highlight?: boolean;
  footer?: string;
}) {
  return (
    <div className={`bg-card px-6 py-6 ${highlight ? "border-l-2 border-primary" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-display text-3xl">{name}</div>
        <div className="font-mono text-sm text-muted-foreground">{price}</div>
      </div>
      {current && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-primary">
          ▸ Your plan
        </div>
      )}
      <ul className="mt-4 grid gap-2">
        {points.map((p) => (
          <li key={p} className="flex gap-2 text-sm text-muted-foreground">
            <span className="text-primary/60">·</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
      {footer && (
        <p className="mt-4 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}
