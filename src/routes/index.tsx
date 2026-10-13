import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { SPORTS, viewsFor, type SportKey } from "@/lib/nav";

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

export function Hub() {
  return (
    <AppShell
      eyebrow="Diamond Edge"
      title="Every model, in one place"
      blurb="Win probabilities, player props, parlays and game simulations across baseball, football, basketball, hockey, soccer and tennis. Every model here was scored on seasons it never trained on, and every page shows that number — including where the model loses."
      footerNote="Data · MLB Stats API · ESPN · Not affiliated with any league"
    >
      <Link
        to="/sim"
        className="group mb-6 block border border-primary/50 bg-card p-5 transition-colors hover:border-primary sm:p-6"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="font-display text-3xl group-hover:text-primary">Game Simulator</span>
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            NFL · CFB · NBA · NHL · MLB · UCL
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Play any game out one play at a time from the players&apos; season numbers and each
          team&apos;s offensive and defensive tendencies. Run it ten times or a hundred thousand for
          the win probability, the average box score, and every player&apos;s projected line against
          his season — or watch one unfold with a live box score. A Simulate tab in every section
          that has one, the Champions League included.
        </p>
        <span className="mt-3 inline-block font-mono text-[11px] uppercase tracking-widest text-primary">
          Open the simulator →
        </span>
      </Link>

      <div className="grid gap-4 md:grid-cols-2">
        {SPORTS.map((s) => (
          <SportCard key={s.key} sport={s.key} label={s.label} blurb={s.blurb} />
        ))}
      </div>

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
