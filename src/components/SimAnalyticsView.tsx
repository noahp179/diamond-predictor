import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useMemo, useState } from "react";

import { CalibrationTable, type CalibrationRow } from "@/components/CalibrationTable";
import { GameResults } from "@/components/GameResults";
import { SportShell, Stat, StatBar } from "@/components/SportShell";
import backtest from "@/lib/sim-props-backtest.json";
import seasonJson from "@/lib/sim-props-season.json";
import { getSimAnalytics } from "@/lib/sim-props.functions";
import type { SeasonLedgerRow, SimBandRow } from "@/lib/sim-props.server";
import { marketSlug, SIM_BOARDS, type Market, type SimPropsLeague } from "@/lib/sim-props-shared";

/**
 * Props › Analytics — how the picks the boards actually recorded have done.
 *
 * The page is the record, and only the record: picks written down before
 * their games and graded from the box score — the simulation boards' (each
 * game's three likeliest players per market) and the boards that came before
 * them this season. Game by game, each finished game shows the box score next
 * to what the board said (GameResults), so any pick can be checked by hand.
 *
 * What was measured before tracking began — this season replayed
 * (research/player-props/season_to_date.py) and last season's backtest — is
 * kept at the bottom, folded away and labelled as not part of the record.
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

type Tally = { n: number; hits: number; said: number };
type SeasonMarket = {
  label: string;
  slug: string;
  picks: Tally & { voids: number };
  pick_bands: Band[];
  all: Tally;
  all_bands: Band[];
};
type SeasonLeague = {
  season: string;
  games: number;
  from?: string | null;
  to?: string | null;
  note?: string;
  markets: Record<string, SeasonMarket>;
};
const SEASON = seasonJson as unknown as Record<string, SeasonLeague | string> as Record<
  string,
  SeasonLeague
>;

/** Fixed bands (lo, n, said, hit) as rows of hits and price. */
const fromBands = (bands: Band[]) =>
  bands.map((b) => ({
    band: Math.round(b.lo * 10),
    n: b.n,
    said: b.said * b.n,
    hits: b.hit * b.n,
  }));

const day = (iso?: string | null) =>
  iso
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";

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
  const [view, setView] = useState<"season" | "backtest">("season");

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

  // Every player the board priced, graded at every line (game_results.priced).
  const priced = useMemo(() => {
    const byMarket = new Map<string, Tally>();
    const byBand = new Map<string, Map<number, Tally>>();
    const all = new Map<number, Tally>();
    const bump = (t: Tally | undefined, r: Tally): Tally => ({
      n: (t?.n ?? 0) + r.n,
      hits: (t?.hits ?? 0) + r.hits,
      said: (t?.said ?? 0) + r.said,
    });
    for (const r of data?.priced ?? []) {
      byMarket.set(r.market, bump(byMarket.get(r.market), r));
      const bands = byBand.get(r.market) ?? new Map<number, Tally>();
      bands.set(r.band, bump(bands.get(r.band), r));
      byBand.set(r.market, bands);
      all.set(r.band, bump(all.get(r.band), r));
    }
    const total = [...byMarket.values()].reduce((t, m) => bump(t, m), { n: 0, hits: 0, said: 0 });
    return { byMarket, byBand, all, total };
  }, [data]);
  const [scope, setScope] = useState<"priced" | "picks">("priced");

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

  // This season, replayed: every market's picks pooled, per band.
  const season = SEASON[league];
  const seasonPooled = useMemo(() => {
    const acc = new Map<number, { n: number; said: number; hits: number }>();
    const tot = { n: 0, hits: 0, said: 0 };
    for (const sm of Object.values(season?.markets ?? {})) {
      tot.n += sm.picks.n;
      tot.hits += sm.picks.hits;
      tot.said += sm.picks.said;
      for (const b of fromBands(sm.pick_bands)) {
        const a = acc.get(b.band) ?? { n: 0, said: 0, hits: 0 };
        a.n += b.n;
        a.said += b.said;
        a.hits += b.hits;
        acc.set(b.band, a);
      }
    }
    return { bands: [...acc.entries()].map(([band, v]) => ({ band, ...v })), tot };
  }, [season]);
  const recorded: SeasonLedgerRow[] = data?.season ?? [];

  const shown = markets.filter(({ board: b }) => board === "all" || b.key === board);

  // Everything recorded this season, every board pooled: the simulation
  // picks and the boards that came before them.
  const earlier = recorded.reduce(
    (t, r) => ({
      n: t.n + r.n,
      hits: t.hits + r.hits,
      said: t.said + r.said,
      pending: t.pending + r.pending,
    }),
    { n: 0, hits: 0, said: 0, pending: 0 },
  );
  const tracked = {
    n: liveTotal.n + earlier.n,
    hits: liveTotal.hits + earlier.hits,
    said: liveTotal.said + earlier.said,
    pending: liveTotal.pending + earlier.pending,
  };

  return (
    <SportShell
      sport={league}
      current="props"
      eyebrow={`Diamond Edge · ${LEAGUE_NAME[league]} props analytics`}
      title="How the recorded picks have done"
      blurb="Only picks written down before their games and graded from the box score afterwards — nothing replayed, nothing from last season. Game by game, each finished game shows what the board said next to what happened, with a link to the box score to check it yourself."
      statBar={
        <StatBar>
          <Stat label="Picks graded" value={tracked.n.toLocaleString()} />
          <Stat
            label="Came in (board said)"
            value={
              tracked.n
                ? `${pct(tracked.hits / tracked.n)} (${pct(tracked.said / tracked.n)})`
                : "—"
            }
          />
          <Stat label="Waiting on games" value={tracked.pending.toLocaleString()} />
          <Stat label="Player-lines graded" value={priced.total.n.toLocaleString()} />
        </StatBar>
      }
    >
      <section className="border border-border bg-card">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="font-display text-2xl">How the board&apos;s numbers held up</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every market pooled. &ldquo;Every player priced&rdquo; grades each player the board put
            a number on, at every line, from the simulation stored before the game against the box
            score. &ldquo;Top three picks&rdquo; is each game&apos;s three likeliest players per
            market, the picks written down that morning. Read a row as a sentence: of the players
            priced at 70–80%, how many did it?
          </p>
          <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Which players">
            {(
              [
                ["priced", "Every player priced"],
                ["picks", "Top three picks"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={scope === k}
                onClick={() => setScope(k)}
                className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${
                  scope === k
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="px-5 py-5 sm:px-6">
          {isLoading ? (
            <div className="h-40 animate-pulse bg-secondary/40" />
          ) : scope === "priced" ? (
            priced.total.n ? (
              <>
                <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
                  {priced.total.n.toLocaleString()} player-lines graded: did it{" "}
                  {pct(priced.total.hits / priced.total.n, 1)} of the time; the board said{" "}
                  {pct(priced.total.said / priced.total.n, 1)}.
                </p>
                <CalibrationTable
                  rows={bandRows([...priced.all.entries()].map(([band, v]) => ({ band, ...v })))}
                  unit="player-lines"
                  verb="did it"
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing graded yet — each simulated game&apos;s players are graded at every line the
                morning after it finishes.
              </p>
            )
          ) : liveTotal.n ? (
            <CalibrationTable
              rows={bandRows([...live.all.entries()].map(([band, v]) => ({ band, ...v })))}
              unit="picks"
              verb="came in"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {data?.note ?? "No picks have been graded yet."}{" "}
              {liveTotal.pending
                ? `${liveTotal.pending.toLocaleString()} picks are waiting on their games${firstDate ? `, the first from ${day(firstDate)}` : ""}; they are graded the morning after.`
                : "Each game's three likeliest players in every market are written down the morning of the game and graded from the box score the next morning."}
            </p>
          )}
        </div>
        <div className="border-t border-border px-5 py-5 sm:px-6">
          <EarlierBoards league={league} recorded={recorded} loading={isLoading} />
        </div>
      </section>

      <section className="mt-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="font-display text-2xl">Game by game</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every tracked game that has finished, newest first. Open one to see who actually{" "}
            {league === "nba"
              ? "led the scoring"
              : league === "nhl"
                ? "scored"
                : "scored a touchdown"}{" "}
            and what chance the board gave each of them before the game, then every recorded pick
            with its real number. The box score link is there to check any of it.
          </p>
        </div>
        <GameResults league={league} />
      </section>

      <section className="mt-8 border border-border bg-card">
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <h2 className="font-display text-2xl">Line by line</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every line on the boards — 40+, 50+, 60+, 75+ receiving yards and so on — graded on
            every player the board priced: how often they did it against what the board said, and
            how the ones it priced in each band did. The last columns are the top three picks alone.
            Small samples read as counts (&ldquo;3 of 4&rdquo;) — a line needs dozens of players
            before its percentages mean much. Tap a line for its tables.
          </p>
          <BoardTabs boards={boards} board={board} setBoard={setBoard} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                <th className="px-5 py-2 font-normal sm:px-6">Line</th>
                <th className="py-2 pr-3 text-right font-normal">Players priced</th>
                <th className="py-2 pr-3 text-right font-normal">Did it (said)</th>
                {HIGH_BANDS.map((b) => (
                  <th key={b} className="py-2 pr-3 text-right font-normal">
                    Said {b * 10}
                    {b === 9 ? "+" : `–${b * 10 + 10}`}%
                  </th>
                ))}
                <th className="py-2 pr-3 text-right font-normal">Top picks: came in (said)</th>
                <th className="py-2 pr-5 text-right font-normal sm:pr-6">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ m, board: b }) => (
                <TrackedRow
                  key={m.key}
                  market={m}
                  boardLabel={b.label}
                  live={live.byMarket.get(marketSlug(league, m.key))}
                  liveBands={live.byBand.get(marketSlug(league, m.key))}
                  priced={priced.byMarket.get(marketSlug(league, m.key))}
                  pricedBands={priced.byBand.get(marketSlug(league, m.key))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="group mt-8 border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 sm:px-6">
          <span>
            <span className="font-display text-2xl">Before tracking started</span>
            <span className="mt-1 block max-w-3xl text-sm text-muted-foreground">
              Not part of the record: how the method was chosen — this season replayed, and last
              season&apos;s backtest. Nothing here was written down before a game.
            </span>
          </span>
          <span className="font-mono text-xs text-muted-foreground group-open:rotate-180">▼</span>
        </summary>
        <div className="border-t border-border px-5 py-5 sm:px-6">
          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Before tracking">
            {(["season", "backtest"] as const).map((v) => (
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
                {v === "season" ? "This season, replayed" : "Last season (backtest)"}
              </button>
            ))}
          </div>
          {view === "season" ? (
            <Replay league={league} season={season} pooled={seasonPooled} />
          ) : btPooled.length ? (
            <>
              <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
                Last season, every player the simulator priced in every market (
                {btPlayers.toLocaleString()} player-games), scored on games it never saw.
              </p>
              <CalibrationTable rows={bandRows(btPooled)} unit="player-games" verb="did it" />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No backtest for these markets.</p>
          )}
        </div>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[860px] border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
                <th className="px-5 py-2 font-normal sm:px-6">Market</th>
                <th className="py-2 pr-3 text-right font-normal">Replayed: picks came in</th>
                <th className="py-2 pr-3 text-right font-normal">Last season: top picks</th>
                {HIGH_BANDS.map((b) => (
                  <th key={b} className="py-2 pr-3 text-right font-normal last:pr-5 sm:last:pr-6">
                    Said {b * 10}
                    {b === 9 ? "+" : `–${b * 10 + 10}`}%
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ m, board: b }) => (
                <MarketRow
                  key={m.key}
                  market={m}
                  boardLabel={b.label}
                  bt={bt[m.key]}
                  sm={season?.markets[m.key]}
                  open={open === m.key}
                  onToggle={() => setOpen(open === m.key ? null : m.key)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SportShell>
  );
}

function BoardTabs({
  boards,
  board,
  setBoard,
}: {
  boards: { key: string; label: string }[];
  board: string;
  setBoard: (b: string) => void;
}) {
  return (
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
  );
}

/** "62%" once a band has enough picks to mean something, "3 of 4" before. */
function share(hits: number, n: number) {
  return n >= 20 ? pct(hits / n) : `${hits} of ${n}`;
}

function TrackedRow({
  market,
  boardLabel,
  live,
  liveBands,
  priced,
  pricedBands,
}: {
  market: Market;
  boardLabel: string;
  live?: Live;
  liveBands?: Map<number, Live>;
  priced?: Tally;
  pricedBands?: Map<number, Tally>;
}) {
  const [open, setOpen] = useState(false);
  const any = !!(live?.n || priced?.n);
  return (
    <Fragment>
      <tr
        className={`border-b border-border/50 ${any ? "cursor-pointer hover:bg-secondary/30" : ""}`}
        onClick={() => any && setOpen(!open)}
        aria-expanded={any ? open : undefined}
      >
        <td className="px-5 py-2.5 sm:px-6">
          <div className="normal-case text-foreground">
            {any ? (open ? "▾ " : "▸ ") : ""}
            {market.group && !market.label.includes(market.group)
              ? `${market.group} ${market.short}`
              : market.label}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {boardLabel}
          </div>
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums">
          {priced?.n ? priced.n.toLocaleString() : "—"}
        </td>
        <td className="py-2.5 pr-3 text-right tabular-nums">
          {priced?.n ? (
            <>
              {share(priced.hits, priced.n)}{" "}
              <span className="text-muted-foreground">({pct(priced.said / priced.n)})</span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        {HIGH_BANDS.map((k) => {
          const b = pricedBands?.get(k);
          return (
            <td key={k} className="py-2.5 pr-3 text-right tabular-nums">
              {b?.n ? share(b.hits, b.n) : <span className="text-muted-foreground">—</span>}
            </td>
          );
        })}
        <td className="py-2.5 pr-3 text-right tabular-nums">
          {live?.n ? (
            <>
              {share(live.hits, live.n)}{" "}
              <span className="text-muted-foreground">({pct(live.said / live.n)})</span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-2.5 pr-5 text-right tabular-nums text-muted-foreground sm:pr-6">
          {live?.pending || "—"}
        </td>
      </tr>
      {open && any ? (
        <tr className="border-b border-border/50 bg-background/40">
          <td colSpan={10} className="px-5 py-5 sm:px-6">
            <div className="grid gap-8 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 font-display text-lg normal-case">Every player priced</h3>
                {priced?.n && pricedBands ? (
                  <>
                    <p className="mb-3 font-sans text-xs normal-case text-muted-foreground">
                      {priced.n} players priced, {priced.hits} did it (
                      {pct(priced.hits / priced.n, 1)}
                      ); the board said {pct(priced.said / priced.n, 1)}.
                    </p>
                    <CalibrationTable
                      rows={bandRows(
                        [...pricedBands.entries()].map(([band, v]) => ({ band, ...v })),
                      )}
                      unit="players"
                      verb="did it"
                    />
                  </>
                ) : (
                  <p className="font-sans text-xs normal-case text-muted-foreground">
                    Nothing graded yet.
                  </p>
                )}
              </div>
              <div>
                <h3 className="mb-1 font-display text-lg normal-case">Top three picks</h3>
                {live?.n && liveBands ? (
                  <>
                    <p className="mb-3 font-sans text-xs normal-case text-muted-foreground">
                      {live.n} graded, {live.voids} void (did not play), {live.pending} waiting.
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
                    {live?.pending ? `${live.pending} picks waiting on their games.` : "None yet."}
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/** A market's numbers from before tracking began: the replay and the backtest. */
function MarketRow({
  market,
  boardLabel,
  bt,
  sm,
  open,
  onToggle,
}: {
  market: Market;
  boardLabel: string;
  bt?: BtMarket;
  sm?: SeasonMarket;
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
          {sm?.picks.n ? (
            <>
              {pct(sm.picks.hits / sm.picks.n)}{" "}
              <span className="text-muted-foreground">({pct(sm.picks.said / sm.picks.n)})</span>
              <span className="block text-[9px] text-muted-foreground">{sm.picks.n} picks</span>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
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
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-background/40">
          <td colSpan={8} className="px-5 py-5 sm:px-6">
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <h3 className="mb-1 font-display text-lg normal-case">This season, replayed</h3>
                {sm?.picks.n ? (
                  <>
                    <p className="mb-3 font-sans text-xs normal-case text-muted-foreground">
                      Each game&apos;s three likeliest players, as the board would have priced them
                      that morning: {sm.picks.n} picks, {sm.picks.hits} came in (
                      {pct(sm.picks.hits / sm.picks.n, 1)}); the board said{" "}
                      {pct(sm.picks.said / sm.picks.n, 1)}.
                      {sm.picks.voids ? ` ${sm.picks.voids} void (did not play).` : ""} Every player
                      it priced: {sm.all.n.toLocaleString()}, {pct(sm.all.hits / sm.all.n, 1)} did
                      it against {pct(sm.all.said / sm.all.n, 1)} said.
                    </p>
                    <CalibrationTable
                      rows={bandRows(fromBands(sm.pick_bands))}
                      unit="picks"
                      verb="came in"
                    />
                  </>
                ) : (
                  <p className="font-sans text-xs normal-case text-muted-foreground">
                    Nothing of this season to replay for this market yet.
                  </p>
                )}
              </div>
              <div className="lg:col-span-2">
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
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Replay({
  league,
  season,
  pooled,
}: {
  league: SimPropsLeague;
  season?: SeasonLeague;
  pooled: {
    bands: { band: number; n: number; said: number; hits: number }[];
    tot: { n: number; hits: number; said: number };
  };
}) {
  const t = pooled.tot;
  return season && season.games > 0 && t.n > 0 ? (
    <div className="text-sm text-muted-foreground">
      <p className="max-w-3xl">
        <strong className="text-foreground">
          {season.games} {LEAGUE_NAME[league]} games this season
        </strong>{" "}
        ({day(season.from)} – {day(season.to)}) played before tracking began, replayed as the boards
        would have called them each morning: the simulator fed only what was known before each game,
        calibration learned from earlier seasons only, each game&apos;s three likeliest players per
        market taken as the picks. {t.n.toLocaleString()} picks came in {pct(t.hits / t.n, 1)} of
        the time against {pct(t.said / t.n, 1)} said.
      </p>
      <div className="mt-4">
        <CalibrationTable rows={bandRows(pooled.bands)} unit="picks" verb="came in" />
      </div>
    </div>
  ) : (
    <p className="max-w-3xl text-sm text-muted-foreground">
      {season?.note ?? `No ${LEAGUE_NAME[league]} games of this season to replay.`}
    </p>
  );
}

/** The boards that came before the simulations, and what they recorded this season. */
function EarlierBoards({
  league,
  recorded,
  loading,
}: {
  league: SimPropsLeague;
  recorded: SeasonLedgerRow[];
  loading: boolean;
}) {
  const big = recorded.find((r) => r.n >= 30);
  return (
    <div className="text-sm text-muted-foreground">
      <h3 className="font-display text-xl text-foreground">The earlier boards&apos; picks</h3>
      <p className="mt-1 max-w-3xl">
        What the {LEAGUE_NAME[league]} boards before the simulations wrote down before each game
        this season, graded the same way. A player who did not play is a void, not a miss.
      </p>
      {loading ? (
        <div className="mt-3 h-20 animate-pulse bg-secondary/40" />
      ) : recorded.length ? (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-widest">
                  <th className="py-2 pr-3 font-normal">Board</th>
                  <th className="py-2 pr-3 font-normal">Bet</th>
                  <th className="py-2 pr-3 font-normal">Since</th>
                  <th className="py-2 pr-3 text-right font-normal">Graded</th>
                  <th className="py-2 pr-3 text-right font-normal">Came in</th>
                  <th className="py-2 pr-3 text-right font-normal">Said</th>
                  <th className="py-2 pr-3 text-right font-normal">Void</th>
                  <th className="py-2 text-right font-normal">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {recorded.map((r) => (
                  <tr key={`${r.model}-${r.market}`} className="border-b border-border/50">
                    <td className="py-2 pr-3 normal-case text-foreground">{r.modelName}</td>
                    <td className="py-2 pr-3 normal-case">{r.label}</td>
                    <td className="py-2 pr-3">{day(r.first)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.n}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-foreground">
                      {r.n ? pct(r.hits / r.n, 1) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.n ? pct(r.said / r.n, 1) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.voids || "—"}</td>
                    <td className="py-2 text-right tabular-nums">{r.pending || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {big && (
            <div className="mt-4">
              <p className="mb-2 max-w-3xl text-xs">
                {big.modelName} ({big.label}) at each confidence level:
              </p>
              <CalibrationTable rows={bandRows(big.bands)} unit="picks" verb="came in" />
            </div>
          )}
        </>
      ) : (
        <p className="mt-3 max-w-3xl">
          None this season — the simulation boards are the first {LEAGUE_NAME[league]} prop boards.
        </p>
      )}
    </div>
  );
}
