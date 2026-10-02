import { createFileRoute, Link } from "@tanstack/react-router";

import { LEAGUE_LABEL } from "@/components/sim/format";
import { SIM_HOME, SimShell } from "@/components/sim/SimShell";
import { todayET } from "@/lib/date";
import { SIM_LEAGUES, type SimLeague } from "@/lib/sim/types";

export const Route = createFileRoute("/sim/")({
  head: () => ({
    meta: [
      { title: "Game Simulator — NFL, NBA, NHL, MLB — Diamond Edge" },
      {
        name: "description",
        content:
          "Play-by-play simulations of NFL, NBA, NHL and MLB games built from real player statistics. Watch one game unfold or run ten thousand for win probabilities, score distributions and player projections.",
      },
      { property: "og:title", content: "Game Simulator — Diamond Edge" },
    ],
  }),
  component: SimHub,
});

const CARDS: Record<SimLeague, { unit: string; what: string; stats: string }> = {
  nfl: {
    unit: "snap by snap",
    what: "Down, distance and clock; play calls from each team's tendencies; every carry and target to a real player.",
    stats: "Passing, rushing and receiving lines, touchdowns, kicking, sacks, picks and tackles",
  },
  nba: {
    unit: "possession by possession",
    what: "A minutes-aware rotation, usage from per-minute rates, rebounds, fouls, foul trouble and late-game fouling.",
    stats: "Points, rebounds, assists, threes, steals, blocks, minutes, plus-minus",
  },
  nhl: {
    unit: "shift by shift",
    what: "Lines and pairs by ice time, shot rates against the goalie in net, power plays, the extra attacker, shootouts.",
    stats: "Goals, assists, shots, power-play points, ice time, saves",
  },
  mlb: {
    unit: "plate appearance by plate appearance",
    what: "Batter against pitcher by odds ratio, the park, baserunning, the starter's pitch count and a leverage-driven bullpen.",
    stats:
      "Hits, total bases, homers, RBI, runs, walks, steals; strikeouts, outs and earned runs for pitchers",
  },
};

/**
 * How closely each engine reproduces its league. "Real" is the league
 * average from the same ESPN data the engines are built on; "simulated" is
 * the engines' output across every team's roster, home and away, from
 * scripts/test-game-sim.ts. Margin spread is the standard deviation of the
 * final margin around each matchup's own average — how unpredictable a single
 * game is — against the published figure for the real league.
 */
const CALIBRATION: {
  league: SimLeague;
  unit: string;
  real: string;
  sim: string;
  home: string;
  spread: string;
}[] = [
  {
    league: "nfl",
    unit: "points / team",
    real: "23.0",
    sim: "23.0",
    home: "54.3%",
    spread: "13.0 (real ≈ 13.5)",
  },
  {
    league: "nba",
    unit: "points / team",
    real: "115.0",
    sim: "114.7",
    home: "55.2%",
    spread: "13.3 (real ≈ 13)",
  },
  {
    league: "nhl",
    unit: "goals / team",
    real: "3.13",
    sim: "3.11",
    home: "51.7%",
    spread: "2.3 (real ≈ 2.4)",
  },
  {
    league: "mlb",
    unit: "runs / team",
    real: "4.48",
    sim: "4.42",
    home: "51.8%",
    spread: "4.1 (real ≈ 4.3)",
  },
];

function SimHub() {
  const date = todayET();
  return (
    <SimShell
      title="Game Simulator"
      blurb="Every game here is played out one play at a time from the players' real season statistics and each team's tendencies on both sides of the ball — who shoots, who gets the carry, who's on the ice, who's on the mound, and what the defense across from them allows. Each sport's simulator lives in its own section; pick one below."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {SIM_LEAGUES.map((l) => (
          <Link
            key={l}
            to={SIM_HOME[l]}
            search={{ date }}
            className="group border border-border bg-card p-5 transition-colors hover:border-primary/60"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-display text-4xl group-hover:text-primary">
                {LEAGUE_LABEL[l]}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {CARDS[l].unit}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{CARDS[l].what}</p>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <span className="text-foreground">Player stats:</span> {CARDS[l].stats}
            </p>
            <div className="mt-4 font-mono text-[11px] uppercase tracking-widest text-primary">
              Open the {LEAGUE_LABEL[l]} simulator →
            </div>
          </Link>
        ))}
      </div>

      <section className="mt-10 grid gap-px bg-border md:grid-cols-3">
        {[
          {
            t: "1 · Pick a game",
            d: "Today's slate with the posted line and probable starters, or any two teams you like. Rosters and injury reports load live; sit or start anyone.",
          },
          {
            t: "2 · Run it as often as you like",
            d: "Ten games or a hundred thousand. Every run is fresh randomness, so the numbers move a little each time — by less the more games you play, and the page says by how much.",
          },
          {
            t: "3 · Read the matchup",
            d: "Win probability, the average box score, every player's projected line next to his season average, and the defensive and offensive tendencies that moved it. Or watch a single game play by play.",
          },
        ].map((x) => (
          <div key={x.t} className="bg-card p-5 sm:p-6">
            <div className="font-display text-2xl">{x.t}</div>
            <p className="mt-2 text-sm text-muted-foreground">{x.d}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 border border-border bg-card">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="font-display text-3xl">Does it play like the real thing?</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Before trusting any one game, the engines have to reproduce the leagues. Each was tuned
            with a handful of constants — scoring level, home edge, game-to-game variance — until
            every team&apos;s roster, played home and away against the others, came out like this.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-5 py-2 text-left font-normal sm:px-6">League</th>
                <th className="px-3 py-2 text-left font-normal">Scoring</th>
                <th className="px-3 py-2 text-right font-normal">Real</th>
                <th className="px-3 py-2 text-right font-normal">Simulated</th>
                <th className="px-3 py-2 text-right font-normal">
                  Home team wins (same roster both sides)
                </th>
                <th className="px-3 py-2 text-right font-normal">Margin spread</th>
              </tr>
            </thead>
            <tbody>
              {CALIBRATION.map((c) => (
                <tr key={c.league} className="border-b border-border/40">
                  <td className="px-5 py-2 text-left text-foreground sm:px-6">
                    {LEAGUE_LABEL[c.league]}
                  </td>
                  <td className="px-3 py-2 text-left text-muted-foreground">{c.unit}</td>
                  <td className="px-3 py-2 text-right text-foreground">{c.real}</td>
                  <td className="px-3 py-2 text-right text-foreground">{c.sim}</td>
                  <td className="px-3 py-2 text-right text-foreground">{c.home}</td>
                  <td className="px-3 py-2 text-right text-foreground">{c.spread}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground sm:px-6">
          Against the market: on the NFL&apos;s October 4, 2026 slate the simulated average margins
          correlated 0.90 with the posted spreads (0.81 before each defense&apos;s pass and run
          splits went in); on the NHL&apos;s October 1 card the simulated win probabilities
          correlated 0.90 with the no-vig moneylines, if a little more cautious. Players come out
          close to their own seasons — within a few percent for most stats, tier by tier — before
          the matchup moves them. Reproducing league averages is the floor, not proof of accuracy on
          any particular game. The engines know season statistics, team splits and today&apos;s
          injury report — not tape, not weather, not who&apos;s on a minutes limit. Treat a
          disagreement with the market as a question.
        </p>
      </section>
    </SimShell>
  );
}
