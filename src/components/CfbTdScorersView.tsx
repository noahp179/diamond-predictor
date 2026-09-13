import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getCfbTdScorers } from "@/lib/sports.functions";
import { todayET } from "@/lib/date";
import { TdRecord } from "@/components/TdRecord";

type Result = Awaited<ReturnType<typeof getCfbTdScorers>>;
type Game = Result["games"][number];
type Pick = Game["picks"][number];

/**
 * Tier colours. The labels and their hit rates come from the model file, which
 * gets them from the backtest — nothing here restates a number that lives
 * somewhere else, because that is how the two drift apart.
 */
const TIER_CLASS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

function PickRow({ pick, rank }: { pick: Pick; rank: number }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <span className="w-5 shrink-0 font-mono text-sm text-primary/70">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-lg leading-tight">{pick.player}</div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {pick.team}
          {pick.position ? ` · ${pick.position}` : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-2xl leading-none text-foreground">{pct(pick.prob)}</div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          to score
        </div>
      </div>
      <div
        className={`shrink-0 border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${
          TIER_CLASS[pick.tier] ?? TIER_CLASS.Lean
        }`}
        title={`${pick.tier}. Picks in this tier scored in ${pct(pick.tierHit)} of games across the held-out 2025 and 2026 seasons.`}
      >
        <div className="text-sm leading-none">{pct(pick.tierHit)}</div>
        <div className="mt-0.5">{pick.tier}</div>
      </div>
    </div>
  );
}

function GameCard({ game }: { game: Game }) {
  const margin = Math.abs(game.homeMargin);
  const favourite = game.homeMargin >= 0 ? game.home : game.away;
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm uppercase tracking-widest text-foreground">
          {game.matchup}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {game.total != null ? `O/U ${game.total} · ` : ""}
          {margin < 0.5 ? "pick'em" : `${favourite} by ${margin.toFixed(0)}`}
        </div>
      </div>
      <div>
        {game.picks.map((p, i) => (
          <PickRow key={p.playerId} pick={p} rank={i + 1} />
        ))}
      </div>
      {game.picks.length === 1 && (
        <div
          className="mt-3 border-t border-border pt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
          title="A second name is only shown when the model gives it at least a 45% chance. Below that, second picks hit in the low 40s — worse than showing nothing."
        >
          One pick — no second name cleared the bar
        </div>
      )}
    </div>
  );
}

export function CfbTdScorersView() {
  const [date, setDate] = useState(todayET());
  const [strongOnly, setStrongOnly] = useState(false);
  const run = useServerFn(getCfbTdScorers);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["cfb", "td-scorers", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const allGames = data?.games ?? [];
  const games = strongOnly
    ? allGames.filter((g) => g.picks.some((p) => p.tier === "Strong"))
    : allGames;
  const strongCount = allGames.filter((g) => g.picks.some((p) => p.tier === "Strong")).length;
  const totalPicks = allGames.reduce((n, g) => n + g.picks.length, 0);
  const perGame = allGames.length ? (totalPicks / allGames.length).toFixed(2) : "—";
  const bt = data?.backtest ?? null;

  return (
    <SportShell
      sport="cfb"
      current="tdScorers"
      eyebrow="Diamond Edge · College Football"
      title="Touchdown Scorers"
      blurb="One or two names a game — the model decides how many. A second pick only appears when it is worth showing, which on the held-out 2025 and 2026 seasons meant 1.46 picks a game, 54.6% of shown picks scoring, and 65.6% of games with at least one hit. No betting lines anywhere in it: ESPN does not keep historical college odds, so a market feature could never have been backtested."
      date={date}
      onDateChange={setDate}
      footerNote="Data · ESPN · logistic model on season usage · Not affiliated with college football or the NCAA"
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat label="Picks" value={`${totalPicks}`} />
          <Stat label="Per game" value={perGame} />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load college football TD scorers. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {/* Season-to-date usage is "as of now". For a slate already played, that
          includes the games being projected — so say so instead of showing a
          number that quietly knew the answer. */}
      {!isLoading && !isError && data?.staleFeatures && allGames.length > 0 && (
        <Note>
          This slate has already been played. These picks are rebuilt from season totals that now
          include those games, so they are not what the model would have said beforehand — the
          backtest in CFB-ANALYSIS.md is the honest measure. Today and later dates are unaffected.
        </Note>
      )}

      {!isLoading && !isError && allGames.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {bt
              ? `Held out ${bt.seasons.join("–")} · ${pct(bt.pick_hit_rate)} of picks scored · ${pct(bt.game_hit_rate)} of games hit`
              : "Backtested on held-out seasons"}
          </div>
          <button
            type="button"
            onClick={() => setStrongOnly((v) => !v)}
            aria-pressed={strongOnly}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
              strongOnly
                ? "border-primary text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {strongOnly ? "▸ " : ""}Strong only ({strongCount})
          </button>
        </div>
      )}

      {!isLoading && !isError && games.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <GameCard key={g.gameId} game={g} />
          ))}
        </div>
      )}

      {!isLoading && !isError && games.length === 0 && allGames.length > 0 && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No Strong picks today</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            No pick on the slate clears the Strong tier. Turn off the filter for the full board.
          </p>
        </div>
      )}

      {!isLoading && !isError && allGames.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to project</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            College football is mostly a Saturday sport — pick a Saturday, or a Thursday or Friday
            in season.
          </p>
        </div>
      )}

      <TdRecord sport="cfb" />
    </SportShell>
  );
}
