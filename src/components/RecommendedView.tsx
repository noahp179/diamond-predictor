import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { GameCard } from "@/components/GameCard";
import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import type { getNbaRecommended } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getNbaRecommended>>;
type Fn = (opts: { data: { date: string } }) => Promise<Result>;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function conf(p: { homeWinProb: number; awayWinProb: number }) {
  return Math.max(p.homeWinProb, p.awayWinProb);
}

export function RecommendedView({
  sport,
  fetchRecommended,
}: {
  sport: "nfl" | "nba";
  fetchRecommended: Fn;
}) {
  const [date, setDate] = useState(todayISO());
  const run = useServerFn(fetchRecommended as unknown as typeof getNbaRecommended);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "recommended", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const picks = data?.picks ?? [];
  const hero = picks[0];
  const runners = picks.slice(1);
  const label = sport.toUpperCase();

  return (
    <SportShell
      sport={sport}
      current="recommended"
      eyebrow={`Diamond Edge · ${label} Recommended`}
      title="Best Bets"
      blurb="The games the Elo model is most confident about, most confident first. Confidence is the model's own win probability for the favored side — not a market edge."
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Games" value={`${data?.games?.length ?? 0}`} />
          <Stat label="Ranked picks" value={`${picks.length}`} />
          <Stat label="Top confidence" value={hero ? `${Math.round(conf(hero) * 100)}%` : "—"} />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load {label} picks. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && hero && (
        <>
          <div className="mb-3 flex items-center gap-3 font-mono text-[11px] uppercase tracking-widest text-primary">
            <span>★ Best game</span>
            <span className="text-muted-foreground">highest model confidence on the slate</span>
          </div>
          <div className="mb-10">
            <GameCard game={hero} modelLabel="Elo" />
          </div>

          {runners.length > 0 && (
            <>
              <h2 className="mb-4 font-display text-3xl">Runners-up</h2>
              <div className="grid gap-4 md:grid-cols-2">
                {runners.map((g) => (
                  <GameCard key={g.gameId} game={g} modelLabel="Elo" />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {!isLoading && !isError && !hero && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to rank</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick another date — the {label} doesn't play every day.
          </p>
        </div>
      )}
    </SportShell>
  );
}
