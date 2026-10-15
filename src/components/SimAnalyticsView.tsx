import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useMemo, useState } from "react";

import { CalibrationTable, type CalibrationRow } from "@/components/CalibrationTable";
import { SportShell, Stat, StatBar } from "@/components/SportShell";
import backtest from "@/lib/sim-props-backtest.json";
import { getSimAnalytics } from "@/lib/sim-props.functions";
import type { SimBandRow } from "@/lib/sim-props.server";
import { marketSlug, SIM_BOARDS, type Market, type SimPropsLeague } from "@/lib/sim-props-shared";

/**
 * Props › Analytics — every simulation market on a sport's boards, and how
 * often its numbers have come true at each confidence level.
 *
 * Two records, side by side, never mixed:
 *   - the BACKTEST: last season (football: 2025 and 2026 to date), every
 *     player the simulator priced in every game, scored on games it never saw;
 *   - the LIVE record: the picks the boards wrote down before each game
 *     (each game's three likeliest players per market), settled from the box
 *     score. It starts empty and fills as games finish.
 *
 * "Confidence level" is the board's own percentage, cut into ten-point bands:
 * of the picks it priced at 70-80%, how many came in?
 */

type Band = { lo: number; hi: number; n: number; said: number; hit: number };
type Method = {
  brier: number;
  auc: number;
  top_hit: number | null;
  top_said: number | null;
};
type BtMarket = {
  label: string;
  season: string;
  n: number;
  games: number;
  chosen: string;
  top_unit: string;
  methods: Record<string, Method>;
  calibration: CalibrationRow[];
  bands?: Band[];
  h2h?: {
    n: number;
    model: Method;
    chosen: Method;
    diff: number;
    lo: number;
    hi: number;
  };
};
const BT = backtest as unknown as Record<string, Record<string, BtMarket>>;

const LEAGUE_NAME: Record<SimPropsLeague, string> = {
  nba: "NBA",
  nhl: "NHL",
  nfl: "NFL",
  cfb: "College football",
};
const HIGH_BANDS = [5, 6, 7, 8, 9]; // 50-60% ... 90-100%
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const METHOD: Record<string, string> = {
  sim_cal: "Simulator, calibrated",
  sim: "Simulator, raw",
  avg: "Season average",
  fit: "Fitted model (trees)",
  blend: "Half simulator, half fitted",
  hybrid: "Fitted model + simulator",
  model: "Previous model",
  model_td1: "First-TD model",
  model_share: "Anytime model split by share",
};

type Live = { n: number; hits: number; said: number; voids: number; pending: number };
const empty = (): Live => ({ n: 0, hits: 0, said: 0, voids: 0, pending: 0 });
function add(a: Live, r: SimBandRow) {
  a.n += r.n;
  a.hits += r.hits;
  a.said += r.said;
  a.voids += r.voids;
  a.pending += r.pending;
}

/** Ten-point bands as the calibration table reads them. */
function bandRows(
  bands: { band: number; n: number; said: number; hits: number }[],
): CalibrationRow[] {
  return bands
    .filter((b) => b.n > 0)
    .sort((a, b) => a.band - b.band)
    .map((b) => ({
      band: `${b.band * 10}–${b.band * 10 + 10}%`,
      n: b.n,
      predicted: b.said / b.n,
      actual: b.hits / b.n,
    }));
}

export function SimAnalyticsView({ league }: { league: SimPropsLeague }) {
  const load = useServerFn(getSimAnalytics);
  const { data, isLoading } = useQuery({
    queryKey: ["sim-analytics", league],
    queryFn: () => load({ data: { league } }),
    staleTime: 5 * 60_000,
  });
  const [board, setBoard] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<"backtest" | "live">("backtest");

  const boards = SIM_BOARDS[league];
  const markets = useMemo(
    () => boards.flatMap((b) => b.markets.map((m) => ({ m, board: b }))),
    [boards],
  );
  const bt = useMemo(() => BT[league] ?? {}, [league]);

  // Live: per market (and per market x band), from the view's rows.
  const live = useMemo(() => {
    const byMarket = new Map<string, Live>();
    const byBand = new Map<string, Map<number, Live>>();
    const all = new Map<number, Live>();
    for (const r of data?.rows ?? []) {
      const m = byMarket.get(r.market) ?? empty();
      add(m, r);
      byMarket.set(r.market, m);
      const bands = byBand.get(r.market) ?? new Map<number, Live>();
      const b = bands.get(r.band) ?? empty();
      add(b, r);
      bands.set(r.band, b);
      byBand.set(r.market, bands);
      const a = all.get(r.band) ?? empty();
      add(a, r);
      all.set(r.band, a);
    }
    return { byMarket, byBand, all };
  }, [data]);

  const liveTotal = [...live.byMarket.values()].reduce(
    (s, m) => ({
      n: s.n + m.n,
      hits: s.hits + m.hits,
      said: s.said + m.said,
      pending: s.pending + m.pending,
    }),
    { n: 0, hits: 0, said: 0, pending: 0 },
  );
  const firstDate = (data?.rows ?? [])
    .map((r) => r.first_date)
    .filter(Boolean)
    .sort()[0];

  // Backtest, every market pooled, per band.
  const btPooled = useMemo(() => {
    const acc = new Map<number, { n: number; said: number; hits: number }>();
    for (const { m } of markets) {
      for (const b of bt[m.key]?.bands ?? []) {
        const k = Math.round(b.lo * 10);
        const a = acc.get(k) ?? { n: 0, said: 0, hits: 0 };
        a.n += b.n;
        a.said += b.said * b.n;
        a.hits += b.hit * b.n;
        acc.set(k, a);
      }
    }
    return [...acc.entries()].map(([band, v]) => ({ band, ...v }));
  }, [markets, bt]);
  const btPlayers = markets.reduce((s, { m }) => s + (bt[m.key]?.n ?? 0), 0);

  const shown = markets.filter(({ board: b }) => board === "all" || b.key === board);

  return (
    <SportShell
      sport={league}
      current="props"
      eyebrow={`Diamond Edge · ${LEAGUE_NAME[league]} props analytics`}
      title="How every prop market has done"
      blurb="Every market on the Props boards, and how often its numbers came true at each confidence level — first on last season's games, which the simulator never saw, then on the live picks as they settle. A board that says 70% should be right about 7 times in 10."
      statBar={
        <StatBar>
          <Stat label="Markets" value={`${markets.length}`} />
          <Stat label="Backtest player-games" value={btPlayers.toLocaleString()} />
          <Stat label="Live picks settled" value={liveTotal.n.toLocaleString()} />
          <Stat
            label="Live: came in (said)"
            value={
              liveTotal.n
                ? `${pct(liveTotal.hits / liveTotal.n)} (${pct(liveTotal.said / liveTotal.n)})`
                : "—"
            }
          />
        </StatBar>
      }
    >
      <section className="border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <div>
            <h2 className="font-display text-2xl">At each confidence level</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Every market pooled. Read a row as a sentence: of the picks priced at 70–80%, how many
              came in?
            </p>
          </div>
          <div className="flex gap-2" role="tablist" aria-label="Record">
            {(["backtest", "live"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${
                  view === v
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {v === "backtest" ? "Last season (backtest)" : "Live picks"}
              </button>
            ))}
          </div>
        </div>
        <div className="px-5 py-5 sm:px-6">
          {view === "backtest" ? (
            btPooled.length ? (
              <CalibrationTable rows={bandRows(btPooled)} unit="player-games" verb="did it" />
            ) : (
              <p className="text-sm text-muted-foreground">No backtest for these markets yet.</p>
            )
          ) : isLoading ? (
            <div className="h-40 animate-pulse bg-secondary/40" />
          ) : liveTotal.n ? (
            <CalibrationTable
              rows={bandRows([...live.all.entries()].map(([band, v]) => ({ band, ...v })))}
              unit="picks"
              verb="came in"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {data?.note ?? "No picks have settled yet."}{" "}
              {liveTotal.pending
                ? `${liveTotal.pending.toLocaleString()} picks are waiting on their games${firstDate ? `, the first from ${firstDate}` : ""}.`
                : "Each game's three likeliest players in every market are written down the morning of the game and graded from the box score the next morning."}
            </p>
          )}
        </div>
      </section>

      <section className="mt-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="font-display text-2xl">Market by market</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The backtest columns are every player the simulator priced in that market; the
            percentages are how often the ones it put in each band actually did it. A dash means
            fewer than 30 player-games landed there — too few to say. Tap a market for its full
            table and how the simulator compared with the other methods.
          </p>
          <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Board">
            {[{ key: "all", label: "All" }, ...boards].map((b) => (
              <button
                key={b.key}
                type="button"
                role="tab"
                aria-selected={board === b.key}
                onClick={() => setBoard(b.key)}
                className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${
                  board === b.key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                <th className="px-5 py-2 font-normal sm:px-6">Market</th>
                <th className="py-2 pr-3 text-right font-normal">Top picks came in</th>
                {HIGH_BANDS.map((b) => (
                  <th key={b} className="py-2 pr-3 text-right font-normal">
                    Said {b * 10}
                    {b === 9 ? "+" : `–${b * 10 + 10}`}%
                  </th>
                ))}
                <th className="py-2 pr-5 text-right font-normal sm:pr-6">Live: came in (said)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ m, board: b }) => (
                <MarketRow
                  key={m.key}
                  league={league}
                  market={m}
                  boardLabel={b.label}
                  bt={bt[m.key]}
                  live={live.byMarket.get(marketSlug(league, m.key))}
                  liveBands={live.byBand.get(marketSlug(league, m.key))}
                  open={open === m.key}
                  onToggle={() => setOpen(open === m.key ? null : m.key)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </SportShell>
  );
}

function MarketRow({
  league,
  market,
  boardLabel,
  bt,
  live,
  liveBands,
  open,
  onToggle,
}: {
  league: SimPropsLeague;
  market: Market;
  boardLabel: string;
  bt?: BtMarket;
  live?: Live;
  liveBands?: Map<number, Live>;
  open: boolean;
  onToggle: () => void;
}) {
  const chosen = bt ? bt.methods[bt.chosen] : undefined;
  const bands = new Map((bt?.bands ?? []).map((b) => [Math.round(b.lo * 10), b]));
  const methods = bt ? Object.entries(bt.methods).sort((a, b) => a[1].brier - b[1].brier) : [];
  return (
    <Fragment>
      <tr
        className="cursor-pointer border-b border-border/50 hover:bg-secondary/30"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="px-5 py-2.5 sm:px-6">
          <div className="normal-case text-foreground">
            {open ? "▾ " : "▸ "}
            {market.group && !market.label.includes(market.group)
              ? `${market.group} ${market.short}`
              : market.label}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {boardLabel}
          </div>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums">
          {chosen?.top_hit != null ? (
            <>
              {pct(chosen.top_hit)}{" "}
              <span className="text-muted-foreground">({pct(chosen.top_said ?? 0)})</span>
            </>
          ) : (
            "—"
          )}
        </td>
        {HIGH_BANDS.map((k) => {
          const b = bands.get(k);
          return (
            <td key={k} className="py-2.5 pr-3 text-right tabular-nums">
              {b && b.n >= 30 ? (
                <>
                  {pct(b.hit)}
                  <span className="block text-[9px] text-muted-foreground">
                    {b.n.toLocaleString()}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
          );
        })}
        <td className="py-2.5 pr-5 text-right tabular-nums sm:pr-6">
          {live?.n ? (
            <>
              {pct(live.hits / live.n)}{" "}
              <span className="text-muted-foreground">({pct(live.said / live.n)})</span>
              <span className="block text-[9px] text-muted-foreground">{live.n} settled</span>
            </>
          ) : live?.pending ? (
            <span className="text-muted-foreground">{live.pending} pending</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-background/40">
          <td colSpan={8} className="px-5 py-5 sm:px-6">
            <div className="grid gap-8 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 font-display text-lg normal-case">
                  Backtest{bt ? `: ${bt.season}` : ""}
                </h3>
                {bt ? (
                  <>
                    <p className="mb-3 font-sans text-xs normal-case text-muted-foreground">
                      {bt.n.toLocaleString()} player-games across {bt.games.toLocaleString()} games.{" "}
                      {bt.top_unit}: {pct(chosen?.top_hit ?? 0, 1)} (it said{" "}
                      {pct(chosen?.top_said ?? 0, 1)}).
                    </p>
                    <CalibrationTable
                      rows={
                        bt.bands?.length
                          ? bandRows(
                              bt.bands.map((b) => ({
                                band: Math.round(b.lo * 10),
                                n: b.n,
                                said: b.said * b.n,
                                hits: b.hit * b.n,
                              })),
                            )
                          : bt.calibration
                      }
                      unit="player-games"
                      verb="did it"
                    />
                    <table className="mt-4 w-full border-collapse">
                      <thead>
                        <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                          <th className="py-1.5 pr-3 font-normal">Method</th>
                          <th className="py-1.5 pr-3 text-right font-normal">Error score</th>
                          <th className="py-1.5 text-right font-normal">Ranking (AUC)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {methods.map(([k, v]) => (
                          <tr
                            key={k}
                            className={`border-b border-border/40 ${k === bt.chosen ? "text-foreground" : "text-muted-foreground"}`}
                          >
                            <td className="py-1.5 pr-3 normal-case">
                              {k === bt.chosen ? "▸ " : ""}
                              {METHOD[k] ?? k}
                              {k === bt.chosen ? " (on the board)" : ""}
                            </td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              {v.brier.toFixed(4)}
                            </td>
                            <td className="py-1.5 text-right tabular-nums">{v.auc.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bt.h2h && (
                      <p className="mt-3 font-sans text-xs normal-case text-muted-foreground">
                        Against the site's logistic prop model on the {bt.h2h.n.toLocaleString()}{" "}
                        player-games both priced: error score {bt.h2h.chosen.brier.toFixed(4)} vs{" "}
                        {bt.h2h.model.brier.toFixed(4)} (difference {bt.h2h.diff >= 0 ? "+" : ""}
                        {bt.h2h.diff.toFixed(4)}, 95% range {bt.h2h.lo.toFixed(4)} to{" "}
                        {bt.h2h.hi.toFixed(4)} —{" "}
                        {bt.h2h.hi < 0
                          ? "the simulator is better"
                          : bt.h2h.lo > 0
                            ? "the model is better"
                            : "too close to call"}
                        ).
                      </p>
                    )}
                  </>
                ) : (
                  <p className="font-sans text-xs normal-case text-muted-foreground">
                    No backtest for this market.
                  </p>
                )}
              </div>
              <div>
                <h3 className="mb-1 font-display text-lg normal-case">Live picks</h3>
                {live?.n && liveBands ? (
                  <>
                    <p className="mb-3 font-sans text-xs normal-case text-muted-foreground">
                      {live.n} settled, {live.voids} void (did not play), {live.pending} pending.
                      Came in {pct(live.hits / live.n, 1)}; the board said{" "}
                      {pct(live.said / live.n, 1)}.
                    </p>
                    <CalibrationTable
                      rows={bandRows([...liveBands.entries()].map(([band, v]) => ({ band, ...v })))}
                      unit="picks"
                      verb="came in"
                    />
                  </>
                ) : (
                  <p className="font-sans text-xs normal-case text-muted-foreground">
                    {live?.pending
                      ? `${live.pending} picks waiting on their games.`
                      : `None yet. The ${LEAGUE_NAME[league]} picks are written down the morning of each game.`}
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
