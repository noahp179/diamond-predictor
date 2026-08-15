import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { LEAGUES } from "@/lib/soccer-leagues";
import matchModels from "@/lib/soccer-match-model.json";

/**
 * The Soccer landing page: pick a competition.
 *
 * Each card carries that league's own held-out numbers rather than a shared
 * headline, because there is no shared model — five leagues, five fits, five
 * backtests. Showing them side by side is also the honest way to present the
 * spread: the same algorithm is markedly better at calling Bundesliga matches
 * than Serie A ones, and that is a property of the leagues, not of the code.
 */

export const Route = createFileRoute("/soccer/")({
  head: () => ({
    meta: [
      { title: "Soccer — Diamond Edge" },
      {
        name: "description",
        content:
          "Match and player-prop models for the Premier League, La Liga, Bundesliga, Serie A and Ligue 1 — each fitted, calibrated and backtested on its own seasons.",
      },
    ],
  }),
  component: SoccerIndex,
});

type ModelFile = Record<
  string,
  {
    backtest: {
      rps: number;
      acc: number;
      n: number;
      bakeoffRank: number | null;
      bakeoffOf: number | null;
    };
    priors: { home: number; draw: number; away: number; goals: number };
  }
>;

const MODELS = matchModels as ModelFile;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function SoccerIndex() {
  return (
    <AppShell
      sport="soccer"
      eyebrow="Diamond Edge · Soccer"
      title="Five Leagues"
      blurb="Europe's big five, each with its own match model and its own set of player-prop models. Nothing is shared between them: draw rates run from 23.9% in England to 27.4% in Italy, so a calibration borrowed across borders would be wrong at both ends. Every number below is from seasons the model never trained on."
      footerNote="Data · ESPN soccer API · Not affiliated with any league"
    >
      <div className="grid gap-4 md:grid-cols-2">
        {LEAGUES.map((l) => {
          const m = MODELS[l.slug];
          return (
            <Link
              key={l.slug}
              to="/soccer/$league"
              params={{ league: l.slug }}
              className="border border-border bg-card p-5 transition-colors hover:border-primary"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-display text-3xl">{l.name}</div>
                <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {l.country}
                </div>
              </div>
              {m && (
                <>
                  <div className="mt-4 grid grid-cols-3 gap-px bg-border">
                    <Cell label="RPS" value={m.backtest.rps.toFixed(4)} />
                    <Cell label="Called right" value={pct(m.backtest.acc)} />
                    <Cell label="Test matches" value={m.backtest.n.toLocaleString()} />
                  </div>
                  <div className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    home {pct(m.priors.home)} · draw {pct(m.priors.draw)} · away{" "}
                    {pct(m.priors.away)} · {m.priors.goals.toFixed(2)} goals/match
                  </div>
                </>
              )}
            </Link>
          );
        })}
      </div>

      <div className="mt-8 border border-border bg-card p-5 font-mono text-[11px] text-muted-foreground">
        RPS is the ranked probability score — the three-way equivalent of Brier, and the right
        metric for a market whose outcomes are ordered home &gt; draw &gt; away. Lower is better;
        always predicting the league's base rates scores about 0.465. Accuracy is shown because it
        is familiar, not because it is the better measure: a model can gain accuracy while getting
        worse at pricing, which is what RPS catches and accuracy does not.
      </div>
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
