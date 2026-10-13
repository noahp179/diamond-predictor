import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { SoccerShell } from "@/components/SoccerShell";
import { Note, Stat, StatBar } from "@/components/SportShell";
import { BinTable, Histogram, type Bin } from "@/components/sim/SimCharts";
import { fairOdds, moeP, NEUTRAL_SERIES, pct } from "@/components/sim/format";
import { Rng } from "@/lib/sim/core";
import {
  mergeBatch,
  runBatch,
  SOCCER_SIM,
  SoccerEngine,
  emptyBatch,
  type MatchEvent,
  type SoccerBatch,
  type SoccerSide,
  type SoccerSimOptions,
} from "@/lib/sim/soccer";
import { getUclSimData, getUclSquad } from "@/lib/soccer.functions";
import { goalRates, priceRates, UCL_MODEL } from "@/lib/ucl-model";

/**
 * The Champions League match simulator.
 *
 * Pick a fixture from the date (or any two clubs in this season's competition),
 * choose how many times to play it, and read the result distribution: 1X2 with
 * its Monte Carlo error next to the closed-form model and the posted market,
 * the scorelines, the goal totals, and every likely scorer's chances. Or play
 * one match and watch it minute by minute.
 *
 * The server only supplies ratings and squads; every match is played here in
 * the browser by src/lib/sim/soccer.ts, in slices so a 100,000-match run does
 * not freeze the page.
 */

export type UclSimSearch = { date?: string; game?: string; home?: string; away?: string };

const SIZES = [1000, 10000, 50000, 100000];
const SLICE = 5000;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

type SimData = Awaited<ReturnType<typeof getUclSimData>>;
type Fixture = NonNullable<SimData["slate"]>["matches"][number];

export function UclSimulatePage({
  search,
  onSearch,
}: {
  search: UclSimSearch;
  onSearch: (s: UclSimSearch) => void;
}) {
  const date = search.date ?? todayISO();
  const load = useServerFn(getUclSimData);
  const { data, isLoading } = useQuery({
    queryKey: ["ucl", "sim", date],
    queryFn: () => load({ data: { date } }),
    staleTime: 5 * 60_000,
  });

  const fixtures = data?.slate?.matches.filter((m) => m.price) ?? [];
  const clubs = data?.clubs ?? [];
  const fixture = fixtures.find((f) => f.id === search.game) ?? (search.home ? null : fixtures[0]);

  // The pairing being simulated: a fixture, or a custom matchup.
  const custom = !fixture && search.home && search.away;
  const homeClub = custom ? clubs.find((c) => c.id === search.home) : null;
  const awayClub = custom ? clubs.find((c) => c.id === search.away) : null;
  const [neutral, setNeutral] = useState(false);
  const [knockout, setKnockout] = useState(false);
  const [firstLeg, setFirstLeg] = useState<{ home: number; away: number } | null>(null);

  const pairing = useMemo(() => {
    if (fixture?.homeRating != null && fixture.awayRating != null) {
      return {
        homeId: fixture.home.id,
        awayId: fixture.away.id,
        homeName: fixture.home.name,
        awayName: fixture.away.name,
        homeAbbr: fixture.home.abbr,
        awayAbbr: fixture.away.abbr,
        homeRating: fixture.homeRating,
        awayRating: fixture.awayRating,
        neutral: fixture.neutral,
        market: fixture.market,
      };
    }
    if (homeClub && awayClub) {
      return {
        homeId: homeClub.id,
        awayId: awayClub.id,
        homeName: homeClub.name,
        awayName: awayClub.name,
        homeAbbr: homeClub.name.slice(0, 3).toUpperCase(),
        awayAbbr: awayClub.name.slice(0, 3).toUpperCase(),
        homeRating: homeClub.rating,
        awayRating: awayClub.rating,
        neutral,
        market: null,
      };
    }
    return null;
  }, [fixture, homeClub, awayClub, neutral]);

  const rates = pairing ? goalRates(pairing.homeRating, pairing.awayRating, pairing.neutral) : null;
  const closed = rates ? priceRates(rates.home, rates.away) : null;

  const squad = useServerFn(getUclSquad);
  const homeSquad = useQuery({
    queryKey: ["ucl", "squad", pairing?.homeId],
    queryFn: () => squad({ data: { teamId: pairing!.homeId } }),
    enabled: Boolean(pairing),
    staleTime: 60 * 60_000,
  });
  const awaySquad = useQuery({
    queryKey: ["ucl", "squad", pairing?.awayId],
    queryFn: () => squad({ data: { teamId: pairing!.awayId } }),
    enabled: Boolean(pairing),
    staleTime: 60 * 60_000,
  });

  const sides = useMemo((): [SoccerSide, SoccerSide] | null => {
    if (!pairing || !rates) return null;
    return [
      {
        name: pairing.homeName,
        abbr: pairing.homeAbbr,
        rate: rates.home,
        scorers: homeSquad.data?.scorers ?? [],
      },
      {
        name: pairing.awayName,
        abbr: pairing.awayAbbr,
        rate: rates.away,
        scorers: awaySquad.data?.scorers ?? [],
      },
    ];
  }, [pairing, rates, homeSquad.data, awaySquad.data]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of homeSquad.data?.scorers ?? []) m.set(s.id, s.name);
    for (const s of awaySquad.data?.scorers ?? []) m.set(s.id, s.name);
    return m;
  }, [homeSquad.data, awaySquad.data]);

  const [n, setN] = useState(10000);
  const [batch, setBatch] = useState<SoccerBatch | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [watched, setWatched] = useState<{
    events: MatchEvent[];
    hg: number;
    ag: number;
    note: string;
  } | null>(null);
  const runId = useRef(0);

  const opts: SoccerSimOptions = { knockout, firstLeg: knockout ? firstLeg : null };

  async function run() {
    if (!sides) return;
    const id = (runId.current += 1);
    setWatched(null);
    setProgress(0);
    const engine = new SoccerEngine();
    let total = emptyBatch();
    const seed = Math.floor(Math.random() * 2 ** 31);
    for (let done = 0, i = 0; done < n; done += SLICE, i += 1) {
      const size = Math.min(SLICE, n - done);
      total = mergeBatch(total, runBatch(size, seed + i * 7919, sides[0], sides[1], opts, engine));
      if (runId.current !== id) return;
      setProgress((done + size) / n);
      setBatch(total);
      await new Promise((r) => setTimeout(r, 0));
    }
    setProgress(null);
  }

  function watchOne() {
    if (!sides) return;
    const rng = new Rng(Math.floor(Math.random() * 2 ** 31));
    const r = new SoccerEngine().play(rng, sides[0], sides[1], opts, true);
    const note = r.shootout
      ? `${r.hg}-${r.ag} after extra time · ${r.shootout === "home" ? sides[0].name : sides[1].name} win on penalties`
      : r.extraTime
        ? `${r.hg}-${r.ag} after extra time`
        : "";
    setWatched({ events: r.events ?? [], hg: r.hg, ag: r.ag, note });
  }

  const pick = (s: UclSimSearch) => {
    runId.current += 1;
    setBatch(null);
    setProgress(null);
    setWatched(null);
    onSearch({ date, ...s });
  };

  return (
    <SoccerShell
      league="ucl"
      current="simulate"
      eyebrow="Diamond Edge · Champions League"
      title="Simulate"
      blurb="Play any Champions League match minute by minute, as many times as you like. Each side scores at its model goal rate, bent by the minute (stoppage time is busy), the score (level matches are the open ones) and red cards — every effect fitted on the goal logs of 9,000 European matches. Goals go to players by their share of their club's goals. Nothing is replayable: every run draws fresh numbers."
      date={date}
      onDateChange={(d) => pick({ date: d })}
      statBar={
        <StatBar>
          <Stat label="Fixtures" value={`${fixtures.length}`} />
          <Stat label="Sim RPS (backtest)" value={simRps()} />
          <Stat
            label="Model RPS (backtest)"
            value={UCL_MODEL.backtest.pooled.goals.rps.toFixed(4)}
          />
          <Stat label="Matches tested" value={UCL_MODEL.backtest.pooled.goals.n.toLocaleString()} />
        </StatBar>
      }
      footerNote="Engine · src/lib/sim/soccer.ts · constants research/ucl/sim_ucl.py · ratings ESPN soccer API"
    >
      {isLoading && <div className="h-40 animate-pulse border border-border bg-card" />}
      {data?.note && <Note>{data.note}</Note>}

      {!isLoading && (
        <section className="border border-border bg-card p-5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {fixtures.length ? `Fixtures on ${date}` : `No Champions League fixtures on ${date}`}
          </div>
          {fixtures.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {fixtures.map((f) => (
                <FixtureChip
                  key={f.id}
                  f={f}
                  active={fixture?.id === f.id}
                  onClick={() => pick({ game: f.id })}
                />
              ))}
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-end gap-3 font-mono text-[11px]">
            <label className="grid gap-1">
              <span className="uppercase tracking-widest text-muted-foreground">Home</span>
              <ClubSelect
                clubs={clubs}
                value={custom ? search.home : ""}
                onChange={(id) =>
                  pick({
                    home: id,
                    away:
                      search.away && search.away !== id
                        ? search.away
                        : clubs.find((c) => c.id !== id)?.id,
                  })
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="uppercase tracking-widest text-muted-foreground">Away</span>
              <ClubSelect
                clubs={clubs}
                value={custom ? search.away : ""}
                onChange={(id) =>
                  pick({
                    away: id,
                    home:
                      search.home && search.home !== id
                        ? search.home
                        : clubs.find((c) => c.id !== id)?.id,
                  })
                }
              />
            </label>
            {custom && (
              <label className="flex items-center gap-2 pb-2">
                <input
                  type="checkbox"
                  checked={neutral}
                  onChange={(e) => setNeutral(e.target.checked)}
                />
                <span className="uppercase tracking-widest">Neutral venue</span>
              </label>
            )}
            <label className="flex items-center gap-2 pb-2">
              <input
                type="checkbox"
                checked={knockout}
                onChange={(e) => {
                  setKnockout(e.target.checked);
                  setBatch(null);
                }}
              />
              <span className="uppercase tracking-widest">Knockout (extra time, penalties)</span>
            </label>
            {knockout && (
              <label className="flex items-center gap-2 pb-2">
                <input
                  type="checkbox"
                  checked={firstLeg !== null}
                  onChange={(e) => setFirstLeg(e.target.checked ? { home: 0, away: 0 } : null)}
                />
                <span className="uppercase tracking-widest">Second leg — first leg was</span>
                {firstLeg && (
                  <span className="flex items-center gap-1">
                    <ScoreInput
                      value={firstLeg.home}
                      onChange={(v) => setFirstLeg({ ...firstLeg, home: v })}
                    />
                    –
                    <ScoreInput
                      value={firstLeg.away}
                      onChange={(v) => setFirstLeg({ ...firstLeg, away: v })}
                    />
                    <span className="text-muted-foreground">(this match's home side first)</span>
                  </span>
                )}
              </label>
            )}
          </div>
        </section>
      )}

      {pairing && rates && closed && (
        <section className="mt-6 border border-border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {pairing.neutral ? "Neutral venue" : "Home v away"} · ratings{" "}
                {Math.round(pairing.homeRating)} v {Math.round(pairing.awayRating)}
              </div>
              <div className="mt-1 font-display text-3xl">
                {pairing.homeName} <span className="text-muted-foreground">v</span>{" "}
                {pairing.awayName}
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                Model goal rates {rates.home.toFixed(2)} – {rates.away.toFixed(2)} · closed form{" "}
                {pct(closed.home, 0)} / {pct(closed.draw, 0)} / {pct(closed.away, 0)}
                {pairing.market && (
                  <>
                    {" "}
                    · market {pct(pairing.market.home, 0)} / {pct(pairing.market.draw, 0)} /{" "}
                    {pct(pairing.market.away, 0)}
                  </>
                )}
              </div>
              {(homeSquad.data && !homeSquad.data.rosterLive) ||
              (awaySquad.data && !awaySquad.data.rosterLive) ? (
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  ESPN's roster did not answer for one side; its scorers come from the goal logs
                  alone.
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              {SIZES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setN(s)}
                  className={`border px-3 py-1.5 uppercase tracking-widest ${n === s ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {s.toLocaleString()}
                </button>
              ))}
              <button
                type="button"
                onClick={run}
                disabled={progress !== null}
                className="border border-primary bg-primary px-4 py-1.5 uppercase tracking-widest text-primary-foreground disabled:opacity-60"
              >
                {progress !== null ? `Playing… ${Math.round(progress * 100)}%` : "Kick off"}
              </button>
              <button
                type="button"
                onClick={watchOne}
                className="border border-border px-4 py-1.5 uppercase tracking-widest hover:border-primary hover:text-primary"
              >
                Watch one
              </button>
            </div>
          </div>

          {watched && sides && <Watched w={watched} sides={sides} names={names} />}
          {batch && batch.n > 0 && sides && (
            <Results
              b={batch}
              sides={sides}
              names={names}
              closed={closed}
              market={pairing.market}
              knockout={knockout}
            />
          )}
          {!batch && !watched && (
            <div className="px-5 py-8 font-mono text-xs text-muted-foreground">
              Choose how many matches to play and kick off. 100,000 take a second or two.
            </div>
          )}
        </section>
      )}
    </SoccerShell>
  );
}

function simRps(): string {
  const bt = SOCCER_SIM.backtest as { simulator?: { rps: number } } | undefined;
  return bt?.simulator ? bt.simulator.rps.toFixed(4) : "—";
}

function FixtureChip({ f, active, onClick }: { f: Fixture; active: boolean; onClick: () => void }) {
  const time = new Date(f.date).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border px-3 py-2 text-left font-mono text-[11px] transition-colors ${active ? "border-primary text-primary" : "border-border text-foreground hover:border-primary"}`}
    >
      <div className="uppercase tracking-widest text-muted-foreground">
        {f.completed ? `FT ${f.homeGoals}-${f.awayGoals}` : time}
      </div>
      <div className="mt-0.5">
        {f.home.abbr} v {f.away.abbr}
      </div>
    </button>
  );
}

function ClubSelect({
  clubs,
  value,
  onChange,
}: {
  clubs: { id: string; name: string; rating: number }[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="min-w-48 border border-border bg-background px-2 py-1.5 text-foreground"
    >
      <option value="">Any club…</option>
      {clubs.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({Math.round(c.rating)})
        </option>
      ))}
    </select>
  );
}

function ScoreInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={0}
      max={15}
      value={value}
      onChange={(e) => onChange(Math.max(0, Math.min(15, Number(e.target.value) || 0)))}
      className="w-12 border border-border bg-background px-1 py-0.5 text-center"
    />
  );
}

// ------------------------------------------------------------------ results

function Results({
  b,
  sides,
  names,
  closed,
  market,
  knockout,
}: {
  b: SoccerBatch;
  sides: [SoccerSide, SoccerSide];
  names: Map<string, string>;
  closed: ReturnType<typeof priceRates>;
  market: Fixture["market"] | null;
  knockout: boolean;
}) {
  const N = b.n;
  const p = { home: b.home / N, draw: b.draw / N, away: b.away / N };
  const scores: { s: string; p: number }[] = [];
  b.scores.forEach((row, i) =>
    row.forEach((c, j) => c && scores.push({ s: `${i}-${j}`, p: c / N })),
  );
  scores.sort((x, y) => y.p - x.p);
  const bins: Bin[] = b.totals.map((c, x) => ({ x, p: c / N, color: NEUTRAL_SERIES }));
  const overs = [0.5, 1.5, 2.5, 3.5, 4.5].map((line) => ({
    line,
    p: b.totals.reduce((s, c, x) => s + (x > line ? c : 0), 0) / N,
  }));
  const maxCell = Math.max(...b.scores.flat()) / N;

  return (
    <div className="divide-y divide-border">
      <div className="grid gap-px bg-border sm:grid-cols-3">
        <Outcome
          label={`${sides[0].name} win`}
          p={p.home}
          n={N}
          closed={closed.home}
          market={market?.home}
        />
        <Outcome label="Draw" p={p.draw} n={N} closed={closed.draw} market={market?.draw} />
        <Outcome
          label={`${sides[1].name} win`}
          p={p.away}
          n={N}
          closed={closed.away}
          market={market?.away}
        />
      </div>

      <div className="grid gap-6 px-5 py-5 md:grid-cols-2">
        <div>
          <H>Average score</H>
          <div className="font-display text-4xl">
            {(b.homeGoals / N).toFixed(2)} – {(b.awayGoals / N).toFixed(2)}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
            {overs.map((o) => (
              <Row key={o.line} k={`Over ${o.line}`} v={pct(o.p)} />
            ))}
            <Row k="Both teams score" v={pct(b.bttsYes / N)} />
            <Row k={`${sides[0].abbr} clean sheet`} v={pct(b.homeCleanSheet / N)} />
            <Row k={`${sides[1].abbr} clean sheet`} v={pct(b.awayCleanSheet / N)} />
            {knockout && (
              <>
                <Row k={`${sides[0].abbr} go through`} v={pct(b.advanceHome / N)} />
                <Row k={`${sides[1].abbr} go through`} v={pct(1 - b.advanceHome / N)} />
                <Row k="Extra time" v={pct(b.extraTime / N)} />
                <Row k="Penalties" v={pct(b.shootouts / N)} />
              </>
            )}
          </div>
        </div>
        <div>
          <H>Total goals</H>
          <Histogram
            bins={bins}
            height={170}
            xFmt={(x) => (x === 10 ? "10+" : String(x))}
            describe={(bin) => [pct(bin.p), `${bin.x === 10 ? "10+" : bin.x} goals`]}
            ariaLabel="Distribution of total goals"
          />
          <BinTable bins={bins} xLabel="Goals" xFmt={(x) => (x === 10 ? "10+" : String(x))} />
        </div>
      </div>

      <div className="grid gap-6 px-5 py-5 md:grid-cols-2">
        <div>
          <H>Likeliest scores (90 minutes)</H>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
            {scores.slice(0, 12).map((s) => (
              <Row key={s.s} k={s.s} v={`${pct(s.p)} · ${fairOdds(s.p)}`} />
            ))}
          </div>
        </div>
        <div>
          <H>
            Score grid — {sides[0].abbr} down, {sides[1].abbr} across
          </H>
          <table className="w-full border-collapse font-mono text-[10px] tabular-nums">
            <thead>
              <tr>
                <th />
                {[0, 1, 2, 3, 4, 5].map((j) => (
                  <th key={j} className="px-1 py-0.5 text-muted-foreground">
                    {j}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <tr key={i}>
                  <th className="px-1 text-muted-foreground">{i}</th>
                  {[0, 1, 2, 3, 4, 5].map((j) => {
                    const v = b.scores[i][j] / N;
                    return (
                      <td
                        key={j}
                        className="border border-border/50 px-1 py-1 text-center"
                        style={{
                          background: `color-mix(in oklab, var(--color-primary) ${Math.round((v / maxCell) * 45)}%, transparent)`,
                        }}
                      >
                        {(v * 100).toFixed(1)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-6 px-5 py-5 md:grid-cols-2">
        {sides.map((side) => (
          <ScorerTable key={side.name} side={side} b={b} names={names} />
        ))}
      </div>
    </div>
  );
}

function Outcome({
  label,
  p,
  n,
  closed,
  market,
}: {
  label: string;
  p: number;
  n: number;
  closed: number;
  market?: number;
}) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-4xl">{pct(p)}</div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        ± {pct(moeP(p, n))} · fair {fairOdds(p)}
      </div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        closed form {pct(closed)}
        {market !== undefined && <> · market {pct(market)}</>}
      </div>
    </div>
  );
}

function ScorerTable({
  side,
  b,
  names,
}: {
  side: SoccerSide;
  b: SoccerBatch;
  names: Map<string, string>;
}) {
  const rows = side.scorers
    .map((s) => ({
      id: s.id,
      name: names.get(s.id) ?? s.name,
      pos: s.pos,
      share: s.share,
      anytime: (b.anytime[s.id] ?? 0) / b.n,
      two: (b.twoPlus[s.id] ?? 0) / b.n,
      first: (b.first[s.id] ?? 0) / b.n,
    }))
    .sort((x, y) => y.anytime - x.anytime)
    .slice(0, 10);
  return (
    <div>
      <H>{side.name} — goalscorers</H>
      {rows.length === 0 ? (
        <div className="font-mono text-[11px] text-muted-foreground">Loading the squad…</div>
      ) : (
        <table className="w-full font-mono text-[11px] tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-normal">Player</th>
              <th className="py-1 text-right font-normal">Share</th>
              <th className="py-1 text-right font-normal">Anytime</th>
              <th className="py-1 text-right font-normal">2+</th>
              <th className="py-1 text-right font-normal">First</th>
              <th className="py-1 text-right font-normal">Fair</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/40">
                <td className="py-1">
                  {r.name} <span className="text-muted-foreground">{r.pos}</span>
                </td>
                <td className="py-1 text-right text-muted-foreground">{pct(r.share, 0)}</td>
                <td className="py-1 text-right text-foreground">{pct(r.anytime)}</td>
                <td className="py-1 text-right">{pct(r.two)}</td>
                <td className="py-1 text-right">{pct(r.first)}</td>
                <td className="py-1 text-right text-muted-foreground">{fairOdds(r.anytime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Watched({
  w,
  sides,
  names,
}: {
  w: { events: MatchEvent[]; hg: number; ag: number; note: string };
  sides: [SoccerSide, SoccerSide];
  names: Map<string, string>;
}) {
  let h = 0;
  let a = 0;
  return (
    <div className="border-b border-border px-5 py-5">
      <H>One match, minute by minute</H>
      <div className="font-display text-3xl">
        {sides[0].name} {w.hg} – {w.ag} {sides[1].name}
      </div>
      {w.note && <div className="mt-1 font-mono text-[11px] text-muted-foreground">{w.note}</div>}
      <ol className="mt-3 space-y-1 font-mono text-[12px]">
        {w.events.length === 0 && (
          <li className="text-muted-foreground">No goals, no red cards.</li>
        )}
        {w.events.map((e, i) => {
          const team = e.side === "home" ? sides[0] : sides[1];
          if (e.kind !== "red") {
            if (e.side === "home") h += 1;
            else a += 1;
          }
          const who =
            e.kind === "red"
              ? `Red card — ${team.name}`
              : e.kind === "own"
                ? `Own goal — ${team.name}`
                : `${names.get(e.player ?? "") ?? team.name} (${team.abbr})`;
          return (
            <li key={i} className="flex gap-3">
              <span className="w-12 shrink-0 text-right text-muted-foreground">
                {e.minute}&apos;
              </span>
              <span className={e.kind === "red" ? "text-red-500" : "text-foreground"}>
                {e.kind === "red" ? "■" : "●"} {who}
              </span>
              {e.kind !== "red" && (
                <span className="text-muted-foreground">
                  {h}-{a}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-border/40 py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground">{v}</span>
    </div>
  );
}
