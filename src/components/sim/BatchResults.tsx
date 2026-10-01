import { useMemo, useState } from "react";

import type { MassResult, PlayerSummary } from "@/lib/sim/aggregate";
import { AVG_BOX, PROPS, UNITS, type PropDef } from "@/lib/sim/props";
import type { SimLeague, SimMatchup } from "@/lib/sim/types";

import {
  AWAY_COLOR,
  fairOdds,
  HOME_COLOR,
  moeMean,
  moeP,
  NEUTRAL_SERIES,
  noVigHome,
  pct,
  signed,
  spreadText,
} from "./format";
import { toBins } from "./bins";
import { BinTable, Histogram, WinBar } from "./SimCharts";

/**
 * What a batch of simulated games says: who wins and how often, where the
 * margin and the total land against the posted line, the scores that come up
 * most, the average box score, and every player's stat distribution next to
 * his season. Every figure carries its Monte Carlo error — the amount it
 * would move if the same batch were run again with new random numbers.
 */
export function BatchResults({
  matchup,
  result,
  partial,
}: {
  matchup: SimMatchup;
  result: MassResult;
  partial: boolean;
}) {
  const u = UNITS[matchup.league];
  const { home, away } = matchup;
  const n = result.n;

  const marginBins = useMemo(
    () =>
      toBins(result.margin, n, (x) =>
        x > 0 ? HOME_COLOR : x < 0 ? AWAY_COLOR : "var(--color-muted-foreground)",
      ),
    [result, n],
  );
  const totalBins = useMemo(() => toBins(result.total, n, () => NEUTRAL_SERIES), [result, n]);

  const meanMargin = result.avgHome - result.avgAway;
  const medianMargin = medianOf(result.margin, n);
  const line = result.line;
  const mkt = matchup.ctx.line;
  const mktHome = mkt ? noVigHome(mkt.homeMl, mkt.awayMl) : null;
  const decided = result.homeWins + result.awayWins;
  const fav = result.homeWins >= result.awayWins ? home : away;
  const favP = Math.max(result.homeWins, result.awayWins);
  const winMoe = moeP(favP, n);

  const winnerOf = (x: number) => (x > 0 ? home.abbr : x < 0 ? away.abbr : null);

  return (
    <div className="space-y-6">
      {partial && (
        <div className="border border-primary/40 bg-primary/10 px-4 py-3 font-mono text-xs text-foreground">
          Stopped early — these numbers come from the {n.toLocaleString()} games finished before the
          stop.
        </div>
      )}

      {/* Headline */}
      <div className="grid gap-px bg-border lg:grid-cols-[3fr_2fr]">
        <div className="bg-card p-5 sm:p-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h3 className="font-display text-3xl">Win probability</h3>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {n.toLocaleString()} games · {(result.ms / 1000).toFixed(1)}s
            </span>
          </div>
          <WinBar
            away={result.awayWins}
            home={result.homeWins}
            tie={result.ties}
            awayLabel={away.name}
            homeLabel={home.name}
            awayColor={AWAY_COLOR}
            homeColor={HOME_COLOR}
          />
          <p className="mt-4 text-sm text-muted-foreground">
            {fav.name} win {pct(favP)} of simulated games{" "}
            <span className="font-mono text-xs">(±{(winMoe * 100).toFixed(1)})</span>
            {decided < 1 ? ` (${pct(result.ties)} end tied)` : ""}. Fair price{" "}
            <span className="font-mono text-foreground">{fairOdds(favP)}</span>.
            {result.ot > 0.001 &&
              ` ${pct(result.ot)} ${matchup.league === "mlb" ? "go to extra innings" : "go to overtime"}${
                result.so > 0 ? `, ${pct(result.so)} to a shootout` : ""
              }.`}
          </p>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            ± is the 95% Monte Carlo error: rerun with fresh randomness and the number lands within
            it.{" "}
            {n < 10000
              ? `Run ${(n < 1000 ? 1000 : 10000).toLocaleString()} games to get it under ±${(moeP(0.5, n < 1000 ? 1000 : 10000) * 100).toFixed(1)}.`
              : ""}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border">
          <Tile
            label={`Avg ${away.abbr} ${u.pts}`}
            value={result.avgAway.toFixed(1)}
            moe={moeMean(result.sd.away, n)}
          />
          <Tile
            label={`Avg ${home.abbr} ${u.pts}`}
            value={result.avgHome.toFixed(1)}
            moe={moeMean(result.sd.home, n)}
          />
          <Tile
            label="Median margin"
            value={
              medianMargin === 0 ? "Even" : `${winnerOf(medianMargin)} by ${Math.abs(medianMargin)}`
            }
          />
          <Tile
            label="Avg total"
            value={(result.avgHome + result.avgAway).toFixed(1)}
            moe={moeMean(result.sd.total, n)}
          />
        </div>
      </div>

      {/* Market */}
      {mkt && (
        <section className="border border-border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-4 sm:px-6">
            <h3 className="font-display text-3xl">Simulation vs the market</h3>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Posted by {mkt.provider} · the simulation never sees these numbers
            </span>
          </div>
          <div className="grid gap-px bg-border md:grid-cols-3">
            <MarketCell
              title="Moneyline"
              posted={
                mkt.homeMl != null && mkt.awayMl != null
                  ? `${away.abbr} ${mkt.awayMl > 0 ? "+" : ""}${mkt.awayMl} · ${home.abbr} ${mkt.homeMl > 0 ? "+" : ""}${mkt.homeMl}`
                  : "—"
              }
              rows={[
                ["Market (no vig)", mktHome != null ? `${home.abbr} ${pct(mktHome)}` : "—"],
                [
                  "Simulation",
                  `${home.abbr} ${pct(result.homeWins / Math.max(1e-9, decided || 1))}`,
                ],
                [
                  "Difference",
                  mktHome != null
                    ? `${signed((result.homeWins / Math.max(1e-9, decided || 1) - mktHome) * 100)} pts`
                    : "—",
                ],
              ]}
            />
            <MarketCell
              title={
                matchup.league === "mlb"
                  ? "Run line"
                  : matchup.league === "nhl"
                    ? "Puck line"
                    : "Spread"
              }
              posted={line?.spread != null ? spreadText(home.abbr, line.spread) : "—"}
              rows={
                line?.spread != null
                  ? [
                      [`${home.abbr} covers`, pct(line.homeCover)],
                      [`${away.abbr} covers`, pct(1 - line.homeCover - line.push)],
                      ["Sim median line", spreadText(home.abbr, -medianMargin)],
                    ]
                  : [["", "No spread posted"]]
              }
            />
            <MarketCell
              title="Total"
              posted={line?.total != null ? `O/U ${line.total}` : "—"}
              rows={
                line?.total != null
                  ? [
                      ["Over", pct(line.over)],
                      ["Under", pct(line.under)],
                      ["Sim mean total", (result.avgHome + result.avgAway).toFixed(1)],
                    ]
                  : [["", "No total posted"]]
              }
            />
          </div>
          <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground sm:px-6">
            A gap between the two is a disagreement, not an edge. Books price injuries, rest,
            weather and news the simulation cannot see; where they differ, start by asking what the
            market knows.
          </p>
        </section>
      )}

      {/* Distributions */}
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Final margin"
          subtitle={`${home.abbr} − ${away.abbr}, share of simulated games. Mean ${signed(meanMargin)}.`}
          legend={
            <>
              <LegendKey color={AWAY_COLOR} label={`${away.abbr} win`} />
              <LegendKey color={HOME_COLOR} label={`${home.abbr} win`} />
            </>
          }
        >
          <Histogram
            bins={marginBins}
            refs={
              line?.spread != null
                ? [{ x: -line.spread, label: `Line ${spreadText(home.abbr, line.spread)}` }]
                : []
            }
            xFmt={(x) => (x > 0 ? `+${x}` : String(x))}
            ariaLabel="Distribution of the final margin"
            describe={(b) => [
              pct(b.p),
              b.x === 0 ? "Tied" : `${winnerOf(b.x)} by ${Math.abs(b.x)}`,
            ]}
          />
          <BinTable bins={marginBins} xLabel="Margin" xFmt={(x) => (x > 0 ? `+${x}` : String(x))} />
        </ChartCard>
        <ChartCard
          title={`Total ${u.pts}`}
          subtitle={`Both teams combined. Mean ${(result.avgHome + result.avgAway).toFixed(1)}.`}
        >
          <Histogram
            bins={totalBins}
            refs={line?.total != null ? [{ x: line.total, label: `O/U ${line.total}` }] : []}
            ariaLabel="Distribution of the total score"
            describe={(b) => [pct(b.p), `${b.x} total ${u.pts}`]}
          />
          <BinTable bins={totalBins} xLabel="Total" xFmt={String} />
        </ChartCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <section className="border border-border bg-card p-5 sm:p-6">
          <h3 className="font-display text-2xl">Most likely final scores</h3>
          <ol className="mt-3 divide-y divide-border/60 font-mono text-sm tabular-nums">
            {result.topScores.map((s, i) => (
              <li key={i} className="flex items-center justify-between py-1.5">
                <span className="text-foreground">
                  {away.abbr} {s.away} – {home.abbr} {s.home}
                </span>
                <span className="text-muted-foreground">{pct(s.count)}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="border border-border bg-card p-5 sm:p-6">
          <h3 className="font-display text-2xl">Team averages</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Per game, across all {n.toLocaleString()} simulations.
          </p>
          <TeamAverages matchup={matchup} result={result} />
        </section>
      </div>

      <Movers matchup={matchup} result={result} />

      <AverageBox matchup={matchup} result={result} />

      <PlayerTable matchup={matchup} result={result} />
    </div>
  );
}

function medianOf(h: Record<number, number>, n: number): number {
  const keys = Object.keys(h)
    .map(Number)
    .sort((a, b) => a - b);
  let acc = 0;
  for (const k of keys) {
    acc += h[k];
    if (acc >= n / 2) return k;
  }
  return 0;
}

function Tile({ label, value, moe }: { label: string; value: string; moe?: number }) {
  return (
    <div className="bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-foreground">
        {value}
        {moe != null && (
          <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
            ±{moe < 0.1 ? moe.toFixed(2) : moe.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}

function MarketCell({
  title,
  posted,
  rows,
}: {
  title: string;
  posted: string;
  rows: [string, string][];
}) {
  return (
    <div className="bg-card p-5 sm:p-6">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="mt-1 font-display text-2xl">{posted}</div>
      <dl className="mt-3 space-y-1 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k + v} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-foreground tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  legend,
  children,
}: {
  title: string;
  subtitle: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-2xl">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {legend && <div className="flex gap-4">{legend}</div>}
      </div>
      {children}
    </section>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function TeamAverages({ matchup, result }: { matchup: SimMatchup; result: MassResult }) {
  const labels: Record<string, string> = {
    YDS: "Total yards",
    PASS: "Passing yards",
    RUSH: "Rushing yards",
    FD: "First downs",
    TO: "Turnovers",
    SACKS: "Sacked",
    PLAYS: "Offensive plays",
    SOG: "Shots on goal",
    PPO: "Power plays",
    PPG: "Power-play goals",
    H: "Hits",
    E: "Errors",
    LOB: "Left on base",
  };
  const keys = Object.keys(result.team.home).filter((k) => labels[k]);
  if (!keys.length) return null;
  return (
    <table className="mt-5 w-full font-mono text-xs tabular-nums">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 text-left font-normal">Per game, average</th>
          <th className="py-1 text-right font-normal">{matchup.away.abbr}</th>
          <th className="py-1 text-right font-normal">{matchup.home.abbr}</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="border-t border-border/40">
            <td className="py-1 text-muted-foreground">{labels[k]}</td>
            <td className="py-1 text-right text-foreground">
              {(result.team.away[k] ?? 0).toFixed(1)}
            </td>
            <td className="py-1 text-right text-foreground">
              {(result.team.home[k] ?? 0).toFixed(1)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ players

function PlayerTable({ matchup, result }: { matchup: SimMatchup; result: MassResult }) {
  const defs = PROPS[matchup.league].filter((d) =>
    result.players.some((p) => p.props.some((x) => x.key === d.key)),
  );
  const [key, setKey] = useState(defs[0]?.key ?? "");
  const [side, setSide] = useState<"all" | "home" | "away">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const def = defs.find((d) => d.key === key) ?? defs[0];

  const rows = useMemo(() => {
    if (!def) return [];
    return result.players
      .filter((p) => side === "all" || p.side === side)
      .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ p, s: p.props.find((x) => x.key === def.key) }))
      .filter((r): r is { p: PlayerSummary; s: NonNullable<typeof r.s> } => !!r.s)
      .sort((a, b) => b.s.mean - a.s.mean);
  }, [result, def, side, q]);

  if (!def) return null;

  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-display text-3xl">Player projections</h3>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Each player&apos;s stat across all {result.n.toLocaleString()} games — games he sat
            count as zero — next to his season per-game average (this season blended with last, the
            numbers the engine starts from). Percentages are the share of games at or above the
            line. Click a player for his distribution and every stat.
          </p>
        </div>
        <button
          onClick={() => downloadCsv(matchup, result)}
          className="border border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:border-primary hover:text-foreground"
        >
          ⤓ Export CSV
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 sm:px-6">
        <select
          value={def.key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="Stat"
          className="border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground"
        >
          {defs.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="flex" role="group" aria-label="Team">
          {(["all", "away", "home"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              aria-pressed={side === s}
              className={`border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                side === s
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s === "all" ? "Both" : matchup[s].abbr}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a player"
          className="ml-auto w-44 border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-5 py-2 text-left font-normal sm:px-6">Player</th>
              <th
                className="px-2 py-2 text-right font-normal"
                title="Simulated average per game, ± its 95% Monte Carlo error"
              >
                Sim avg
              </th>
              <th className="px-2 py-2 text-right font-normal" title="Season average per game">
                Season
              </th>
              <th className="px-2 py-2 text-right font-normal">vs season</th>
              <th className="px-2 py-2 text-right font-normal">Median</th>
              <th
                className="px-2 py-2 text-right font-normal"
                title="80% of simulated games land in this range"
              >
                10th–90th
              </th>
              {def.lines.map((l) => (
                <th key={l} className="px-2 py-2 text-right font-normal">
                  {l}+
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, s }) => {
              const id = `${p.side}:${p.idx}`;
              const color = p.side === "home" ? HOME_COLOR : AWAY_COLOR;
              return (
                <PlayerRow
                  key={id}
                  p={p}
                  s={s}
                  lines={def.lines}
                  color={color}
                  open={open === id}
                  onToggle={() => setOpen(open === id ? null : id)}
                  abbr={matchup[p.side].abbr}
                  n={result.n}
                  label={def.label}
                  matchup={matchup}
                />
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6 + def.lines.length}
                  className="px-6 py-6 text-center text-muted-foreground"
                >
                  Nobody matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlayerRow({
  p,
  s,
  lines,
  color,
  open,
  onToggle,
  abbr,
  n,
  label,
  matchup,
}: {
  p: PlayerSummary;
  s: PlayerSummary["props"][number];
  lines: number[];
  color: string;
  open: boolean;
  onToggle: () => void;
  abbr: string;
  n: number;
  label: string;
  matchup: SimMatchup;
}) {
  const bins = open ? toBins(s.hist, n, () => color, 0.001) : [];
  const defs = PROPS[matchup.league];
  const season = p.avg?.[s.key];
  const digits = s.mean < 10 ? 2 : 1;
  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/40 hover:bg-secondary/30"
        onClick={onToggle}
      >
        <td className="px-5 py-1.5 text-left sm:px-6">
          <button className="flex items-center gap-2 text-left" aria-expanded={open}>
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: color }}
              aria-hidden
            />
            <span className="text-foreground">{p.name}</span>
            <span className="text-muted-foreground">
              {abbr} · {p.pos}
            </span>
          </button>
        </td>
        <td
          className="px-2 py-1.5 text-right text-foreground"
          title={`±${moeMean(s.sd, n).toFixed(digits)} (95% Monte Carlo error)`}
        >
          {s.mean.toFixed(digits)}
        </td>
        <td className="px-2 py-1.5 text-right text-muted-foreground">
          {season != null ? season.toFixed(digits) : "—"}
        </td>
        <td className="px-2 py-1.5 text-right">
          <VsSeason sim={s.mean} season={season} digits={digits} />
        </td>
        <td className="px-2 py-1.5 text-right text-foreground/90">{s.median}</td>
        <td className="px-2 py-1.5 text-right text-muted-foreground">
          {s.p10}–{s.p90}
        </td>
        {s.over.map((o, i) => (
          <td
            key={lines[i]}
            className={`px-2 py-1.5 text-right ${o >= 0.6 ? "text-foreground" : o >= 0.3 ? "text-foreground/80" : "text-muted-foreground"}`}
            title={`Fair odds ${fairOdds(o)}`}
          >
            {o < 0.005 ? "<1%" : o > 0.995 ? ">99%" : `${Math.round(o * 100)}%`}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="border-b border-border/40 bg-secondary/20">
          <td colSpan={6 + lines.length} className="px-5 py-4 sm:px-6">
            <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {p.name} · {label} · distribution over {n.toLocaleString()} games
                </div>
                <Histogram
                  bins={bins}
                  height={150}
                  ariaLabel={`${p.name} ${label} distribution`}
                  describe={(b) => [pct(b.p), `${b.x} ${label.toLowerCase()}`]}
                />
              </div>
              <table className="self-start font-mono text-[11px] tabular-nums">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left font-normal">Every stat</th>
                    <th className="px-2 py-1 text-right font-normal">Sim avg</th>
                    <th className="px-2 py-1 text-right font-normal">Season</th>
                    <th className="px-2 py-1 text-right font-normal">10–90</th>
                  </tr>
                </thead>
                <tbody>
                  {p.props.map((x) => (
                    <tr key={x.key} className="border-t border-border/40">
                      <td className="py-1 text-muted-foreground">
                        {defs.find((d) => d.key === x.key)?.label}
                      </td>
                      <td className="px-2 py-1 text-right text-foreground">
                        {x.mean.toFixed(x.mean < 10 ? 2 : 1)}
                      </td>
                      <td className="px-2 py-1 text-right text-muted-foreground">
                        {p.avg?.[x.key] != null ? p.avg[x.key].toFixed(x.mean < 10 ? 2 : 1) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right text-muted-foreground">
                        {x.p10}–{x.p90}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function downloadCsv(m: SimMatchup, r: MassResult) {
  const defs = PROPS[m.league];
  const head = [
    "team",
    "player",
    "pos",
    "stat",
    "mean",
    "median",
    "p10",
    "p90",
    "line",
    "p_at_or_over",
    "fair_odds",
  ];
  const out = [head.join(",")];
  for (const p of r.players)
    for (const s of p.props) {
      const d = defs.find((x) => x.key === s.key);
      if (!d) continue;
      d.lines.forEach((l, i) =>
        out.push(
          [
            m[p.side].abbr,
            `"${p.name.replace(/"/g, "'")}"`,
            p.pos,
            d.label,
            s.mean.toFixed(3),
            s.median,
            s.p10,
            s.p90,
            l,
            s.over[i].toFixed(4),
            fairOdds(s.over[i]),
          ].join(","),
        ),
      );
    }
  const blob = new Blob([out.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${m.league}-${m.away.abbr}-at-${m.home.abbr}-${r.n}-sims.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Simulated minus season, as an arrow and a percentage. Text stays in text
 *  colours; the arrow carries the direction. */
function VsSeason({ sim, season, digits }: { sim: number; season?: number; digits: number }) {
  if (season == null || season <= 0) return <span className="text-muted-foreground">—</span>;
  const d = sim - season;
  const rel = d / season;
  if (Math.abs(rel) < 0.02 || Math.abs(d) < 0.5 * 10 ** -digits)
    return <span className="text-muted-foreground">≈</span>;
  return (
    <span
      className={Math.abs(rel) >= 0.1 ? "text-foreground" : "text-foreground/80"}
      title={`${signed(d, digits)} per game`}
    >
      {rel > 0 ? "▲" : "▼"} {Math.abs(Math.round(rel * 100))}%
    </span>
  );
}

// ------------------------------------------------------------ movers

/** The headline stats per league, and the season level a player needs for a
 *  percentage change to mean anything. */
const MOVER_STATS: Record<SimLeague, { key: string; min: number }[]> = {
  nfl: [
    { key: "pyd", min: 120 },
    { key: "ryd", min: 25 },
    { key: "reyd", min: 25 },
    { key: "rec", min: 2 },
  ],
  nba: [
    { key: "pts", min: 8 },
    { key: "reb", min: 4 },
    { key: "ast", min: 3 },
    { key: "3pm", min: 1 },
  ],
  nhl: [
    { key: "sog", min: 1.5 },
    { key: "pts", min: 0.4 },
    { key: "sv", min: 15 },
  ],
  mlb: [
    { key: "tb", min: 1.2 },
    { key: "h", min: 0.7 },
    { key: "k", min: 3 },
    { key: "outs", min: 9 },
  ],
};

type Move = { p: PlayerSummary; def: PropDef; sim: number; season: number; rel: number };

/**
 * Who the matchup moves: the biggest gaps between a player's simulated
 * average and his season average, in both directions.
 */
function Movers({ matchup, result }: { matchup: SimMatchup; result: MassResult }) {
  const moves = useMemo(() => {
    const defs = PROPS[matchup.league];
    const out: Move[] = [];
    for (const { key, min } of MOVER_STATS[matchup.league]) {
      const def = defs.find((d) => d.key === key);
      if (!def) continue;
      for (const p of result.players) {
        const season = p.avg?.[key];
        const s = p.props.find((x) => x.key === key);
        if (!s || season == null || season < min || p.played < 0.5) continue;
        out.push({ p, def, sim: s.mean, season, rel: s.mean / season - 1 });
      }
    }
    return out;
  }, [matchup, result]);
  const up = moves
    .filter((m) => m.rel >= 0.03)
    .sort((a, b) => b.rel - a.rel)
    .slice(0, 6);
  const down = moves
    .filter((m) => m.rel <= -0.03)
    .sort((a, b) => a.rel - b.rel)
    .slice(0, 6);
  if (!up.length && !down.length) return null;
  return (
    <section className="border border-border bg-card">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <h3 className="font-display text-3xl">Who this matchup moves</h3>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
          The biggest gaps between a player&apos;s simulated average and his season per-game
          average. Most of the gap is this game — the defense across from him, the pace, home or
          road, who else is in the lineup. Some is the season line itself: games he left early, a
          role that has changed, a small sample the engine pulls toward the league.
        </p>
      </div>
      <div className="grid gap-px bg-border md:grid-cols-2">
        <MoverList title="Up against this opponent" rows={up} matchup={matchup} />
        <MoverList title="Down against this opponent" rows={down} matchup={matchup} />
      </div>
    </section>
  );
}

function MoverList({ title, rows, matchup }: { title: string; rows: Move[]; matchup: SimMatchup }) {
  return (
    <div className="bg-card px-5 py-4 sm:px-6">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody moves more than 3%.</p>
      ) : (
        <table className="w-full font-mono text-[11px] tabular-nums">
          <tbody>
            {rows.map((m) => {
              const digits = m.season < 10 ? 2 : 1;
              return (
                <tr
                  key={`${m.p.side}:${m.p.idx}:${m.def.key}`}
                  className="border-t border-border/40"
                >
                  <td className="py-1.5 pr-2">
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                      style={{ background: m.p.side === "home" ? HOME_COLOR : AWAY_COLOR }}
                      aria-hidden
                    />
                    <span className="text-foreground">{m.p.name}</span>{" "}
                    <span className="text-muted-foreground">{matchup[m.p.side].abbr}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-muted-foreground">{m.def.label}</td>
                  <td className="py-1.5 pr-2 text-right text-muted-foreground">
                    {m.season.toFixed(digits)} →
                  </td>
                  <td className="py-1.5 pr-2 text-right text-foreground">
                    {m.sim.toFixed(digits)}
                  </td>
                  <td className="py-1.5 text-right text-foreground">
                    {m.rel > 0 ? "▲" : "▼"} {Math.abs(Math.round(m.rel * 100))}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------ average box

/** The box score averaged over every simulated game, one team at a time. */
function AverageBox({ matchup, result }: { matchup: SimMatchup; result: MassResult }) {
  const [side, setSide] = useState<"away" | "home">("away");
  const sections = AVG_BOX[matchup.league];
  const players = result.players.filter((p) => p.side === side && p.avgBox.length > 0);
  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-display text-3xl">Average box score</h3>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Every player&apos;s line averaged over all {result.n.toLocaleString()} games, games he
            sat counted as zero. The team row adds them up.
          </p>
        </div>
        <div className="flex" role="group" aria-label="Team">
          {(["away", "home"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              aria-pressed={side === s}
              className={`flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                side === s
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s === "home" ? HOME_COLOR : AWAY_COLOR }}
              />
              {matchup[s].abbr}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-6 overflow-x-auto px-5 py-4 sm:px-6">
        {sections.map((sec) => {
          const rows = players
            .filter((p) => sec.groups.includes(p.group) && sec.show(p.avgBox))
            .sort((a, b) => sec.sort(b.avgBox) - sec.sort(a.avgBox));
          if (!rows.length) return null;
          return (
            <table key={sec.title} className="w-full font-mono text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1.5 pr-3 text-left font-normal">
                    <span className="font-display text-base normal-case tracking-normal text-foreground">
                      {sec.title}
                    </span>
                  </th>
                  {sec.cols.map((c) => (
                    <th
                      key={c.label}
                      className="px-2 py-1.5 text-right font-normal"
                      title={c.title}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.idx} className="border-b border-border/40">
                    <td className="whitespace-nowrap py-1 pr-3 text-left">
                      <span className="text-foreground">{p.name}</span>{" "}
                      <span className="text-muted-foreground">
                        {p.pos}
                        {p.played < 0.95
                          ? // A football player "appears" when he records a stat.
                            ` · ${matchup.league === "nfl" ? "a stat in" : "in"} ${Math.round(p.played * 100)}% of games`
                          : ""}
                      </span>
                    </td>
                    {sec.cols.map((c) => (
                      <td key={c.label} className="px-2 py-1 text-right text-foreground">
                        {fmtAvg(c.get(p.avgBox), c.digits ?? 1, c.signed)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="text-muted-foreground">
                  <td className="py-1 pr-3 text-left uppercase tracking-widest">Team</td>
                  {sec.cols.map((c) => (
                    <td key={c.label} className="px-2 py-1 text-right">
                      {c.noTotal
                        ? ""
                        : fmtAvg(
                            rows.reduce((a, p) => a + c.get(p.avgBox), 0),
                            c.digits ?? 1,
                            c.signed,
                          )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          );
        })}
      </div>
    </section>
  );
}

function fmtAvg(v: number, digits: number, sign?: boolean): string {
  const t = v.toFixed(digits);
  if (digits === 3) return t.replace(/^0/, "");
  return sign && v > 0 ? `+${t}` : t;
}
