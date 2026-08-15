import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getDailyGames, getMetrics } from "@/lib/mlb.functions";
import { GameCard } from "@/components/GameCard";
import { AppShell, StatBar, Stat } from "@/components/AppShell";

export const Route = createFileRoute("/mlb/")({
  head: () => ({
    meta: [
      { title: "Diamond Edge — MLB Win Probabilities" },
      {
        name: "description",
        content:
          "Daily MLB matchups with transparent win-probability predictions powered by live MLB Stats data.",
      },
      { property: "og:title", content: "Diamond Edge — MLB Win Probabilities" },
      {
        property: "og:description",
        content: "Daily MLB matchups with transparent win-probability predictions.",
      },
    ],
  }),
  component: Index,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function Index() {
  const [date, setDate] = useState(todayISO());
  const fetchGames = useServerFn(getDailyGames);
  const fetchMetrics = useServerFn(getMetrics);
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["games", date],
    queryFn: () => fetchGames({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const { data: metrics } = useQuery({
    queryKey: ["metrics"],
    queryFn: () => fetchMetrics(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const games = data?.games ?? [];
  const settledToday = games.filter((g) => g.correct != null);
  const correctToday = settledToday.filter((g) => g.correct).length;

  return (
    <AppShell
      sport="mlb"
      view="slate"
      eyebrow="Diamond Edge · MLB Forecast"
      title="MLB Slate"
      blurb="Live matchups from the MLB Stats API. Win probabilities blend season form, home-field, and starting-pitcher ERA into a transparent baseline model."
      date={date}
      onDateChange={setDate}
      footerNote="Data · MLB Stats API (statsapi.mlb.com) · Not affiliated with MLB"
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat
            label="Historical accuracy"
            value={metrics?.accuracy != null ? `${(metrics.accuracy * 100).toFixed(1)}%` : "—"}
          />
          <Stat
            label="Today settled"
            value={settledToday.length ? `${correctToday}/${settledToday.length}` : "—"}
          />
          <Stat
            label="Source"
            value={
              isFetching
                ? "Updating…"
                : data?.source === "db"
                  ? "Stored"
                  : data?.source === "live"
                    ? "Live"
                    : "—"
            }
          />
        </StatBar>
      }
    >
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
    </AppShell>
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
