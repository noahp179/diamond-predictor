import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { getBestOddsPicks, type GameWithOdds } from "@/lib/mlb.functions";
import { offsetDate } from "@/lib/mlb-features";

export const Route = createFileRoute("/best-odds")({
  head: () => ({
    meta: [
      { title: "Best Odds — Diamond Edge" },
      {
        name: "description",
        content: "Where our model disagrees most with the real DraftKings line.",
      },
    ],
  }),
  component: BestOddsPage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pct(p: number) {
  return `${(p * 100).toFixed(1)}%`;
}

function formatMoneyline(ml: number): string {
  return ml > 0 ? `+${ml}` : `${ml}`;
}

function BestOddsPage() {
  const fetchPicks = useServerFn(getBestOddsPicks);
  const today = todayISO();
  const tomorrow = offsetDate(today, 1);

  const todayQuery = useQuery({
    queryKey: ["best-odds-picks", today],
    queryFn: () => fetchPicks({ data: { date: today } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const tomorrowQuery = useQuery({
    queryKey: ["best-odds-picks", tomorrow],
    queryFn: () => fetchPicks({ data: { date: tomorrow } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  let allGames: GameWithOdds[] = [];
  let picks: GameWithOdds[] = [];
  const isLoading = todayQuery.isLoading || tomorrowQuery.isLoading;
  const isError = todayQuery.isError || tomorrowQuery.isError;
  const isFetching = todayQuery.isFetching || tomorrowQuery.isFetching;
  let chosenDate = today;
  let source: "db" | "live" | undefined;

  if (!isLoading && !isError) {
    const todayGames = todayQuery.data?.games ?? [];
    const nonScheduled = todayGames.filter(
      (g) => g.game.status && g.game.status.toLowerCase() !== "scheduled",
    );
    if (nonScheduled.length > 0) {
      allGames = todayGames;
      picks = todayQuery.data?.picks ?? [];
      chosenDate = today;
      source = todayQuery.data?.source;
    } else {
      allGames = tomorrowQuery.data?.games ?? [];
      picks = tomorrowQuery.data?.picks ?? [];
      chosenDate = tomorrow;
      source = tomorrowQuery.data?.source;
    }
  }

  const withOdds = allGames.filter((g) => g.odds != null).length;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · Best Odds
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Best Value Bets</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              The three games where our model disagrees most with the real DraftKings line — ranked
              by edge, not by our own confidence.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Today's slate
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
            <Link
              to="/model"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Recommended
            </Link>
            <Link
              to="/best-odds"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
              aria-current="page"
            >
              Best Odds
            </Link>
          </div>
        </div>
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-border font-mono text-xs uppercase tracking-widest text-muted-foreground md:grid-cols-4">
            <Stat label="Games" value={`${allGames.length}`} />
            <Stat label="With market odds" value={`${withOdds}/${allGames.length || 0}`} />
            <Stat
              label="Best edge"
              value={picks.length > 0 ? `${(Math.abs(picks[0].edge!) * 100).toFixed(1)}pp` : "—"}
            />
            <Stat
              label="Source"
              value={
                isFetching
                  ? "Updating…"
                  : source === "db"
                    ? "Stored"
                    : source === "live"
                      ? "Live"
                      : "—"
              }
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {isLoading && <p className="text-center py-10">Loading…</p>}
        {isError && (
          <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
            Failed to load games. The MLB Stats API may be unreachable. Try refreshing.
          </div>
        )}
        {!isLoading && !isError && allGames.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No games scheduled</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              No games scheduled for {chosenDate}.
            </p>
          </div>
        )}
        {!isLoading && !isError && allGames.length > 0 && (
          <>
            {picks.length === 0 ? (
              <div className="border border-border bg-card p-10 text-center">
                <div className="font-display text-3xl">Market odds not posted yet</div>
                <p className="mt-2 font-mono text-sm text-muted-foreground">
                  DraftKings usually posts MLB lines within 24–36 hours of first pitch. Check back
                  closer to game time.
                </p>
              </div>
            ) : (
              <div className="grid gap-6">
                {picks.map((g) => (
                  <BestOddCard key={g.game.gameId} entry={g} />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Model odds · sim-elo-v2 · Market odds · DraftKings via ESPN (free, unofficial) · Not
          affiliated with MLB or DraftKings
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

function BestOddCard({ entry }: { entry: GameWithOdds }) {
  const { game, odds, edge } = entry;
  if (!odds || edge == null) return null;

  // Positive edge = our model likes the home side more than the market does.
  const ourSideIsHome = edge >= 0;
  const ourTeam = ourSideIsHome ? game.home.abbreviation : game.away.abbreviation;
  const otherTeam = ourSideIsHome ? game.away.abbreviation : game.home.abbreviation;
  const ourProb = ourSideIsHome ? game.homeWinProb : 1 - game.homeWinProb;
  const marketProb = ourSideIsHome ? odds.homeImpliedProb : odds.awayImpliedProb;
  const ourMoneyline = ourSideIsHome ? odds.homeMoneyLine : odds.awayMoneyLine;

  return (
    <div className="border border-border bg-card hover:border-primary/50 transition-colors">
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.venue}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span
                className={`font-display text-xl ${ourSideIsHome ? "text-primary" : "text-foreground"}`}
              >
                {game.home.abbreviation}
              </span>
              <span className="font-mono text-xs text-muted-foreground">vs</span>
              <span
                className={`font-display text-xl ${!ourSideIsHome ? "text-primary" : "text-foreground"}`}
              >
                {game.away.abbreviation}
              </span>
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

      {/* Model vs market */}
      <div className="grid grid-cols-2 gap-px bg-border/60">
        <div className="bg-card px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            sim-elo-v2 says
          </div>
          <div className="mt-2 font-display text-3xl text-primary">{pct(ourProb)}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{ourTeam} to win</div>
        </div>
        <div className="bg-card px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            DraftKings market
          </div>
          <div className="mt-2 font-display text-3xl text-foreground">{pct(marketProb)}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {formatMoneyline(ourMoneyline)} ({ourTeam})
          </div>
        </div>
      </div>

      {/* Edge */}
      <div className="px-5 py-3 border-t border-border/60">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Edge vs devigged market
        </div>
        <div className="mt-2 font-display text-3xl text-primary">
          +{(Math.abs(edge) * 100).toFixed(1)}pp
        </div>
        <p className="mt-1 font-mono text-sm text-muted-foreground">
          Our model puts {ourTeam} {(Math.abs(edge) * 100).toFixed(1)} points higher than the
          market's fair (vig-removed) line — the market's own moneyline for {otherTeam} is{" "}
          {formatMoneyline(ourSideIsHome ? odds.awayMoneyLine : odds.homeMoneyLine)}.
        </p>
      </div>
    </div>
  );
}
