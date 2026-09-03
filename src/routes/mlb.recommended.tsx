import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { getRecommendedPicks } from "@/lib/mlb.functions";
import { getMlbProps } from "@/lib/sports.functions";
import { MlbParlayCard } from "@/components/MlbParlayCard";
import type { ParlayCandidate } from "@/lib/mlb-parlay";
import { pickProb } from "@/lib/mlb-blend";
import { offsetDate, slateComplete } from "@/lib/mlb-features";
import type { PredictedGame } from "@/lib/mlb-core";
import { AppShell } from "@/components/AppShell";
import { PremiumWall, UpgradePrompt } from "@/components/Locked";

export const Route = createFileRoute("/mlb/recommended")({
  head: () => ({
    meta: [
      { title: "Recommended — Diamond Edge" },
      {
        name: "description",
        content:
          "What we'd actually bet tonight: a 5, 10 or 15-leg slip built from model confidence alone, plus the single game the model is surest about.",
      },
    ],
  }),
  component: ModelPage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pct(p: number) {
  return `${(p * 100).toFixed(1)}%`;
}

function ModelPage() {
  const fetchPicks = useServerFn(getRecommendedPicks);
  const today = todayISO();
  const tomorrow = offsetDate(today, 1);

  const todayQuery = useQuery({
    queryKey: ["recommended-picks", today],
    queryFn: () => fetchPicks({ data: { date: today } }),
    staleTime: 5 * 60_000,
  });
  const tomorrowQuery = useQuery({
    queryKey: ["recommended-picks", tomorrow],
    queryFn: () => fetchPicks({ data: { date: tomorrow } }),
    staleTime: 5 * 60_000,
  });

  let dedupedGames: PredictedGame[] = [];
  let scored: PredictedGame[] = [];
  const isLoading = todayQuery.isLoading || tomorrowQuery.isLoading;
  const isError = todayQuery.isError || tomorrowQuery.isError;
  let chosenDate = today;

  if (!isLoading && !isError) {
    // Show today until its slate is over (nothing left upcoming or live),
    // then roll to tomorrow.
    const todayGames = todayQuery.data?.games ?? [];
    const todayDone = slateComplete(todayGames.map((g) => g.status));
    const chosen = todayDone ? tomorrowQuery.data : todayQuery.data;
    dedupedGames = chosen?.games ?? [];
    chosenDate = todayDone ? tomorrow : today;
    scored = chosen?.picks ?? [];
  }

  // Props for whichever slate is on screen. Declared after chosenDate so the
  // slip rolls over with the games rather than lagging a day behind them.
  const fetchProps = useServerFn(getMlbProps);
  const propsQuery = useQuery({
    queryKey: ["mlb", "props", chosenDate],
    queryFn: () => fetchProps({ data: { date: chosenDate } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Parlay candidates: every prop the model prices, plus each game's moneyline
  // pick at the model's own confidence. Price never enters the selection.
  const parlayCandidates: ParlayCandidate[] = [
    ...(propsQuery.data?.games ?? []).flatMap((g) =>
      g.picks.map(
        (p): ParlayCandidate => ({
          subjectId: `p${p.playerId}`,
          subject: p.player,
          market: p.market,
          label: p.label,
          prob: p.prob,
          gameId: g.gameId,
          matchup: g.matchup,
          team: p.team,
          kind: p.kind,
          tier: p.tier,
          tierHitRate: p.tierHitRate,
          cautions: p.cautions,
        }),
      ),
    ),
    ...dedupedGames.map((g): ParlayCandidate => {
      const pickHome = g.homeWinProb >= 0.5;
      return {
        subjectId: `g${g.gameId}`,
        subject: pickHome ? g.home.abbreviation : g.away.abbreviation,
        market: "moneyline",
        label: "to win",
        prob: pickProb(g.homeWinProb),
        gameId: g.gameId,
        matchup: `${g.away.abbreviation} @ ${g.home.abbreviation}`,
        team: pickHome ? g.home.abbreviation : g.away.abbreviation,
        kind: "game",
      };
    }),
  ];

  return (
    <AppShell
      sport="mlb"
      view="recommended"
      eyebrow="Diamond Edge · Recommended"
      title="Tonight's Slip"
      blurb="What we'd actually put on: a 5, 10 or 15-leg parlay built from model confidence alone, one leg per player, with the measured chance it cashes. Below it, the single game the model feels surest about."
      footerNote="Data · MLB Stats API (statsapi.mlb.com) · Not affiliated with MLB"
    >
      <MlbParlayCard candidates={parlayCandidates} isLoading={isLoading || propsQuery.isLoading} />

      <div className="mb-6 border-b border-border pb-4">
        <h2 className="font-display text-2xl">Best game</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The one game tonight our model feels surest about, plus the next two. The bigger the win
          chance, the more of a lock we think the pick is.
        </p>
      </div>

      {isLoading && <p className="text-center py-10">Loading…</p>}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load predictions. The MLB Stats API may be unreachable.
        </div>
      )}
      {!isLoading && !isError && dedupedGames.length === 0 && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games found</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            No scheduled games for {chosenDate}.
          </p>
        </div>
      )}
      {!isLoading && !isError && dedupedGames.length > 0 && (
        <>
          {scored.length === 0 ? (
            <p className="text-center py-8">Not enough data to compute picks.</p>
          ) : (
            <div className="grid gap-6">
              <BestGameCard game={scored[0]} />
              {scored.length > 1 && (
                <>
                  <div className="mt-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    Runners-up
                  </div>
                  {scored.slice(1).map((g, i) => (
                    <TopPickCard key={g.gameId} game={g} rank={i + 2} />
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function BestGameCard({ game }: { game: PredictedGame }) {
  const homeProb = game.homeWinProb;
  const favHome = homeProb >= 0.5;
  const favProb = favHome ? homeProb : 1 - homeProb;
  const favTeam = favHome ? game.home.abbreviation : game.away.abbreviation;

  return (
    <div className="border-2 border-primary/60 bg-card transition-colors hover:border-primary">
      <div className="flex items-center justify-between border-b border-border/60 bg-primary/10 px-5 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
          ★ Best Game · our surest pick
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Our model
        </span>
      </div>
      <div className="border-b border-border/60 px-5 py-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.venue}
            </div>
            <div className="mt-1 flex items-baseline gap-4">
              <span
                className={`font-display text-4xl md:text-5xl ${favHome ? "text-primary" : "text-foreground"}`}
              >
                {game.home.abbreviation}
              </span>
              <span className="font-mono text-sm text-muted-foreground">vs</span>
              <span
                className={`font-display text-4xl md:text-5xl ${!favHome ? "text-primary" : "text-foreground"}`}
              >
                {game.away.abbreviation}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              {game.home.name} · {game.home.record} — {game.away.name} · {game.away.record}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.correct != null ? "Result" : "Status"}
            </div>
            <div className="mt-1 font-mono text-sm">
              {game.correct != null ? (
                <>
                  <span className={game.correct ? "text-emerald-600" : "text-red-500"}>
                    {game.correct ? "✓ Correct" : "✗ Miss"}
                  </span>
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                    {game.awayScore != null && game.homeScore != null
                      ? `${game.awayScore}–${game.homeScore}`
                      : "—"}
                  </span>
                </>
              ) : (
                <span className="text-foreground">{game.status}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 py-5">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Chance to win
        </div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className={`font-display text-6xl ${favHome ? "text-primary" : "text-foreground"}`}>
            {pct(favProb)}
          </span>
          <span className="font-mono text-sm">{favTeam} to win</span>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full ${favHome ? "bg-primary" : "bg-foreground/40"}`}
            style={{ width: `${homeProb * 100}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>
            {game.home.abbreviation} {pct(homeProb)}
          </span>
          <span>
            {game.away.abbreviation} {pct(1 - homeProb)}
          </span>
        </div>
      </div>
    </div>
  );
}

function TopPickCard({ game, rank }: { game: PredictedGame; rank: number }) {
  const homeProb = game.homeWinProb;
  const favHome = homeProb >= 0.5;
  const favProb = favHome ? homeProb : 1 - homeProb;
  const favTeam = favHome ? game.home.abbreviation : game.away.abbreviation;

  return (
    <div className="border border-border bg-card hover:border-primary/50 transition-colors">
      {/* Teams row */}
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              #{rank} · {game.venue}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-display text-xl">{game.home.abbreviation}</span>
              <span className="font-mono text-xs text-muted-foreground">vs</span>
              <span className="font-display text-xl">{game.away.abbreviation}</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {game.home.name} · {game.home.record} — {game.away.name} · {game.away.record}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.correct != null ? "Result" : "Status"}
            </div>
            <div className="mt-1 font-mono text-xs">
              {game.correct != null ? (
                <>
                  <span className={game.correct ? "text-emerald-600" : "text-red-500"}>
                    {game.correct ? "✓ Correct" : "✗ Miss"}
                  </span>
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                    {game.awayScore != null && game.homeScore != null
                      ? `${game.awayScore}–${game.homeScore}`
                      : "—"}
                  </span>
                </>
              ) : (
                <span className="text-foreground">{game.status}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Probability highlight */}
      <div className="px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Chance to win
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={`font-display text-4xl ${favHome ? "text-primary" : "text-foreground"}`}>
            {pct(favProb)}
          </span>
          <span className="font-mono text-xs">{favTeam}</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full ${favHome ? "bg-primary" : "bg-foreground/40"}`}
            style={{ width: `${homeProb * 100}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
          <span>
            {game.home.abbreviation} {pct(homeProb)}
          </span>
          <span>
            {game.away.abbreviation} {pct(1 - homeProb)}
          </span>
        </div>
      </div>
    </div>
  );
}
