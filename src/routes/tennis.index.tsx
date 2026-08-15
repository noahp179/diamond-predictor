import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { TOURS } from "@/lib/tennis-tours";
import matchModels from "@/lib/tennis-match-model.json";

/** The Tennis landing page: pick a tour. */

export const Route = createFileRoute("/tennis/")({
  head: () => ({
    meta: [
      { title: "Tennis — Diamond Edge" },
      {
        name: "description",
        content:
          "ATP and WTA singles match probabilities from a two-year rating replay, backtested on seasons the model never trained on.",
      },
    ],
  }),
  component: TennisIndex,
});

type Model = {
  backtest: {
    logloss: number;
    acc: number;
    auc: number;
    n: number;
    bakeoffRank: number | null;
    bakeoffOf: number | null;
  };
  priors: { matches: number; players: number; surfaces: Record<string, number> };
};
const MODELS = matchModels as unknown as Record<string, Model>;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function TennisIndex() {
  return (
    <AppShell
      sport="tennis"
      eyebrow="Diamond Edge · Tennis"
      title="Two Tours"
      blurb="ATP and WTA singles, each with its own model and its own backtest. There are no teams here — a rating belongs to a player who may not have played in six weeks — so every prediction comes from replaying two years of tour results up to the morning of the match."
      footerNote="Data · ESPN tennis API · Not affiliated with the ATP or WTA"
    >
      <div className="grid gap-4 md:grid-cols-2">
        {TOURS.map((t) => {
          const m = MODELS[t.slug];
          return (
            <Link
              key={t.slug}
              to="/tennis/$tour"
              params={{ tour: t.slug }}
              className="border border-border bg-card p-5 transition-colors hover:border-primary"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-display text-4xl">{t.name}</div>
                <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {t.long}
                </div>
              </div>
              {m && (
                <>
                  <div className="mt-4 grid grid-cols-3 gap-px bg-border">
                    <Cell label="Log loss" value={m.backtest.logloss.toFixed(4)} />
                    <Cell label="Called right" value={pct(m.backtest.acc)} />
                    <Cell label="AUC" value={m.backtest.auc.toFixed(4)} />
                  </div>
                  <div className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    {m.backtest.n.toLocaleString()} held-out matches ·{" "}
                    {m.priors.matches.toLocaleString()} in the fit ·{" "}
                    {m.priors.players.toLocaleString()} players
                  </div>
                </>
              )}
            </Link>
          );
        })}
      </div>

      <section className="mt-10 border border-border bg-card p-6">
        <h2 className="font-display text-2xl">Two things the research found</h2>
        <div className="mt-3 grid gap-4 text-sm text-muted-foreground sm:grid-cols-2">
          <p>
            <strong className="text-foreground">Head-to-head makes the model worse.</strong> The
            most quoted number in tennis is actively harmful: removing it improved log loss,
            accuracy and AUC on both tours. Most pairs have met once or twice, so the
            &quot;record&quot; is a coin flip dressed as evidence, and whatever is real in it is
            already in both players&apos; ratings. On its own it predicts worse than always guessing
            the base rate. It is shown on match cards because people want to see it, and it is kept
            out of the prediction.
          </p>
          <p>
            <strong className="text-foreground">
              Surface-specific Elo is worse than global Elo.
            </strong>{" "}
            Splitting ratings into hard, clay and grass thins each player&apos;s history faster than
            court specialisation pays for it — on both tours. Surface still earns a place as one
            feature among twenty, alongside global form, which is the only role it keeps.
          </p>
        </div>
        <p className="mt-4 font-mono text-[11px] text-muted-foreground">
          Log loss punishes confident wrongness, which is the failure mode that matters for a rating
          system meeting a player it has not seen. Always guessing 50% scores 0.693; the base rate
          scores the same, because with the draw oriented by player id there is no home advantage to
          exploit.
        </p>
      </section>
    </AppShell>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl text-foreground">{value}</div>
    </div>
  );
}
