import { useMemo, useState } from "react";

import type { MassResult, PlayerSummary } from "@/lib/sim/aggregate";
import { PROPS, UNITS } from "@/lib/sim/props";
import type { SimMatchup } from "@/lib/sim/types";

import {
  AWAY_COLOR,
  fairOdds,
  HOME_COLOR,
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
 * most, and every player's stat distribution.
 */
export function BatchResults({
  matchup,
  result,
  partial,
  onWatch,
}: {
  matchup: SimMatchup;
  result: MassResult;
  partial: boolean;
  onWatch: (seed: number) => void;
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
            {fav.name} win {pct(favP)} of simulated games
            {decided < 1 ? ` (${pct(result.ties)} end tied)` : ""}. Fair price{" "}
            <span className="font-mono text-foreground">{fairOdds(favP)}</span>.
            {result.ot > 0.001 &&
              ` ${pct(result.ot)} ${matchup.league === "mlb" ? "go to extra innings" : "go to overtime"}${
                result.so > 0 ? `, ${pct(result.so)} to a shootout` : ""
              }.`}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border">
          <Tile label={`Avg ${away.abbr} ${u.pts}`} value={result.avgAway.toFixed(1)} />
          <Tile label={`Avg ${home.abbr} ${u.pts}`} value={result.avgHome.toFixed(1)} />
          <Tile
            label="Median margin"
            value={
              medianMargin === 0 ? "Even" : `${winnerOf(medianMargin)} by ${Math.abs(medianMargin)}`
            }
          />
          <Tile label="Avg total" value={(result.avgHome + result.avgAway).toFixed(1)} />
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
          <h3 className="font-display text-2xl">Watch one from this batch</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Every simulated game can be replayed play by play — these are three worth seeing.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {result.featured.map((f) => (
              <button
                key={f.label}
                onClick={() => onWatch(f.seed)}
                className="border border-border bg-secondary/40 px-3 py-3 text-left transition-colors hover:border-primary"
              >
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {f.label}
                </div>
                <div className="mt-1 font-display text-2xl tabular-nums">
                  {away.abbr} {f.away} – {f.home} {home.abbr}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-primary">
                  ▶ Watch
                </div>
              </button>
            ))}
          </div>
          <TeamAverages matchup={matchup} result={result} />
        </section>
      </div>

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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
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
          <p className="text-xs text-muted-foreground">
            Each player&apos;s stat across all {result.n.toLocaleString()} games — games he sat
            count as zero. Percentages are the share of games at or above the line.
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
              <th className="px-2 py-2 text-right font-normal">Mean</th>
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
                  colSpan={4 + def.lines.length}
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
        <td className="px-2 py-1.5 text-right text-foreground">
          {s.mean.toFixed(s.mean < 10 ? 2 : 1)}
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
          <td colSpan={4 + lines.length} className="px-5 py-4 sm:px-6">
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
                    <th className="px-2 py-1 text-right font-normal">Mean</th>
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
