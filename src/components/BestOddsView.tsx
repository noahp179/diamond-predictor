import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import type { getNbaBestOdds } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getNbaBestOdds>>;
type Row = Result["rows"][number];
type Fn = (opts: { data: { date: string } }) => Promise<Result>;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}
function fmtMl(ml: number) {
  return ml > 0 ? `+${ml}` : `${ml}`;
}

export function BestOddsView({
  sport,
  fetchBestOdds,
}: {
  sport: "nfl" | "nba";
  fetchBestOdds: Fn;
}) {
  const [date, setDate] = useState(todayISO());
  const [tab, setTab] = useState<"market" | "blend">("market");
  const run = useServerFn(fetchBestOdds as unknown as typeof getNbaBestOdds);
  const { data, isLoading, isError } = useQuery({
    queryKey: [sport, "best-odds", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const label = sport.toUpperCase();
  const picks = tab === "market" ? (data?.marketPicks ?? []) : (data?.blendPicks ?? []);

  return (
    <SportShell
      sport={sport}
      current="bestOdds"
      eyebrow={`Diamond Edge · ${label} Best Odds`}
      title="Best Odds"
      blurb="The safest bets on the board, ranked by confidence in the outcome — either the market's own devigged line, or that line blended with the Elo model. Safest, not +EV: favorites lose money at the book's price."
      date={date}
      onDateChange={setDate}
      statBar={
        <StatBar>
          <Stat label="Games" value={`${data?.rows?.length ?? 0}`} />
          <Stat label="Priced" value={`${data?.priced ?? 0}`} />
          <Stat
            label="Blend weight"
            value={data?.blendWeight ? `${Math.round(data.blendWeight * 100)}% mkt` : "—"}
          />
          <Stat label="Season" value={data?.seasonLabel || "—"} />
        </StatBar>
      }
    >
      {/* tab switch */}
      <div className="mb-6 flex flex-wrap gap-2 font-mono text-[11px] uppercase tracking-widest">
        <button
          onClick={() => setTab("market")}
          className={`border px-4 py-2 transition-colors ${tab === "market" ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground hover:text-foreground"}`}
        >
          Best Odds · market line
        </button>
        <button
          onClick={() => setTab("blend")}
          className={`border px-4 py-2 transition-colors ${tab === "blend" ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground hover:text-foreground"}`}
        >
          Odds × Model · blended
        </button>
      </div>

      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load {label} odds. The ESPN scoreboard may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}
      {!isLoading && !isError && !data?.note && picks.length === 0 && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No priced games</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            No market lines are posted for this date yet. Try another date.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {picks.map((r) => (
          <OddsCard key={r.game.gameId} row={r} tab={tab} />
        ))}
      </div>
    </SportShell>
  );
}

function OddsCard({ row, tab }: { row: Row; tab: "market" | "blend" }) {
  const { game, odds, blendHome } = row;
  if (!odds) return null;
  // The tab decides which probability ranks/leads the pick.
  const homeProb = tab === "market" ? odds.devigHome : (blendHome ?? odds.devigHome);
  const pickHome = homeProb >= 0.5;
  const pickSide = pickHome ? game.home : game.away;
  const pickMl = pickHome ? odds.homeML : odds.awayML;
  const pickProb = pickHome ? homeProb : 1 - homeProb;
  const settled = game.correct != null;
  const hit = settled && (pickHome ? game.winner === "home" : game.winner === "away");

  return (
    <article className="border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        <span>
          {game.away.abbreviation} @ {game.home.abbreviation}
        </span>
        <span className={!settled ? "text-primary" : hit ? "text-grass" : "text-clay"}>
          {!settled ? game.status : hit ? "✓ Hit" : "✗ Miss"}
        </span>
      </div>
      <div className="flex items-end justify-between px-5 py-5">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Pick
          </div>
          <div className="mt-1 font-display text-4xl">{pickSide.abbreviation}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {fmtMl(pickMl)} · {odds.provider}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {tab === "market" ? "Market confidence" : "Blended confidence"}
          </div>
          <div className="mt-1 font-display text-4xl text-primary">{pct(pickProb)}</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-border bg-border font-mono text-xs">
        <MiniProb label="Model" value={pickHome ? game.homeWinProb : game.awayWinProb} />
        <MiniProb label="Market" value={pickHome ? odds.devigHome : 1 - odds.devigHome} />
        <MiniProb label="Blend" value={pickHome ? (blendHome ?? 0) : 1 - (blendHome ?? 0)} />
      </div>
    </article>
  );
}

function MiniProb({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card px-4 py-3 text-center">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-foreground">{pct(value)}</div>
    </div>
  );
}
