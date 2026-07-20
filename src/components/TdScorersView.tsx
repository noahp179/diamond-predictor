import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { getNflTdScorers } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getNflTdScorers>>;
type Game = Result["games"][number];
type Pick = Game["picks"][number];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Confidence tier → label + color, so the number reads at a glance. */
function tier(conf: number) {
  if (conf >= 70) return { label: "High", cls: "text-primary border-primary/40" };
  if (conf >= 55) return { label: "Lean", cls: "text-foreground border-border" };
  return { label: "Toss-up", cls: "text-muted-foreground border-border" };
}

function PickRow({ pick, rank }: { pick: Pick; rank: number }) {
  const t = tier(pick.confidence);
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <span className="w-5 shrink-0 font-mono text-sm text-primary/70">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-lg leading-tight">{pick.player}</div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {pick.team}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-2xl leading-none text-foreground">
          {Math.round(pick.prob * 100)}%
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          to score
        </div>
      </div>
      <div
        className={`shrink-0 rounded-none border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${t.cls}`}
        title="Confidence that this player is a top scorer (separation, sample size, workload)."
      >
        <div className="text-sm leading-none">{pick.confidence}</div>
        <div className="mt-0.5">{t.label}</div>
      </div>
    </div>
  );
}

function GameCard({ game }: { game: Game }) {
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm uppercase tracking-widest text-foreground">
          {game.matchup}
        </div>
        {game.total != null && (
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            O/U {game.total}
          </div>
        )}
      </div>
      <div>
        {game.picks.slice(0, 3).map((p, i) => (
          <PickRow key={p.playerId} pick={p} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}

export function TdScorersView() {
  const [date, setDate] = useState(todayISO());
  const run = useServerFn(getNflTdScorers);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["nfl", "td-scorers", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const games = data?.games ?? [];
  const topPick = games[0]?.picks[0];

  return (
    <SportShell
      sport="nfl"
      current="tdScorers"
      eyebrow="Diamond Edge · NFL TD Scorers"
      title="Touchdown Scorers"
      blurb="The players most likely to score a touchdown in each game — a logistic model over season usage and the market's implied team total (backtested to ~50% on the top pick, ~69% for the top two). Likelihood is the chance of an anytime TD; confidence grades how clear the pick is."
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat
            label="Top pick"
            value={topPick ? `${Math.round(topPick.prob * 100)}%` : "—"}
          />
          <Stat label="Model" value="Logistic + Market" />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load NFL TD scorers. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && games.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <GameCard key={g.gameId} game={g} />
          ))}
        </div>
      )}

      {!isLoading && !isError && games.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No games to project</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick an NFL game day — touchdown picks need a slate to work with. Player usage builds up
            over the season, so picks sharpen after Week 1.
          </p>
        </div>
      )}
    </SportShell>
  );
}
