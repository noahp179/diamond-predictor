import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { SportShell, StatBar, Stat, Note } from "@/components/SportShell";
import { boardPicks } from "@/lib/props-board";
import { getNflProps } from "@/lib/sports.functions";
import { todayET } from "@/lib/date";

type Result = Awaited<ReturnType<typeof getNflProps>>;
type Game = Result["games"][number];
type Pick = Game["picks"][number];

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "Sun Sep 20" — enough to tell the reader which day they are looking at. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;

/**
 * Tier styling. The tiers and their hit rates come from the model file — each
 * market's breakpoints were cut on the held-out 2025 season, where the hit rate
 * actually separates, rather than at round numbers.
 * See research/nfl-props/train.py and NFL-PROPS-BACKTEST.md.
 */
const TIER_CLS: Record<string, string> = {
  Strong: "text-primary border-primary/50",
  Solid: "text-foreground border-border",
  Lean: "text-muted-foreground border-border",
};

function PickRow({ pick, showMarket }: { pick: Pick; showMarket: boolean }) {
  const cls = TIER_CLS[pick.tier ?? "Lean"] ?? TIER_CLS.Lean;
  return (
    <div className="flex items-start gap-3 border-t border-border py-3 first:border-t-0">
      <span className="w-5 shrink-0 pt-1 font-mono text-[11px] text-primary/70">
        {pick.kind === "qb" ? "QB" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-lg leading-tight">{pick.player}</span>
          {pick.questionable && (
            <span
              className="shrink-0 border border-clay/60 px-1 font-mono text-[9px] uppercase tracking-widest text-clay"
              title={pick.cautions.join(" ")}
            >
              Q
            </span>
          )}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {pick.team} vs {pick.opponent}
          {showMarket ? ` · ${pick.label}` : ""}
        </div>
        {/* Read back out of this market's own coefficients, so it cannot drift
            from the percentage beside it — it is that percentage, in words. */}
        {pick.reasons.length > 0 && (
          <div className="mt-1 text-sm leading-snug text-muted-foreground">
            {pick.reasons.join(" · ")}
          </div>
        )}
        {pick.against && (
          <div className="mt-0.5 font-mono text-[11px] text-clay">against: {pick.against}</div>
        )}
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
            ? `${pick.tier}: picks in this tier hit ${pct(pick.tierHitRate)} of the time on the held-out 2025 season.`
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
  if (game.picks.length === 0) return null;
  return (
    <div className="border border-border bg-card p-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="font-mono text-sm uppercase tracking-widest text-foreground">
          {game.matchup}
        </div>
        <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {game.total != null ? `O/U ${game.total}` : "No line"}
        </div>
      </div>
      {/* Who the injury report took off this card, named rather than silently
          dropped — a missing star is the most useful thing on the page. */}
      {game.ruledOut.length > 0 && (
        <div
          className="mb-1 font-mono text-[10px] uppercase tracking-widest text-clay"
          title={game.ruledOut.map((r) => `${r.name} (${r.team}) — ${r.status}`).join("\n")}
        >
          Out: {game.ruledOut.map((r) => r.name).join(", ")}
        </div>
      )}
      {game.carryover && (
        <div
          className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
          title="Too few games this season to fill the window, so it reaches back into last season."
        >
          Form window reaches last season
        </div>
      )}
      <div>
        {game.picks.map((p) => (
          <PickRow key={`${p.playerId}-${p.market}`} pick={p} showMarket={market === "all"} />
        ))}
      </div>
    </div>
  );
}

export function NflPropsView() {
  const [date, setDate] = useState(todayET());
  const [market, setMarket] = useState("all");
  const [strongOnly, setStrongOnly] = useState(false);
  const run = useServerFn(getNflProps);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["nfl", "props", date],
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
  const strongCount = (data?.games ?? []).flatMap((g) => boardPicks(g.picks, market, true)).length;
  const ruledOut = (data?.games ?? []).reduce((n, g) => n + g.ruledOut.length, 0);
  const active = markets.find((m) => m.key === market);

  return (
    <SportShell
      sport="nfl"
      current="props"
      eyebrow="Diamond Edge · NFL Player Props"
      title="Player Props"
      blurb="Fourteen prop markets — receptions (3+/5+/7+), receiving yards (40+/60+/80+), rushing yards (40+/60+/80+), scrimmage yards (60+/90+), and for quarterbacks passing yards (225+/275+) and 2+ passing touchdowns. Each is its own logistic model over a trailing form window, team pace, the opposing defence and the market's line, fit on 2021-24 and tested on 2025. Top picks shows one row per player, at the rung with the biggest edge, so one back doesn't fill a card at 40+, 60+ and 80+ yards; pick a market to see every player at that exact number. Anyone the injury report has ruled out is removed rather than priced down. Touchdowns live on the TD Scorers tab, which prices them with its own model."
      date={date}
      onDateChange={setDate}
      footerNote="Data · ESPN box scores and injury report · logistic prop models (fit 2021-24, tested 2025)"
      statBar={
        <StatBar>
          <Stat label="Games" value={`${games.length}`} />
          <Stat label="Picks" value={`${shown.length}`} />
          <Stat label="Strong picks" value={`${strongCount}`} />
          <Stat label="Ruled out" value={`${ruledOut}`} />
        </StatBar>
      }
    >
      {isLoading && <div className="h-56 animate-pulse border border-border bg-card" />}
      {isError && (
        <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
          Failed to load NFL props. The ESPN feeds may be unreachable.
        </div>
      )}
      {!isLoading && !isError && data?.note && <Note>{data.note}</Note>}

      {/* Moving the reader to a day football is played is only acceptable if
          the page says so. */}
      {!isLoading && !isError && data?.date && data.date !== date && (
        <Note>
          No NFL games on {dayLabel(date)} — showing{" "}
          <span className="text-foreground">{dayLabel(data.date)}</span>, the next slate with a
          card. Pick a date above to override.
        </Note>
      )}

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
                : best
                  ? `Biggest edge · ${best.player} ${best.label} ${pct(best.prob)}`
                  : "One row per player, at their biggest edge over an average qualifying player"}
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
            Pick an NFL game day. Props need a slate and enough recent usage for the model to read —
            a player needs two games in his team's last eight.
          </p>
        </div>
      )}
    </SportShell>
  );
}
