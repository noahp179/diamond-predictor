import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { AppShell, StatBar, Stat } from "@/components/AppShell";
import { getTennisModelCard } from "@/lib/tennis.functions";
import { tourOf, type TourSlug } from "@/lib/tennis-tours";

/**
 * What the tennis model is, and the two results that shaped it.
 *
 * Both of those results are negative — head-to-head hurts, surface Elo hurts —
 * and both are on the page rather than in a footnote, because they are the
 * reason the model looks the way it does.
 */

export const Route = createFileRoute("/tennis/$tour/model")({
  head: ({ params }) => {
    const t = tourOf(params.tour);
    return {
      meta: [
        { title: `${t.name} Model & Backtest — Diamond Edge` },
        {
          name: "description",
          content: `How the ${t.name} match model was built, what was thrown out, and how it scored on seasons it never trained on.`,
        },
      ],
    };
  },
  component: TennisModelPage,
});

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Plain-English gloss for each feature, so the weights table can be read. */
const GLOSS: Record<string, string> = {
  elo: "Elo, K=24",
  elo_fast: "Elo, K=40 — reacts faster to recent form",
  elo_slow: "Elo, K=12 — the long-run view",
  elo_games: "Elo weighted by how lopsided the scoreline was",
  elo_surface: "Elo kept separately per surface",
  elo_blend: "Half surface Elo, half global",
  glicko: "Glicko — Elo plus a confidence interval",
  bradley_terry: "Bradley-Terry strength",
  seed_diff: "Seeding gap in this draw",
  winrate: "Career win rate in the window",
  surface_winrate: "Win rate on this surface",
  form_last10: "Last ten matches",
  games_won_ratio: "Share of all games won",
  streak: "Current winning streak",
  fatigue: "Matches already played this tournament",
  rest_days: "Days since the last match",
  experience: "Matches played (log)",
  bestOf: "Best-of-three or best-of-five",
  drawSize: "Size of the draw",
  roundId: "How deep in the tournament",
};

function TennisModelPage() {
  const { tour } = Route.useParams();
  const slug = tour as TourSlug;
  const t = tourOf(tour);
  const run = useServerFn(getTennisModelCard);
  const { data } = useQuery({
    queryKey: ["tennis", "model", slug],
    queryFn: () => run({ data: { tour: slug } }),
    staleTime: Infinity,
  });

  const b = data?.backtest;
  const weights = [...(data?.weights ?? [])].sort((x, y) => Math.abs(y.coef) - Math.abs(x.coef));
  const maxAbs = weights.length ? Math.abs(weights[0].coef) : 1;

  return (
    <AppShell
      sport="tennis"
      view="model"
      league={slug}
      eyebrow={`Diamond Edge · ${t.name}`}
      title="Model & Backtest"
      blurb={`What predicts a ${t.long.toLowerCase()} match, what turned out not to, and how the whole thing scored on three seasons it never trained on.`}
      statBar={
        <StatBar>
          <Stat label="Log loss" value={b ? b.logloss.toFixed(4) : "—"} />
          <Stat label="Called right" value={b ? pct(b.acc) : "—"} />
          <Stat label="AUC" value={b ? b.auc.toFixed(4) : "—"} />
          <Stat label="Test matches" value={b ? b.n.toLocaleString() : "—"} />
        </StatBar>
      }
    >
      <section className="mb-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-2xl">What ships</h2>
        </div>
        <div className="px-5 py-5 text-sm text-muted-foreground">
          <p>
            A <strong className="text-foreground">logistic regression</strong> over twenty
            differences between the two players — every one of them written as A minus B, so the
            model cannot learn that one side of the card tends to win. There is no such tendency:
            matches are oriented by player id, which is arbitrary with respect to who wins.
          </p>
          <p className="mt-3">
            Features come from replaying the previous two years of tour, match by match, in order.
            That is unavoidable rather than elegant — tennis has no teams and no roster endpoint, so
            a player&apos;s rating exists only as the accumulation of their results.
          </p>
          <p className="mt-3">
            It is not the bake-off winner. Random forest, extra trees and kNN scored slightly
            better, but each needs a fitted model object at request time, where a logistic is
            coefficients and a standardiser the site evaluates exactly.
            {b?.bakeoffRank != null && (
              <>
                {" "}
                It placed{" "}
                <strong className="text-foreground">
                  {b.bakeoffRank} of {b.bakeoffOf}
                </strong>
                , {b.loglossBehindBest?.toFixed(4)} log loss behind the best — after dropping
                head-to-head, which more than paid for the family downgrade.
              </>
            )}
          </p>
          {b && (
            <p className="mt-3">
              Trained through {b.trainedThrough}, scored on {b.seasons.join(", ")}. Refitting each
              season is worth <strong className="text-foreground">{b.refitGain.toFixed(4)}</strong>{" "}
              log loss against freezing it — the shipped coefficients use every season, so the live
              model starts from the refitted end. Calibration error is {b.ece.toFixed(4)}: when it
              says 70%, it means it.
            </p>
          )}
        </div>
      </section>

      <section className="mb-8 border border-clay/40 bg-card">
        <div className="border-b border-clay/40 px-5 py-4">
          <h2 className="font-display text-2xl">Two things that did not work</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Both were expected to help. Both were tested and thrown out.
          </p>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          <div className="bg-card px-5 py-5 text-sm text-muted-foreground">
            <div className="font-display text-xl text-foreground">Head-to-head</div>
            <p className="mt-2">
              Removing the head-to-head record and common-opponent features made the model better on
              both tours, on every metric — log loss, accuracy and AUC. On its own, head-to-head
              predicts <em>worse than always guessing the base rate</em>.
            </p>
            <p className="mt-2">
              Most pairs have met once or twice, so a &quot;record&quot; is a coin flip dressed as
              evidence; and whatever is genuinely there is already in both players&apos; ratings. It
              is displayed on match cards because people want to see it, and it is not fed to the
              model.
            </p>
          </div>
          <div className="bg-card px-5 py-5 text-sm text-muted-foreground">
            <div className="font-display text-xl text-foreground">Surface-specific Elo</div>
            <p className="mt-2">
              Keeping separate hard, clay and grass ratings is the standard tennis-modelling move
              and it scored <em>worse</em> than a single global Elo on both tours — by 0.0108 on the
              ATP and 0.0176 on the WTA.
            </p>
            <p className="mt-2">
              Splitting a career three ways thins each player&apos;s history faster than court
              specialisation pays for it. Surface survives as one feature among twenty, sitting
              alongside global form rather than replacing it, where it is worth a genuine but small
              amount.
            </p>
          </div>
        </div>
      </section>

      <section className="border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-2xl">What the model actually leans on</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Standardised coefficients, so they are comparable to one another. A positive weight
            means the feature favours whichever player leads on it; the sign is only meaningful
            against the A-minus-B convention, so magnitude is the thing to read.
          </p>
        </div>
        <div className="px-5 py-4">
          {weights.map((w) => (
            <div key={w.feature} className="flex items-center gap-3 border-b border-border/50 py-2">
              <div className="w-40 shrink-0 font-mono text-[11px] uppercase tracking-widest text-foreground">
                {w.feature}
              </div>
              <div className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block">
                {GLOSS[w.feature] ?? ""}
              </div>
              <div className="h-2 w-32 shrink-0 bg-secondary">
                <div
                  className={w.coef >= 0 ? "h-full bg-primary" : "h-full bg-foreground/40"}
                  style={{ width: `${(Math.abs(w.coef) / maxAbs) * 100}%` }}
                />
              </div>
              <div className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {w.coef >= 0 ? "+" : ""}
                {w.coef.toFixed(3)}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-5 py-4 font-mono text-[11px] text-muted-foreground">
          Correlated features share credit, so a small weight here does not prove a feature is
          useless — three Elo variants at different K values will always split the difference
          between them. The ablation in research/tennis/ablate_tennis.py is the test that removes
          whole groups at a time, and it is what head-to-head failed.
        </div>
      </section>
    </AppShell>
  );
}
