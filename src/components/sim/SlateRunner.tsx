import { useRef, useState } from "react";

import type { MassResult } from "@/lib/sim/aggregate";
import type { SlateEntry } from "@/lib/sim/build.server";
import type { SimLeague, SimMatchup } from "@/lib/sim/types";

import { MAX_BATCH, noVigHome, pct, spreadText } from "./format";
import type { useSimWorker } from "./useSimWorker";

/** Games per matchup when running a whole date, up to the single-game cap. */
const SLATE_SIZES = [100, 1000, 5000, 10000, 50000, 100000, MAX_BATCH];
/** Rough throughput across a four-core laptop's workers, for the time hint. */
const GAMES_PER_SECOND: Record<SimLeague, number> = {
  nfl: 6000,
  cfb: 5500,
  nba: 7000,
  nhl: 4000,
  mlb: 4500,
};

/**
 * Every game on the date, simulated in turn. One table answers "what does the
 * simulator think of tonight?" — winners, scores, and where it parts company
 * with the posted lines — and each row opens the full game.
 */

const HEADLINE: Record<SimLeague, { key: string; label: string }> = {
  nba: { key: "pts", label: "pts" },
  nhl: { key: "pts", label: "pts" },
  mlb: { key: "tb", label: "TB" },
  nfl: { key: "rry", label: "scrim yds" },
  cfb: { key: "rry", label: "scrim yds" },
};

type Row =
  | { state: "waiting" }
  | { state: "running"; done: number; n: number }
  | { state: "error"; message: string }
  | { state: "done"; m: SimMatchup; r: MassResult };

export function SlateRunner({
  league,
  games,
  loadMatchup,
  worker,
  onOpen,
}: {
  league: SimLeague;
  games: SlateEntry[];
  loadMatchup: (g: SlateEntry) => Promise<SimMatchup>;
  worker: ReturnType<typeof useSimWorker>;
  onOpen: (g: SlateEntry) => void;
}) {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [running, setRunning] = useState(false);
  const [n, setN] = useState(1000);
  const stop = useRef(false);
  const current = useRef<number | null>(null);

  const run = async () => {
    stop.current = false;
    setRunning(true);
    setRows(Object.fromEntries(games.map((g) => [g.id, { state: "waiting" } as Row])));
    for (const g of games) {
      if (stop.current) break;
      setRows((r) => ({ ...r, [g.id]: { state: "running", done: 0, n } }));
      try {
        const m = await loadMatchup(g);
        const h = worker.batch(m, { benched: [], activated: [] }, n, (done, total) =>
          setRows((r) => ({ ...r, [g.id]: { state: "running", done, n: total } })),
        );
        current.current = h.id;
        const { result } = await h.promise;
        setRows((r) => ({ ...r, [g.id]: { state: "done", m, r: result } }));
      } catch (err) {
        setRows((r) => ({
          ...r,
          [g.id]: { state: "error", message: err instanceof Error ? err.message : "Failed" },
        }));
      }
    }
    current.current = null;
    setRunning(false);
  };

  const halt = () => {
    stop.current = true;
    if (current.current != null) worker.cancel(current.current);
  };

  const finished = Object.values(rows).filter((r) => r.state === "done").length;
  const head = HEADLINE[league];

  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div>
          <h2 className="font-display text-3xl">Simulate the whole slate</h2>
          <p className="text-xs text-muted-foreground">
            Every game on this date, {n.toLocaleString()} times each, injury report as listed.
            {n * games.length >= 500000 &&
              ` About ${Math.max(1, Math.round((n * games.length) / GAMES_PER_SECOND[league] / 60))} min on a typical laptop — it runs in your browser.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            disabled={running}
            aria-label="Games per matchup"
            className="border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground"
          >
            {SLATE_SIZES.map((v) => (
              <option key={v} value={v}>
                {v.toLocaleString()} each
              </option>
            ))}
          </select>
          {running ? (
            <button
              onClick={halt}
              className="border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!games.length}
              className="border border-primary bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-40"
            >
              ▶ Run {games.length} game{games.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
      {Object.keys(rows).length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-5 py-2 text-left font-normal sm:px-6">Game</th>
                <th className="px-2 py-2 text-right font-normal">Sim pick</th>
                <th className="px-2 py-2 text-right font-normal">Avg score</th>
                <th className="px-2 py-2 text-right font-normal">Market</th>
                <th className="px-2 py-2 text-right font-normal">Spread · sim covers</th>
                <th className="px-2 py-2 text-right font-normal">Total · sim over</th>
                <th className="px-2 py-2 text-left font-normal">Top projection</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {games.map((g) => {
                const row = rows[g.id];
                return (
                  <tr key={g.id} className="border-b border-border/40">
                    <td className="px-5 py-2 text-left text-foreground sm:px-6">
                      {g.away.abbr} @ {g.home.abbr}
                    </td>
                    {!row || row.state === "waiting" ? (
                      <td colSpan={6} className="px-2 py-2 text-muted-foreground">
                        queued
                      </td>
                    ) : row.state === "running" ? (
                      <td colSpan={6} className="px-2 py-2 text-muted-foreground">
                        simulating…{" "}
                        {row.done ? `${Math.round((row.done / row.n) * 100)}%` : "loading rosters"}
                      </td>
                    ) : row.state === "error" ? (
                      <td colSpan={6} className="px-2 py-2 text-destructive-foreground">
                        {row.message}
                      </td>
                    ) : (
                      <ResultCells g={g} m={row.m} r={row.r} head={head} />
                    )}
                    <td className="px-2 py-2 text-right">
                      <button onClick={() => onOpen(g)} className="text-primary hover:underline">
                        Open →
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:px-6">
            {finished}/{games.length} simulated
          </div>
        </div>
      )}
    </section>
  );
}

function ResultCells({
  g,
  m,
  r,
  head,
}: {
  g: SlateEntry;
  m: SimMatchup;
  r: MassResult;
  head: { key: string; label: string };
}) {
  const homeFav = r.homeWins >= r.awayWins;
  const favAbbr = homeFav ? g.home.abbr : g.away.abbr;
  const favP = homeFav ? r.homeWins : r.awayWins;
  const mkt = g.line ? noVigHome(g.line.homeMl, g.line.awayMl) : null;
  const mktFav =
    mkt == null
      ? null
      : mkt >= 0.5
        ? `${g.home.abbr} ${pct(mkt, 0)}`
        : `${g.away.abbr} ${pct(1 - mkt, 0)}`;
  const line = r.line;
  const top = r.players
    .map((p) => ({ p, s: p.props.find((x) => x.key === head.key) }))
    .filter((x) => x.s)
    .sort((a, b) => (b.s?.mean ?? 0) - (a.s?.mean ?? 0))[0];
  void m;
  return (
    <>
      <td className="px-2 py-2 text-right text-foreground">
        {favAbbr} {pct(favP, 0)}
      </td>
      <td className="px-2 py-2 text-right text-foreground/90">
        {r.avgAway.toFixed(1)}–{r.avgHome.toFixed(1)}
      </td>
      <td className="px-2 py-2 text-right text-muted-foreground">{mktFav ?? "—"}</td>
      <td className="px-2 py-2 text-right text-foreground/90">
        {line?.spread != null
          ? `${spreadText(g.home.abbr, line.spread)} · ${g.home.abbr} ${pct(line.homeCover, 0)}`
          : "—"}
      </td>
      <td className="px-2 py-2 text-right text-foreground/90">
        {line?.total != null
          ? `${line.total} · ${pct(line.over, 0)}`
          : (r.avgHome + r.avgAway).toFixed(1)}
      </td>
      <td className="max-w-[14rem] truncate px-2 py-2 text-left text-foreground/90">
        {top?.s ? `${top.p.short} ${top.s.mean.toFixed(1)} ${head.label}` : "—"}
      </td>
    </>
  );
}
