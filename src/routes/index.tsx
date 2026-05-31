import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getDailyGames, runPipeline } from "@/lib/mlb.functions";
import { GameCard } from "@/components/GameCard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Diamond Edge — MLB Win Probabilities" },
      { name: "description", content: "Daily MLB matchups with transparent win-probability predictions powered by live MLB Stats data." },
      { property: "og:title", content: "Diamond Edge — MLB Win Probabilities" },
      { property: "og:description", content: "Daily MLB matchups with transparent win-probability predictions." },
    ],
  }),
  component: Index,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function Index() {
  const router = useRouter();
  const [date, setDate] = useState(todayISO());
  const fetchGames = useServerFn(getDailyGames);
  const runPipelineFn = useServerFn(runPipeline);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["games", date],
    queryFn: () => fetchGames({ data: { date } }),
    staleTime: 60_000,
  });
  const [syncing, setSyncing] = useState(false);

  const games = data?.games ?? [];
  const avgEdge =
    games.length > 0
      ? games.reduce((a, g) => a + Math.max(g.homeWinProb, g.awayWinProb), 0) / games.length
      : 0;
  const settledToday = games.filter((g) => g.correct != null);
  const correctToday = settledToday.filter((g) => g.correct).length;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · MLB Forecast
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">
              Today's Slate
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Live matchups from the MLB Stats API. Win probabilities blend season form,
              home-field, and starting-pitcher ERA into a transparent baseline model.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
            <Link
              to="/history"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Track record
            </Link>
            <button
              onClick={async () => {
                setSyncing(true);
                try {
                  await runPipelineFn({ data: { date } });
                  await refetch();
                  router.invalidate();
                } finally {
                  setSyncing(false);
                }
              }}
              className="border border-primary bg-primary px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90"
            >
              {syncing || isFetching ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </div>
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border font-mono text-xs uppercase tracking-widest text-muted-foreground md:grid-cols-4">
            <Stat label="Games" value={`${games.length}`} />
            <Stat label="Avg favorite" value={games.length ? `${Math.round(avgEdge * 100)}%` : "—"} />
            <Stat
              label="Today settled"
              value={settledToday.length ? `${correctToday}/${settledToday.length}` : "—"}
            />
            <Stat label="Source" value={data?.source === "db" ? "Stored" : data?.source === "live" ? "Live" : "—"} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
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
          Data · MLB Stats API (statsapi.mlb.com) · Not affiliated with MLB
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
