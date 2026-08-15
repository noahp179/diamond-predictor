import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { SPORTS, viewsFor, type SportKey } from "@/lib/nav";
import { LEAGUES } from "@/lib/soccer-leagues";
import matchModels from "@/lib/soccer-match-model.json";

/**
 * The hub.
 *
 * `/` used to be the MLB slate, from when MLB was the whole site. With four
 * sports and twenty-eight pages, having one of them silently occupy the root
 * made the other three feel bolted on, and gave no page that could answer "what
 * is here?". The MLB slate now lives at /mlb like every other sport's does, and
 * the root is a map.
 *
 * Deliberately static: no data fetching. A hub that waits on four sports' APIs
 * before it can render anything is a worse front door than one that appears
 * instantly and links onward. Live numbers belong on the pages that own them.
 */

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Diamond Edge — Model-backed picks across four sports" },
      {
        name: "description",
        content:
          "Win probabilities, player props and parlays for MLB, NFL, NBA and Europe's big five soccer leagues — every model backtested on seasons it never trained on.",
      },
      { property: "og:title", content: "Diamond Edge" },
      {
        property: "og:description",
        content:
          "Model-backed picks across MLB, NFL, NBA and five soccer leagues, with the backtests published.",
      },
    ],
  }),
  component: Hub,
});

type MatchModel = { backtest: { rps: number; acc: number; n: number } };
const SOCCER = matchModels as Record<string, MatchModel>;

export function Hub() {
  return (
    <AppShell
      eyebrow="Diamond Edge"
      title="Every model, in one place"
      blurb="Win probabilities, player props and parlays across four sports and five soccer leagues. Every model here was scored on seasons it never trained on, and every page shows that number — including where the model loses."
      footerNote="Data · MLB Stats API · ESPN · Not affiliated with any league"
    >
      <div className="grid gap-4 md:grid-cols-2">
        {SPORTS.map((s) => (
          <SportCard key={s.key} sport={s.key} label={s.label} blurb={s.blurb} />
        ))}
      </div>

      <section className="mt-10">
        <h2 className="font-display text-2xl">Soccer, league by league</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Five separate models, because the leagues are not the same problem. Draws run from 23.9%
          in England to 27.4% in Italy — one calibration across all of them would be wrong at both
          ends. RPS is the three-way scoring rule; lower is better, and predicting the base rates
          scores about 0.465.
        </p>
        <div className="mt-4 grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
          {LEAGUES.map((l) => {
            const m = SOCCER[l.slug];
            return (
              <Link
                key={l.slug}
                to="/soccer/$league"
                params={{ league: l.slug }}
                className="group bg-card px-5 py-4 transition-colors hover:bg-secondary/40"
              >
                <div className="font-display text-xl group-hover:text-primary">{l.name}</div>
                <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {l.country}
                  {m
                    ? ` · RPS ${m.backtest.rps.toFixed(4)} · ${m.backtest.n.toLocaleString()} tested`
                    : ""}
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mt-10 border border-border bg-card p-6">
        <h2 className="font-display text-2xl">How to read anything here</h2>
        <div className="mt-3 grid gap-4 text-sm text-muted-foreground sm:grid-cols-2">
          <p>
            <strong className="text-foreground">Percentages are calibrated probabilities</strong>,
            not confidence scores. A market shown at 70% hit close to 70% of the time on the
            held-out season — that is what calibration means and what the backtests check.
          </p>
          <p>
            <strong className="text-foreground">No prop prices exist in these data sources.</strong>{" "}
            Where a &quot;fair price&quot; is shown it is what the model&apos;s own probability
            implies, not a quote. Compare it with your book; if they pay less, the bet is bad
            however good the pick is.
          </p>
          <p>
            <strong className="text-foreground">Weak markets are shown, not hidden.</strong> Soccer
            cards sit at 0.61 AUC — barely better than a player&apos;s own rate, because bookings
            depend on the referee. They are on the page so they can be avoided on purpose.
          </p>
          <p>
            <strong className="text-foreground">One row per player.</strong> Every rung of a ladder
            is priced separately, so boards and parlays collapse them: a pitcher never appears at
            5+, 6+ and 7+ strikeouts at once, and a forward never at 1+, 2+ and 3+ shots.
          </p>
        </div>
      </section>
    </AppShell>
  );
}

function SportCard({ sport, label, blurb }: { sport: SportKey; label: string; blurb: string }) {
  const views = viewsFor(sport);
  return (
    <div className="border border-border bg-card p-5 transition-colors hover:border-primary/60">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          to={sport === "soccer" ? "/soccer" : `/${sport}`}
          className="font-display text-3xl hover:text-primary"
        >
          {label}
        </Link>
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {views.length} pages
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{blurb}</p>
      <div className="mt-4 flex flex-wrap gap-1">
        {views.map((v) => (
          <Link
            key={v.key}
            to={v.href}
            className="border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            {v.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
