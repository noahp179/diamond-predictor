import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { SoccerShell } from "@/components/SoccerShell";
import { StatBar, Stat } from "@/components/SportShell";
import { getSoccerModelCard } from "@/lib/soccer.functions";
import { leagueOf, type LeagueSlug } from "@/lib/soccer-leagues";

/**
 * What the model is and how it did — per league, on seasons it never trained on.
 *
 * This page is deliberately unglamorous. It exists so every probability
 * elsewhere on the Soccer tab can be traced to a measured number, including the
 * ones that are unflattering: where the shipped algorithm was beaten in its own
 * bake-off, and which prop markets are barely better than guessing.
 */

export const Route = createFileRoute("/soccer/$league/model")({
  head: ({ params }) => {
    const l = leagueOf(params.league);
    return {
      meta: [
        { title: `${l.name} Model & Backtest — Diamond Edge` },
        {
          name: "description",
          content: `How the ${l.name} match and player-prop models were built, and how they scored on held-out seasons.`,
        },
      ],
    };
  },
  component: SoccerModelPage,
});

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function SoccerModelPage() {
  const { league } = Route.useParams();
  const slug = league as LeagueSlug;
  const l = leagueOf(league);
  const run = useServerFn(getSoccerModelCard);
  const { data } = useQuery({
    queryKey: ["soccer", "model", slug],
    queryFn: () => run({ data: { league: slug } }),
    staleTime: Infinity,
  });

  const b = data?.backtest;
  const markets = data?.markets ?? [];

  return (
    <SoccerShell
      league={slug}
      current="model"
      eyebrow={`Diamond Edge · ${l.name}`}
      title="Model & Backtest"
      blurb={`Everything behind the ${l.name} numbers: which algorithm ships, why that one, and how it scored on seasons it never trained on. Including where it loses.`}
      statBar={
        <StatBar>
          <Stat label="Held-out RPS" value={b ? b.rps.toFixed(4) : "—"} />
          <Stat label="Log loss" value={b ? b.logloss.toFixed(4) : "—"} />
          <Stat label="Called right" value={b ? pct(b.acc) : "—"} />
          <Stat label="Test matches" value={b ? b.n.toLocaleString() : "—"} />
        </StatBar>
      }
    >
      <section className="mb-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-2xl">The match model</h2>
        </div>
        <div className="px-5 py-5 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Goal-difference Elo</strong>, replayed over every
            completed {l.name} match, then mapped to home/draw/away by a multinomial logistic on the
            single rating gap. Ratings start at {data?.elo.init}, a win moves them by K=
            {data?.elo.k} scaled by <code>(|goal difference| + 1)^{data?.elo.gdExp}</code>, home
            sides get {data?.elo.hfa} rating points, and between seasons every rating is pulled{" "}
            {Math.round((1 - (data?.elo.carry ?? 0)) * 100)}% back toward the mean.
          </p>
          <p className="mt-3">
            The same family ships for all five leagues, and it was chosen{" "}
            <strong className="text-foreground">before</strong> the per-league tables were read.
            Picking each league's bake-off winner would be selection on the test set: with roughly
            forty candidates and about a thousand test matches, the top few are separated by less
            than the noise. Only the calibration is fitted per league, because draw rates genuinely
            differ — {pct(data?.priors.draw ?? 0)} here against 23.9% in England and 27.4% in Italy.
          </p>
          {b?.bakeoffRank != null && (
            <p className="mt-3">
              In {l.name}'s own bake-off this model placed{" "}
              <strong className="text-foreground">
                {b.bakeoffRank} of {b.bakeoffOf}
              </strong>
              ,{" "}
              {b.rpsBehindBest === 0 ? "top" : `${b.rpsBehindBest?.toFixed(4)} RPS behind the best`}
              . The families ahead of it are tree ensembles, which need a fitted model per league
              and overfit a single season, and shot-process models, which need a per-match shots
              feed the live site does not have. That gap is the honest price of shipping something
              that can run from a scoreboard alone.
            </p>
          )}
          <p className="mt-3">
            Trained through {b?.trainedThrough}-
            {String(((b?.trainedThrough ?? 0) + 1) % 100).padStart(2, "0")}; scored on{" "}
            {b?.seasons.map((s) => `${s}-${String((s + 1) % 100).padStart(2, "0")}`).join(", ")}.
            League base rates over the full sample: home {pct(data?.priors.home ?? 0)}, draw{" "}
            {pct(data?.priors.draw ?? 0)}, away {pct(data?.priors.away ?? 0)},{" "}
            {data?.priors.goals.toFixed(2)} goals a match.
          </p>
        </div>
      </section>

      <section className="border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-display text-2xl">Player-prop models</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ten markets, each its own logistic with Platt calibration, fitted on {l.name} through
            2023-24, model choice made on 2024-25, and scored once on 2025-26. AUC is the
            discrimination on that final season; tiers are cut where the hit rate actually
            separates, not at round numbers.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                <th className="px-5 py-3 font-normal">Market</th>
                <th className="px-3 py-3 text-right font-normal">Base</th>
                <th className="px-3 py-3 text-right font-normal">AUC</th>
                <th className="px-3 py-3 text-right font-normal">Log loss</th>
                <th className="px-3 py-3 text-right font-normal">Top pick</th>
                <th className="px-3 py-3 text-right font-normal">Top 5</th>
                <th className="px-5 py-3 text-right font-normal">Tiers</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr key={m.key} className="border-b border-border/60">
                  <td className="px-5 py-3 font-display text-base text-foreground">{m.label}</td>
                  <td className="px-3 py-3 text-right">{pct(m.base)}</td>
                  <td
                    className={`px-3 py-3 text-right ${m.auc >= 0.7 ? "text-primary" : m.auc < 0.62 ? "text-muted-foreground" : ""}`}
                  >
                    {m.auc.toFixed(3)}
                  </td>
                  <td className="px-3 py-3 text-right">{m.logloss.toFixed(4)}</td>
                  <td className="px-3 py-3 text-right">{pct(m.top1)}</td>
                  <td className="px-3 py-3 text-right">{pct(m.top5)}</td>
                  <td className="px-5 py-3 text-right">
                    {m.tiers
                      .map((t) => `${t.label.slice(0, 2)} ${Math.round(t.hitRate * 100)}%`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-5 py-4 font-mono text-[11px] text-muted-foreground">
          <p>
            &quot;Top pick&quot; is how often the single highest-rated player of a matchday hit;
            &quot;Top 5&quot; the same over the five best. Those are the numbers that matter for
            actually betting, and they are lower than the AUC flatters you into expecting.
          </p>
          <p className="mt-2">
            Markets near 0.62 AUC are barely better than the player's own rate — cards especially,
            which depend on the referee far more than on the player. They are shown rather than
            hidden so the weak ones can be avoided on purpose.
          </p>
          <p className="mt-2">
            No player-prop prices exist in this data source, so nothing here is compared with a
            book. These are probabilities, not edges over a market.
          </p>
        </div>
      </section>
    </SoccerShell>
  );
}
