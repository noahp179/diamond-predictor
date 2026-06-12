import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getModelV2Games, getSettledPredictions } from "@/lib/mlb.functions";
import type { PredictedGameV4 } from "@/lib/mlb-core-v4";

export const Route = createFileRoute("/model")({
  head: () => ({
    meta: [
      { title: "Top Picks — Diamond Edge" },
      {
        name: "description",
        content:
          "Highlighting the three most confident predictions for today's slate.",
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

function confidenceScore(game: PredictedGameV4): number {
  // Distance from 50% (0.5) scaled to 0-1
  return Math.abs(game.v4WinProb - 0.5) * 2;
}

function ModelPage() {
  const [date, setDate] = useState(todayISO());
  const fetchV2Games = useServerFn(getModelV2Games);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["model-games", date],
    queryFn: () => fetchV2Games({ data: { date } }),
    staleTime: 5 * 60_000,
  });

  const games = (data?.games ?? []) as PredictedGameV4[];

  // Compute confidence and sort
  const scored = games
    .map((g) => ({ game: g, score: confidenceScore(g) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.game);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · Top Picks
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">
              Top 3 Picks
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              The three predictions with the highest confidence (distance from 50%).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              ← Today's slate
            </Link>
            <Link
              to="/history"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Track record
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {isLoading && <p className="text-center py-10">Loading…</p>}
        {isError && (
          <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
            Failed to load predictions. The MLB Stats API may be unreachable.
          </div>
        )}
        {!isLoading && !isError && games.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No games found</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              No scheduled games for {date}.
            </p>
          </div>
        )}
        {!isLoading && !isError && games.length > 0 && (
          <>
            {scored.length === 0 ? (
              <p className="text-center py-8">
                Not enough data to compute picks.
              </p>
            ) : (
              <div className="grid gap-6">
                {scored.map((g) => (
                  <TopPickCard key={g.gameId} game={g} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Data · MLB Stats API (statsapi.mlb.com) · Not affiliated with MLB
        </div>
      </footer>
    </div>
  );
}

function TopPickCard({ game }: { game: PredictedGameV4 }) {
  const homeV4 = game.v4WinProb;
  const favHome = homeV4 >= 0.5;
  const favProb = favHome ? homeV4 : 1 - homeV4;
  const favTeam = favHome ? game.home.abbreviation : game.away.abbreviation;
  const underdog = favHome ? game.away.abbreviation : game.home.abbreviation;
  const confidence = pct(confidenceScore(game));

  return (
    <div className="border border-border bg-card hover:border-primary/50 transition-colors">
      {/* Teams row */}
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.venue}
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
                <span className={game.correct ? "text-emerald-600" : "text-red-500"}>
                  {game.correct ? "✓ Correct" : "✗ Miss"}
                </span>
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
          Model V4 Win Probability
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
            style={{ width: `${homeV4 * 100}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
          <span>{game.home.abbreviation} {pct(homeV4)}</span>
          <span>{game.away.abbreviation} {pct(1 - homeV4)}</span>
        </div>
      </div>

      {/* Confidence badge */}
      <div className="px-5 py-3 border-t border-border/60">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Confidence
        </div>
        <div className="mt-2 font-display text-3xl text-primary">
          {confidence}
        </div>
        <p className="mt-1 font-mono text-sm text-muted-foreground">
          Distance from 50% (higher = more confident)
        </p>
      </div>
    </div>
  );
}