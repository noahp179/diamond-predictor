import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { getBestOddsPicks, type GameWithOdds } from "@/lib/mlb.functions";
import { offsetDate, slateComplete } from "@/lib/mlb-features";
import { pickProb, MARKET_BLEND_WEIGHT } from "@/lib/mlb-blend";

export const Route = createFileRoute("/best-odds")({
  validateSearch: (search: Record<string, unknown>): { tab?: OddsTab } => ({
    tab: search.tab === "blend" ? "blend" : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Best Odds — Diamond Edge" },
      {
        name: "description",
        content:
          "The safest bets on today's slate, ranked by confidence in the outcome — from the market line alone, or blended with our model.",
      },
    ],
  }),
  component: BestOddsPage,
});

type OddsTab = "market" | "blend";

const TAB_LABEL: Record<OddsTab, string> = {
  market: "Best Odds",
  blend: "Odds × Model",
};
const TAB_BLURB: Record<OddsTab, string> = {
  market:
    "The three surest outcomes on the slate according to the market itself — DraftKings' own line, vig removed, ranked by the favorite's win probability.",
  blend:
    "The three surest outcomes once our Simulator prediction is blended with the market line (Market Blend) — the highest confidence picks given both the odds and our model.",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pct(p: number) {
  return `${(p * 100).toFixed(1)}%`;
}

function formatMoneyline(ml: number): string {
  return ml > 0 ? `+${ml}` : `${ml}`;
}

/** Confidence of the entry's pick under a tab's ranking. */
function tabConfidence(entry: GameWithOdds, tab: OddsTab): number | null {
  if (tab === "market") return entry.odds ? pickProb(entry.odds.homeImpliedProb) : null;
  return entry.blendedHomeProb != null ? pickProb(entry.blendedHomeProb) : null;
}

function BestOddsPage() {
  const fetchPicks = useServerFn(getBestOddsPicks);
  const today = todayISO();
  const tomorrow = offsetDate(today, 1);
  const tab: OddsTab = Route.useSearch().tab ?? "market";
  const navigate = Route.useNavigate();
  const setTab = React.useCallback(
    (t: OddsTab) => navigate({ search: t === "blend" ? { tab: t } : {}, replace: true }),
    [navigate],
  );

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
  let marketPicks: GameWithOdds[] = [];
  let blendPicks: GameWithOdds[] = [];
  const isLoading = todayQuery.isLoading || tomorrowQuery.isLoading;
  const isError = todayQuery.isError || tomorrowQuery.isError;
  const isFetching = todayQuery.isFetching || tomorrowQuery.isFetching;
  let chosenDate = today;
  let source: "db" | "live" | undefined;

  if (!isLoading && !isError) {
    // Show today until its slate is over (nothing left upcoming or live),
    // then roll to tomorrow.
    const todayGames = todayQuery.data?.games ?? [];
    const todayDone = slateComplete(todayGames.map((g) => g.game.status));
    const chosen = todayDone ? tomorrowQuery.data : todayQuery.data;
    allGames = chosen?.games ?? [];
    marketPicks = chosen?.marketPicks ?? [];
    blendPicks = chosen?.blendPicks ?? [];
    chosenDate = todayDone ? tomorrow : today;
    source = chosen?.source;
  }

  const withOdds = allGames.filter((g) => g.odds != null).length;
  const picks = tab === "market" ? marketPicks : blendPicks;
  const topConfidence = picks.length > 0 ? tabConfidence(picks[0], tab) : null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · Best Odds
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Safest Bets</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Ranked by confidence in the outcome — the market's line alone, or the market blended
              with our model's prediction.
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
              label="Top pick confidence"
              value={topConfidence != null ? pct(topConfidence) : "—"}
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
        {/* Tab controls */}
        <div className="border-b border-border pb-4">
          <div className="-mb-px flex flex-wrap">
            {(["market", "blend"] as OddsTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`inline-flex items-center border-b-2 border-transparent px-4 py-2 text-sm font-medium first:pl-0 ${
                  tab === t
                    ? "border-primary text-primary"
                    : "text-muted-foreground hover:border-primary/50 hover:text-primary"
                }`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          <p className="mt-3 max-w-2xl font-mono text-xs text-muted-foreground">{TAB_BLURB[tab]}</p>
        </div>

        <div className="mt-6">
          {isLoading && <p className="py-10 text-center">Loading…</p>}
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
                  {picks.map((g, i) => (
                    <BestOddCard key={g.game.gameId} entry={g} tab={tab} rank={i + 1} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Model · Simulator · Blend · Market Blend (market weight {MARKET_BLEND_WEIGHT}) · Market
          odds · DraftKings via ESPN (free, unofficial) · Not affiliated with MLB or DraftKings
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

function BestOddCard({ entry, tab, rank }: { entry: GameWithOdds; tab: OddsTab; rank: number }) {
  const { game, odds, edge, blendedHomeProb } = entry;
  if (!odds) return null;

  // The pick is the side the active tab's probability favors.
  const rankProb = tab === "market" ? odds.homeImpliedProb : (blendedHomeProb ?? 0.5);
  const pickIsHome = rankProb >= 0.5;
  const pickTeam = pickIsHome ? game.home.abbreviation : game.away.abbreviation;
  const confidence = pickProb(rankProb);
  const marketProb = pickIsHome ? odds.homeImpliedProb : odds.awayImpliedProb;
  const modelProb = pickIsHome ? game.homeWinProb : 1 - game.homeWinProb;
  const pickMoneyline = pickIsHome ? odds.homeMoneyLine : odds.awayMoneyLine;

  // Did the pick win? (game.correct tracks the model's side, not the tab's.)
  const pickResult =
    game.winner === "home" || game.winner === "away"
      ? (game.winner === "home") === pickIsHome
      : null;

  return (
    <div className="border border-border bg-card transition-colors hover:border-primary/50">
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              #{rank} · {game.venue}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span
                className={`font-display text-xl ${pickIsHome ? "text-primary" : "text-foreground"}`}
              >
                {game.home.abbreviation}
              </span>
              <span className="font-mono text-xs text-muted-foreground">vs</span>
              <span
                className={`font-display text-xl ${!pickIsHome ? "text-primary" : "text-foreground"}`}
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
              {pickResult != null ? "Pick result" : "Status"}
            </div>
            <div className="mt-1 font-mono text-xs">
              {pickResult != null ? (
                <span className={pickResult ? "text-emerald-600" : "text-red-500"}>
                  {pickResult ? "✓ Correct" : "✗ Miss"}
                </span>
              ) : (
                <span className="text-foreground">{game.status}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confidence headline */}
      <div className="border-b border-border/60 px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {tab === "market" ? "Market confidence" : "Blended confidence (odds × model)"}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-display text-4xl text-primary">{pct(confidence)}</span>
          <span className="font-mono text-xs text-foreground">
            {pickTeam} to win · {formatMoneyline(pickMoneyline)}
          </span>
        </div>
      </div>

      {/* Model vs market breakdown */}
      <div className="grid grid-cols-2 gap-px bg-border/60">
        <div className="bg-card px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            DraftKings market says
          </div>
          <div
            className={`mt-2 font-display text-3xl ${tab === "market" ? "text-primary" : "text-foreground"}`}
          >
            {pct(marketProb)}
          </div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">
            {pickTeam} to win (vig removed)
          </div>
        </div>
        <div className="bg-card px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Simulator says
          </div>
          <div className="mt-2 font-display text-3xl text-foreground">{pct(modelProb)}</div>
          <div className="mt-1 font-mono text-xs text-muted-foreground">{pickTeam} to win</div>
        </div>
      </div>

      {/* Agreement note */}
      <div className="border-t border-border/60 px-5 py-3">
        <p className="font-mono text-xs text-muted-foreground">
          {edge != null && Math.abs(edge) >= 0.005 ? (
            <>
              Our model is {(Math.abs(pickIsHome ? edge : -edge) * 100).toFixed(1)}pp{" "}
              {(pickIsHome ? edge : -edge) > 0 ? "higher" : "lower"} than the market on {pickTeam}
              {tab === "blend"
                ? " — the blend leans on the market but keeps our signal."
                : (pickIsHome ? edge : -edge) > 0
                  ? " — the model agrees and then some."
                  : " — the model is more cautious than the price."}
            </>
          ) : (
            <>Our model and the market are in near-perfect agreement on this game.</>
          )}
        </p>
      </div>
    </div>
  );
}
