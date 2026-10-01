import { useEffect, useMemo, useState } from "react";

import { BOX, boxPlayers, UNITS, type BoxPlayer } from "@/lib/sim/props";
import type { GameResult, PlayEvent, SimMatchup, Side } from "@/lib/sim/types";

import { AWAY_COLOR, hideBroken, HOME_COLOR } from "./format";

/**
 * One simulated game, played back like a broadcast: scoreboard, situation,
 * line score, play-by-play and a box score that fills in as the game goes.
 *
 * The engine records every play with the box-score changes it caused, so
 * scrubbing to any moment rebuilds the box exactly as it stood then.
 */

const SPEEDS = [
  { key: "slow", label: "Broadcast", ms: 900 },
  { key: "normal", label: "Quick", ms: 260 },
  { key: "fast", label: "Fast", ms: 45 },
] as const;

export function GameViewer({
  matchup,
  result,
  onNew,
  busy,
}: {
  matchup: SimMatchup;
  result: GameResult;
  onNew: () => void;
  busy: boolean;
}) {
  const events = useMemo(() => result.events ?? [], [result]);
  const total = events.length;
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]["key"]>("normal");
  const [scoringOnly, setScoringOnly] = useState(false);
  const [boxSide, setBoxSide] = useState<Side>("away");

  // A new game starts from the opening whistle.
  useEffect(() => {
    setCursor(0);
    setPlaying(true);
  }, [result]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }
    const ms = SPEEDS.find((s) => s.key === speed)?.ms ?? 260;
    const t = setTimeout(() => setCursor((c) => Math.min(total, c + 1)), ms);
    return () => clearTimeout(t);
  }, [playing, cursor, total, speed]);

  const shown = events.slice(0, cursor);
  const last: PlayEvent | undefined = shown[shown.length - 1];
  const done = cursor >= total;
  const home = last?.home ?? 0;
  const away = last?.away ?? 0;
  const finalHome = done ? result.home : home;
  const finalAway = done ? result.away : away;

  const box = useMemo(() => {
    const rows = {
      home: result.box.home.map((r) => r.map(() => 0)),
      away: result.box.away.map((r) => r.map(() => 0)),
    };
    for (let i = 0; i < cursor; i++)
      for (const [s, p, st, v] of events[i].deltas ?? [])
        rows[s === 0 ? "home" : "away"][p][st] += v;
    return rows;
  }, [cursor, events, result]);

  const lineScore = useMemo(
    () => buildLineScore(matchup, events, cursor),
    [matchup, events, cursor],
  );

  const feed = useMemo(() => {
    const list = shown.map((e, i) => ({ e, i })).filter(({ e }) => !scoringOnly || e.scoring);
    return list.reverse();
  }, [shown, scoringOnly]);

  const status = done
    ? result.status
    : last
      ? matchup.league === "mlb"
        ? last.clock
        : `${periodLabel(matchup.league, last.period, result.so)} · ${last.clock}`
      : "Pregame";

  return (
    <div className="border border-border bg-card">
      {/* Scoreboard */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border px-4 py-5 sm:px-6">
        <TeamScore
          team={matchup.away}
          score={finalAway}
          color={AWAY_COLOR}
          align="left"
          lead={done && result.away > result.home}
        />
        <div className="text-center">
          <div className="font-mono text-[11px] uppercase tracking-widest text-primary">
            {status}
          </div>
          {last?.sit && !done && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">{last.sit}</div>
          )}
          {matchup.league === "mlb" && last && !done && (
            <Diamond bases={last.bases ?? 0} outs={last.outs ?? 0} />
          )}
        </div>
        <TeamScore
          team={matchup.home}
          score={finalHome}
          color={HOME_COLOR}
          align="right"
          lead={done && result.home > result.away}
        />
      </div>
      {matchup.league === "nfl" && last?.ball != null && !done && (
        <FieldStrip
          ball={last.ball}
          homeAbbr={matchup.home.abbr}
          awayAbbr={matchup.away.abbr}
          offense={last.side}
        />
      )}

      <LineScoreTable matchup={matchup} line={lineScore} final={done} result={result} />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
        <button
          onClick={() => (done ? (setCursor(0), setPlaying(true)) : setPlaying((p) => !p))}
          className="border border-primary bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-primary hover:bg-primary/20"
        >
          {done ? "↺ Watch again" : playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => {
            setCursor(total);
            setPlaying(false);
          }}
          disabled={done}
          className="border border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          ⏭ Skip to final
        </button>
        <div className="ml-1 flex items-center gap-1" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSpeed(s.key)}
              className={`px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest ${
                speed === s.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-pressed={speed === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={total}
          value={cursor}
          onChange={(e) => {
            setCursor(Number(e.target.value));
            setPlaying(false);
          }}
          aria-label="Jump to a moment in the game"
          className="mx-2 min-w-[8rem] flex-1 accent-[var(--color-primary)]"
        />
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground tabular-nums">
          {cursor}/{total} plays
        </span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Play-by-play */}
        <div className="border-b border-border lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-4 py-3 sm:px-6">
            <h3 className="font-display text-2xl">Play-by-play</h3>
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <input
                type="checkbox"
                checked={scoringOnly}
                onChange={(e) => setScoringOnly(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Scoring only
            </label>
          </div>
          <ol className="max-h-[560px] overflow-y-auto px-4 pb-4 sm:px-6" aria-live="polite">
            {feed.length === 0 && (
              <li className="py-6 text-center font-mono text-xs text-muted-foreground">
                {cursor === 0 ? "Waiting for the opening play…" : "No scoring yet."}
              </li>
            )}
            {feed.map(({ e, i }) => (
              <li
                key={i}
                className={`grid grid-cols-[4.5rem_1fr] gap-3 border-b border-border/50 py-2 text-sm ${
                  e.big ? "bg-primary/5" : ""
                }`}
              >
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground tabular-nums">
                  {matchup.league === "mlb"
                    ? e.clock
                    : `${periodLabel(matchup.league, e.period, result.so)} ${e.clock}`}
                </span>
                <span className="flex gap-2">
                  {e.side && (
                    <span
                      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: e.side === "home" ? HOME_COLOR : AWAY_COLOR }}
                      aria-hidden
                    />
                  )}
                  <span
                    className={
                      e.scoring
                        ? "font-semibold text-foreground"
                        : e.side
                          ? "text-foreground/90"
                          : "text-muted-foreground"
                    }
                  >
                    {e.text}
                    {e.scoring && (
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                        {matchup.away.abbr} {e.away} – {matchup.home.abbr} {e.home}
                      </span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* Box score */}
        <div>
          <div className="flex items-center justify-between px-4 py-3 sm:px-6">
            <h3 className="font-display text-2xl">Box score</h3>
            <div className="flex gap-1" role="tablist">
              {(["away", "home"] as const).map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={boxSide === s}
                  onClick={() => setBoxSide(s)}
                  className={`flex items-center gap-2 border px-3 py-1 font-mono text-[11px] uppercase tracking-widest ${
                    boxSide === s
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
          <div className="max-h-[560px] overflow-auto px-4 pb-4 sm:px-6">
            <BoxScore matchup={matchup} side={boxSide} rows={box[boxSide]} />
            <TeamTotals result={result} matchup={matchup} done={done} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:px-6">
        <span>Fresh randomness every game · no two play out alike</span>
        <span className="flex gap-2">
          <button
            onClick={onNew}
            disabled={busy}
            className="border border-primary px-3 py-1.5 text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            Play a new game
          </button>
        </span>
      </div>
    </div>
  );
}

function periodLabel(league: SimMatchup["league"], p: number, so = false): string {
  if (league === "mlb") return `Inn ${p}`;
  if (league === "nhl")
    return p <= 3 ? `P${p}` : p === 4 ? "OT" : so && p === 5 ? "SO" : `${p - 3}OT`;
  if (p <= 4) return `Q${p}`;
  return p === 5 ? "OT" : `${p - 4}OT`;
}

function TeamScore({
  team,
  score,
  color,
  align,
  lead,
}: {
  team: SimMatchup["home"];
  score: number;
  color: string;
  align: "left" | "right";
  lead: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 ${align === "right" ? "flex-row-reverse text-right" : ""}`}
    >
      {team.logo && (
        <img
          src={team.logo}
          alt=""
          onError={hideBroken}
          className="h-10 w-10 shrink-0 object-contain sm:h-14 sm:w-14"
          loading="lazy"
        />
      )}
      <div className="min-w-0">
        <div
          className={`flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground ${align === "right" ? "justify-end" : ""}`}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: color }}
            aria-hidden
          />
          {team.abbr}
        </div>
        <div className="truncate text-sm text-foreground sm:text-base">{team.name}</div>
      </div>
      <div
        className={`font-display text-5xl tabular-nums sm:text-6xl ${lead ? "text-primary" : "text-foreground"} ${align === "right" ? "mr-auto" : "ml-auto"}`}
      >
        {score}
      </div>
    </div>
  );
}

function Diamond({ bases, outs }: { bases: number; outs: number }) {
  const on = (b: number) => (bases & b ? "var(--color-primary)" : "transparent");
  return (
    <div className="mt-2 flex items-center justify-center gap-3">
      <svg
        width="44"
        height="34"
        viewBox="0 0 44 34"
        aria-label={`Runners: ${["first", "second", "third"].filter((_, i) => bases & (1 << i)).join(", ") || "none"}`}
      >
        {[
          { b: 2, x: 22, y: 7 },
          { b: 4, x: 9, y: 20 },
          { b: 1, x: 35, y: 20 },
        ].map((p) => (
          <rect
            key={p.b}
            x={p.x - 6}
            y={p.y - 6}
            width={12}
            height={12}
            transform={`rotate(45 ${p.x} ${p.y})`}
            fill={on(p.b)}
            stroke="var(--color-muted-foreground)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <div className="flex gap-1" aria-label={`${outs} out`}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`inline-block h-2.5 w-2.5 rounded-full border ${i < outs ? "border-primary bg-primary" : "border-muted-foreground"}`}
          />
        ))}
      </div>
    </div>
  );
}

/** A 100-yard strip with the ball on it. 0 is the home goal line. */
function FieldStrip({
  ball,
  homeAbbr,
  awayAbbr,
  offense,
}: {
  ball: number;
  homeAbbr: string;
  awayAbbr: string;
  offense: Side | null;
}) {
  return (
    <div className="border-b border-border px-4 py-3 sm:px-6">
      <div className="relative h-7 w-full overflow-hidden rounded-[4px] bg-grass/25">
        <div
          className="absolute inset-y-0 left-0 flex w-[8%] items-center justify-center font-mono text-[9px] uppercase tracking-widest text-foreground"
          style={{ background: "color-mix(in oklab, var(--color-chart-2) 35%, transparent)" }}
        >
          {homeAbbr}
        </div>
        <div
          className="absolute inset-y-0 right-0 flex w-[8%] items-center justify-center font-mono text-[9px] uppercase tracking-widest text-foreground"
          style={{ background: "color-mix(in oklab, var(--color-chart-1) 35%, transparent)" }}
        >
          {awayAbbr}
        </div>
        {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((y) => (
          <div
            key={y}
            className="absolute inset-y-0 w-px bg-foreground/15"
            style={{ left: `${8 + y * 0.84}%` }}
          />
        ))}
        <div
          className="absolute top-1/2 h-3 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card"
          style={{
            left: `${8 + ball * 0.84}%`,
            background: offense === "home" ? HOME_COLOR : AWAY_COLOR,
          }}
          aria-label={`Ball at the ${ball <= 50 ? `${homeAbbr} ${ball}` : `${awayAbbr} ${100 - ball}`}`}
        />
      </div>
    </div>
  );
}

type Line = { home: number[]; away: number[] };

function buildLineScore(m: SimMatchup, events: PlayEvent[], cursor: number): Line {
  const base = m.league === "mlb" ? 9 : m.league === "nhl" ? 3 : 4;
  const line: Line = { home: new Array(base).fill(0), away: new Array(base).fill(0) };
  let ph = 0;
  let pa = 0;
  let maxPeriod = 1;
  for (let i = 0; i < cursor; i++) {
    const e = events[i];
    maxPeriod = Math.max(maxPeriod, e.period);
    const k = e.period - 1;
    while (line.home.length <= k) {
      line.home.push(0);
      line.away.push(0);
    }
    line.home[k] += e.home - ph;
    line.away[k] += e.away - pa;
    ph = e.home;
    pa = e.away;
  }
  return line;
}

function LineScoreTable({
  matchup,
  line,
  final,
  result,
}: {
  matchup: SimMatchup;
  line: Line;
  final: boolean;
  result: GameResult;
}) {
  const u = UNITS[matchup.league];
  const n = line.home.length;
  const heads = Array.from({ length: n }, (_, i) => {
    if (matchup.league === "mlb") return String(i + 1);
    const reg = matchup.league === "nhl" ? 3 : 4;
    if (matchup.league === "nhl" && result.so && i === 4) return "SO";
    return i < reg ? String(i + 1) : i === reg ? "OT" : `${i - reg + 1}OT`;
  });
  const extra =
    matchup.league === "mlb"
      ? (["H", "E"] as const)
      : matchup.league === "nhl"
        ? (["SOG"] as const)
        : matchup.league === "nfl"
          ? (["YDS", "TO"] as const)
          : ([] as const);
  const skipBottom = matchup.league === "mlb" && final && result.team.home.skipBottom === 1;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return (
    <div className="overflow-x-auto border-b border-border px-4 py-3 sm:px-6">
      <table className="w-full font-mono text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal" />
            {heads.map((h) => (
              <th key={h} className="w-8 py-1 text-center font-normal">
                {h}
              </th>
            ))}
            <th className="w-10 text-center font-semibold text-foreground">
              {u.pts === "runs" ? "R" : "T"}
            </th>
            {final &&
              extra.map((x) => (
                <th key={x} className="w-10 text-center font-normal">
                  {x}
                </th>
              ))}
          </tr>
        </thead>
        <tbody>
          {(["away", "home"] as const).map((s) => (
            <tr key={s} className="border-t border-border/50">
              <td className="py-1.5 pr-3 text-left text-foreground">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full"
                  style={{ background: s === "home" ? HOME_COLOR : AWAY_COLOR }}
                />
                {matchup[s].abbr}
              </td>
              {line[s].map((v, i) => (
                <td key={i} className="text-center text-foreground/90">
                  {s === "home" && skipBottom && i === line[s].length - 1 && v === 0 ? "x" : v}
                </td>
              ))}
              <td className="text-center font-semibold text-foreground">
                {final ? (s === "home" ? result.home : result.away) : sum(line[s])}
              </td>
              {final &&
                extra.map((x) => (
                  <td key={x} className="text-center text-foreground/90">
                    {Math.round(result.team[s][x] ?? 0)}
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoxScore({ matchup, side, rows }: { matchup: SimMatchup; side: Side; rows: number[][] }) {
  const players = useMemo(() => boxPlayers(matchup, side), [matchup, side]);
  return (
    <div className="space-y-5">
      {BOX[matchup.league].map((sec) => {
        const list = players
          .filter((p) => sec.groups.includes(p.group) && rows[p.idx] && sec.show(rows[p.idx]))
          .sort((a, b) => sec.sort(rows[b.idx]) - sec.sort(rows[a.idx]));
        if (!list.length) return null;
        return (
          <div key={sec.title}>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {sec.title}
            </div>
            <table className="w-full font-mono text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">Player</th>
                  {sec.cols.map((c) => (
                    <th key={c.label} className="px-1.5 py-1 text-right font-normal">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <BoxRow key={p.idx} p={p} row={rows[p.idx]} cols={sec.cols} />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function BoxRow({
  p,
  row,
  cols,
}: {
  p: BoxPlayer;
  row: number[];
  cols: (typeof BOX)["nba"][number]["cols"];
}) {
  return (
    <tr className="border-t border-border/40">
      <td className="max-w-[11rem] truncate py-1 pr-2 text-left text-foreground" title={p.name}>
        {p.short} <span className="text-muted-foreground">{p.pos}</span>
      </td>
      {cols.map((c) => {
        const v = c.get(row);
        return (
          <td key={c.label} className="px-1.5 py-1 text-right text-foreground/90">
            {c.fmt ? c.fmt(v, row) : v}
          </td>
        );
      })}
    </tr>
  );
}

function TeamTotals({
  result,
  matchup,
  done,
}: {
  result: GameResult;
  matchup: SimMatchup;
  done: boolean;
}) {
  if (!done) return null;
  const keys: Record<SimMatchup["league"], [string, string][]> = {
    nfl: [
      ["YDS", "Total yards"],
      ["PASS", "Passing"],
      ["RUSH", "Rushing"],
      ["FD", "First downs"],
      ["TO", "Turnovers"],
      ["SACKS", "Sacked"],
      ["PEN", "Penalties"],
      ["TOP", "Possession"],
    ],
    nhl: [
      ["SOG", "Shots on goal"],
      ["PPG", "Power-play goals"],
      ["PPO", "Power plays"],
    ],
    mlb: [
      ["H", "Hits"],
      ["E", "Errors"],
      ["LOB", "Left on base"],
    ],
    nba: [],
  };
  const list = keys[matchup.league];
  if (!list.length) return null;
  const fmt = (k: string, v: number) =>
    k === "TOP"
      ? `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`
      : String(Math.round(v));
  return (
    <div className="mt-5">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Team
      </div>
      <table className="w-full font-mono text-xs tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal" />
            <th className="py-1 text-right font-normal">{matchup.away.abbr}</th>
            <th className="py-1 text-right font-normal">{matchup.home.abbr}</th>
          </tr>
        </thead>
        <tbody>
          {list.map(([k, label]) => (
            <tr key={k} className="border-t border-border/40">
              <td className="py-1 text-left text-muted-foreground">{label}</td>
              <td className="py-1 text-right text-foreground">
                {fmt(k, result.team.away[k] ?? 0)}
              </td>
              <td className="py-1 text-right text-foreground">
                {fmt(k, result.team.home[k] ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
