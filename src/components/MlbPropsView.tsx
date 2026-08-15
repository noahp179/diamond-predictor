import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { boardPicks } from "@/lib/props-board";
import { getMlbProps } from "@/lib/sports.functions";

type Result = Awaited<ReturnType<typeof getMlbProps>>;
type Game = Result["games"][number];
type Pick = Game["picks"][number];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;

/**
 * Tier styling. The tiers themselves (and their hit rates) come from the model
 * file — each market's breakpoints were cut on the held-out 2026 season where
 * the hit rate actually separates, not at round numbers.
 * See research/mlb-props/final.py.
 */
const TIER_CLS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function PickRow({ pick, showMarket }: { pick: Pick; showMarket: boolean }) {
  const cls = TIER_CLS[pick.tier ?? "Lean"] ?? TIER_CLS.Lean;
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <span className="w-5 shrink-0 font-mono text-[11px] text-primary/70">
        {pick.kind === "pitcher" ? "P" : pick.slot}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-lg leading-tight">{pick.player}</div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {pick.team} vs {pick.opponent}
          {showMarket ? ` · ${pick.label}` : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-display text-2xl leading-none text-foreground">{pct(pick.prob)}</div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {signed(pick.edge)} vs avg
        </div>
      </div>
      <div
        className={`w-20 shrink-0 rounded-none border px-2 py-1 text-center font-mono text-[10px] uppercase tracking-widest ${cls}`}
        title={
          pick.tierHitRate != null
            ? `${pick.tier}: picks in this tier hit ${pct(pick.tierHitRate)} of the time on the held-out 2026 season.`
            : "No backtested tier for this market."
        }
      >
        <div className="text-xs leading-none">{pick.tier ?? "—"}</div>
        <div className="mt-0.5">{pick.tierHitRate != null ? pct(pick.tierHitRate) : "—"}</div>
      </div>
    </div>
  );
}

function GameCard({ game, market }: { game: Game; market: string }) {
  const picks = game.picks;
  if (picks.length === 0) return null;
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm uppercase tracking-widest text-foreground">
          {game.matchup}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {game.lineupsPosted ? "Lineups in" : "Projected lineup"} · Park{" "}
          {Math.round(game.park * 100)}
        </div>
      </div>
      <div>
        {picks.map((p) => (
          <PickRow key={`${p.playerId}-${p.market}`} pick={p} showMarket={market === "all"} />
        ))}
      </div>
    </div>
  );
}

export function MlbPropsView() {
  const [date, setDate] = useState(todayISO());
  const [market, setMarket] = useState("all");
  const [strongOnly, setStrongOnly] = useState(false);
  const run = useServerFn(getMlbProps);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mlb", "props", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const markets = data?.markets ?? [];
  // Each game carries exactly the picks its card will render, so the counters
  // above the board and the rows below it can never disagree.
  const games = useMemo(
    () =>
      (data?.games ?? [])
        .map((g) => ({ ...g, picks: boardPicks(g.picks, market, strongOnly) }))
        .filter((g) => g.picks.length > 0),
    [data, market, strongOnly],
  );

  const shown = games.flatMap((g) => g.picks);
  const best = shown.reduce<Pick | null>((b, p) => (b == null || p.edge > b.edge ? p : b), null);
  // Count Strong picks the way the board counts everything else — one per
  // player — so the toggle promises the number of rows it will actually leave.
  const strongCount = (data?.games ?? []).flatMap((g) => boardPicks(g.picks, market, true)).length;
  const active = markets.find((m) => m.key === market);

  return (
    <SportShell
      sport="mlb"
      current="props"
      eyebrow="Diamond Edge · MLB Player Props"
      title="Player Props"
      blurb="Sixteen prop markets — the full hits (1+ to 4+) and total-bases (2+ to 5+) ladders, plus home runs, RBI, runs, steals and starter strikeouts — each its own logistic model over season-to-date form, the last 30 days, the opposing starter and the park. Top picks shows one row per player, at the rung with the biggest edge, so a starter never appears three times over at 5+, 6+ and 7+ strikeouts; pick a market to see every player at that exact number. Percentages are calibrated probabilities; tiers are cut where the held-out 2026 season actually separates."
      date={date}
      onDateChange={setDate}
      footerNote="Data · MLB Stats API · logistic prop models (backtested on 2026)"
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat label="Picks" value={`${shown.length}`} />
          <Stat label="Strong picks" value={`${strongCount}`} />
          <Stat
            label={best ? best.label : "Best edge"}
            value={best ? `${pct(best.prob)} ${best.player.split(" ").slice(-1)[0]}` : "—"}
          />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load MLB props. MLB Stats API may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {!isLoading && !isError && markets.length > 0 && (
        <div className="mb-6 border border-border bg-card">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
            {[{ key: "all", label: "Top picks", kind: "", base: 0, auc: 0 }, ...markets].map(
              (m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMarket(m.key)}
                  aria-pressed={market === m.key}
                  className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                    market === m.key
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {market === m.key ? "▸ " : ""}
                  {m.label}
                </button>
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {active
                ? `${active.label} · base rate ${pct(active.base)} · backtest AUC ${active.auc.toFixed(3)}`
                : "One row per player, at their biggest edge over an average starter"}
            </div>
            <button
              type="button"
              onClick={() => setStrongOnly((v) => !v)}
              aria-pressed={strongOnly}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                strongOnly
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {strongOnly ? "▸ " : ""}Strong only ({strongCount})
            </button>
          </div>
        </div>
      )}

      {!isLoading && !isError && games.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <GameCard key={g.gameId} game={g} market={market} />
          ))}
        </div>
      )}

      {!isLoading && !isError && games.length === 0 && !data?.note && (
        <div className="border border-border bg-card p-10 text-center">
          <div className="font-display text-3xl">No props to project</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Pick an MLB game day. Props need a slate, a posted or projected lineup, and enough
            season-to-date history for the model to read.
          </p>
        </div>
      )}
    </SportShell>
  );
}
