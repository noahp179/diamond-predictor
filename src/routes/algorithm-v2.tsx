import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getV3DailyGames, getMetrics } from "@/lib/mlb.functions";
import { MODEL_VERSION_V3 } from "@/lib/mlb-v3";
import { GameCard } from "@/components/GameCard";

export const Route = createFileRoute("/algorithm-v2")({
  head: () => ({
    meta: [
      { title: "Algorithm V2 (sim-elo-v3) — Diamond Edge" },
      {
        name: "description",
        content:
          "Algorithm V2 (sim-elo-v3): the simulator fed schedule-strength-adjusted rates plus a game-context layer (streaks, rest, travel, bullpen stress). Tracked live against the headline model.",
      },
      { property: "og:title", content: "Algorithm V2 (sim-elo-v3) — Diamond Edge" },
      {
        property: "og:description",
        content:
          "Schedule-strength-adjusted Monte Carlo + game-context predictions, tracked live against sim-elo-v2.",
      },
    ],
  }),
  component: AlgorithmV2Page,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function AlgorithmV2Page() {
  const [date, setDate] = useState(todayISO());
  const fetchGames = useServerFn(getV3DailyGames);
  const fetchMetrics = useServerFn(getMetrics);
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["v3-games", date],
    queryFn: () => fetchGames({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const { data: metrics } = useQuery({
    queryKey: ["metrics", MODEL_VERSION_V3],
    queryFn: () => fetchMetrics({ data: { modelVersion: MODEL_VERSION_V3 } }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const games = data?.games ?? [];
  const settledToday = games.filter((g) => g.correct != null);
  const correctToday = settledToday.filter((g) => g.correct).length;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · sim-elo-v3 · Candidate model
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Algorithm V2</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              The Monte Carlo simulator fed <strong>schedule-strength-adjusted</strong> rates —
              batting corrected for the pitching it faced, pitching for the lineups it drew, and
              every rate de-parked — plus a capped <strong>game-context</strong> layer (win streaks,
              recent form, rest, travel, time-zone shifts, bullpen stress). Built on top of the
              headline sim-elo-v2 and tracked against it on the{" "}
              <Link to="/history" className="text-primary underline-offset-2 hover:underline">
                Track Record
              </Link>
              .
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
              Today's slate
            </Link>
            <Link
              to="/algorithm-v2"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
              aria-current="page"
            >
              Algorithm V2
            </Link>
            <Link
              to="/history"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Track record
            </Link>
            <Link
              to="/teams"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Teams
            </Link>
          </div>
        </div>
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border font-mono text-xs uppercase tracking-widest text-muted-foreground md:grid-cols-4">
            <Stat label="Games" value={`${games.length}`} />
            <Stat
              label="Historical accuracy"
              value={metrics?.accuracy != null ? `${(metrics.accuracy * 100).toFixed(1)}%` : "—"}
            />
            <Stat
              label="Brier (settled)"
              value={metrics?.brier != null ? metrics.brier.toFixed(4) : "—"}
            />
            <Stat
              label="Today settled"
              value={settledToday.length ? `${correctToday}/${settledToday.length}` : "—"}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {metrics != null && metrics.settled === 0 && (
          <div className="mb-6 border border-primary/40 bg-primary/5 px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Shadow model · sim-elo-v3 records a prediction on every slate and is scored at
            settlement alongside sim-elo-v2. No games have settled yet — probabilities below are{" "}
            {data?.source === "live" ? "computed live" : "from the daily run"}.
          </div>
        )}
        {isLoading && <SkeletonGrid />}
        {isError && (
          <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
            Failed to load games. The MLB Stats API may be unreachable. Try refreshing.
          </div>
        )}
        {!isLoading && !isError && games.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No games scheduled</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              Pick another date — off-days happen, especially in the All-Star break.
            </p>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <GameCard key={g.gameId} game={g} />
          ))}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          sim-elo-v3 · Monte Carlo × multi-season Elo, schedule-strength-adjusted + game context ·
          Source: MLB Stats API · Not affiliated with MLB
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-4">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl text-foreground">{value}</div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-56 animate-pulse border border-border bg-card" />
      ))}
    </div>
  );
}
