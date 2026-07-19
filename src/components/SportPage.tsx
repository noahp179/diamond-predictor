import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { GameCard } from "@/components/GameCard";
import { SiteNav } from "@/components/SiteNav";
import { SportTabs } from "@/components/SportTabs";
import type { getNbaSlate } from "@/lib/sports.functions";

type SlateResult = Awaited<ReturnType<typeof getNbaSlate>>;
type SlateFn = (opts: { data: { date: string } }) => Promise<SlateResult>;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function SportPage({
  sport,
  eyebrow,
  blurb,
  fetchSlate,
}: {
  sport: "nfl" | "nba";
  eyebrow: string;
  blurb: string;
  fetchSlate: SlateFn;
}) {
  const [date, setDate] = useState(todayISO());
  const run = useServerFn(fetchSlate as unknown as typeof getNbaSlate);
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: [sport, date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const games = data?.games ?? [];
  const power = data?.power ?? [];
  const settled = games.filter((g) => g.correct != null);
  const correct = settled.filter((g) => g.correct).length;
  const label = sport.toUpperCase();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              {eyebrow}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">{label} Slate</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">{blurb}</p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
            <SiteNav current={sport} />
          </div>
        </div>
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border font-mono text-xs uppercase tracking-widest text-muted-foreground md:grid-cols-4">
            <Stat label="Games" value={`${games.length}`} />
            <Stat label="Season" value={data?.seasonLabel || "—"} />
            <Stat
              label="Today settled"
              value={settled.length ? `${correct}/${settled.length}` : "—"}
            />
            <Stat
              label="Source"
              value={
                isFetching
                  ? "Updating…"
                  : data?.source === "live"
                    ? "Live · ESPN"
                    : data?.source === "error"
                      ? "Unavailable"
                      : "—"
              }
            />
          </div>
        </div>
      </header>

      <SportTabs sport={sport} current="slate" />

      <main className="mx-auto max-w-6xl px-6 py-10">
        {isLoading && <SkeletonGrid />}
        {isError && (
          <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
            Failed to load the {label} slate. The ESPN scoreboard may be unreachable. Try
            refreshing.
          </div>
        )}

        {!isLoading && !isError && data?.note && (
          <div className="mb-8 border border-border bg-card p-6 font-mono text-sm text-muted-foreground">
            {data.note}
          </div>
        )}

        {!isLoading && !isError && games.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {games.map((g) => (
              <GameCard key={g.gameId} game={g} modelLabel="Elo" />
            ))}
          </div>
        )}

        {!isLoading && !isError && games.length === 0 && !data?.note && (
          <div className="mb-8 border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No games scheduled</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              Pick another date — the {label} doesn't play every day.
            </p>
          </div>
        )}

        {power.length > 0 && (
          <section className="mt-10">
            <div className="mb-4 flex items-end justify-between">
              <h2 className="font-display text-3xl">Elo Power Ranking</h2>
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Model rating
                {data?.gamesReplayed
                  ? ` · ${data.gamesReplayed.toLocaleString()} games replayed`
                  : ""}
              </span>
            </div>
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {power.map((row) => (
                <div
                  key={row.abbr}
                  className="flex items-center justify-between border-b border-border/60 py-1.5 font-mono text-sm"
                >
                  <span className="text-muted-foreground">
                    <span className="inline-block w-7 text-right tabular-nums">{row.rank}</span>{" "}
                    <span className="text-foreground">{row.abbr}</span>{" "}
                    <span className="text-muted-foreground">{row.name}</span>
                  </span>
                  <span className="tabular-nums text-foreground">{row.elo}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Data · ESPN scoreboard · margin-of-victory Elo · Not affiliated with the {label}
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
