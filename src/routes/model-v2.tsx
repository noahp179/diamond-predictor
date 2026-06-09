import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { getModelV2Games, runBacktest } from "@/lib/mlb.functions";
import type { PredictedGameV4 } from "@/lib/mlb-core-v4";

export const Route = createFileRoute("/model-v2")({
  head: () => ({
    meta: [
      { title: "Model V2 — Diamond Edge Enhanced Predictions" },
      {
        name: "description",
        content:
          "Side-by-side comparison of v0.3 baseline and v0.4 enhanced predictions. New features: OPS, WHIP, rest days, L5 form, head-to-head.",
      },
    ],
  }),
  component: ModelV2Page,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pct(p: number) {
  return `${(p * 100).toFixed(1)}%`;
}

function delta(v4: number, v3: number) {
  const d = (v4 - v3) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function ModelV2Page() {
  const [date, setDate] = useState(todayISO());
  const fetchV2Games = useServerFn(getModelV2Games);
  const runBacktestFn = useServerFn(runBacktest);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["model-v2-games", date],
    queryFn: () => fetchV2Games({ data: { date } }),
    staleTime: 5 * 60_000,
  });

  const backtest = useMutation({
    mutationFn: (days: number) => runBacktestFn({ data: { days } }),
  });

  const games = (data?.games ?? []) as PredictedGameV4[];

  return (
    <div className="min-h-screen">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Diamond Edge · Model V2
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">
              Model V2
            </h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Enhanced predictions with 5 new signals: team OPS, staff WHIP, rest days,
              last-5 form, and head-to-head record — all from the free MLB Stats API.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-border bg-secondary px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              ← Slate
            </Link>
            <Link
              to="/model"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Model card
            </Link>
          </div>
        </div>

        {/* ── Feature badges ──────────────────────────────────────────────── */}
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto flex max-w-6xl flex-wrap gap-3 px-6 py-4">
            {[
              { label: "OPS gap", hint: "Batting quality" },
              { label: "WHIP gap", hint: "Staff + bullpen" },
              { label: "Rest days", hint: "Fatigue signal" },
              { label: "L5 form", hint: "Hot/cold streak" },
              { label: "H2H record", hint: "Season series" },
            ].map((f) => (
              <div
                key={f.label}
                className="border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px]"
              >
                <span className="text-primary">{f.label}</span>
                <span className="ml-2 text-muted-foreground">{f.hint}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        {/* ── What We're Checking panel ───────────────────────────────────── */}
        <WhatWeChecking backtest={backtest} />

        {/* ── Loading / error / empty states ─────────────────────────────── */}
        {isLoading && <SkeletonGrid />}
        {isError && (
          <div className="border border-destructive/40 bg-destructive/10 p-6 font-mono text-sm text-destructive-foreground">
            Failed to load v0.4 predictions. The MLB Stats API may be unreachable or
            the v0.4 pipeline timed out. Try refreshing or picking an earlier date.
          </div>
        )}
        {!isLoading && !isError && games.length === 0 && (
          <div className="border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">No games found</div>
            <p className="mt-2 font-mono text-sm text-muted-foreground">
              No scheduled games for {date}. The v0.4 pipeline fetches live from MLB Stats API —
              it may take a few seconds.
            </p>
          </div>
        )}

        {/* ── Game comparison cards ───────────────────────────────────────── */}
        <div className="grid gap-4 md:grid-cols-2">
          {games.map((g) => (
            <ComparisonCard key={g.gameId} game={g} />
          ))}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          Data · MLB Stats API (statsapi.mlb.com) · Model V2 = baseline-v0.4 · Not affiliated with MLB
        </div>
      </footer>
    </div>
  );
}

// ─── What We're Checking ──────────────────────────────────────────────────────

function WhatWeChecking({ backtest }: { backtest: any }) {
  const result = backtest.data as any;

  return (
    <section className="border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          What We're Checking — Model Comparison
        </span>
        <button
          id="run-backtest-btn"
          onClick={() => backtest.mutate(7 as any)}
          disabled={backtest.isPending}
          className="border border-primary bg-primary px-4 py-1.5 font-mono text-[11px] uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {backtest.isPending ? "Running…" : "Run 7-day backtest"}
        </button>
      </div>

      <div className="p-5">
        {!result && !backtest.isPending && (
          <p className="font-mono text-sm text-muted-foreground">
            Click "Run 7-day backtest" to compare v0.3 vs v0.4 on recent settled games.
            Uses only the free MLB Stats API — no database required. Takes ~30–60s.
          </p>
        )}

        {backtest.isPending && (
          <div className="flex items-center gap-3 font-mono text-sm text-muted-foreground">
            <span className="animate-spin">⟳</span>
            Fetching historical games and running both models. This may take up to 60 seconds…
          </div>
        )}

        {result && !backtest.isPending && (
          <div className="space-y-4">
            <p className="font-mono text-xs text-muted-foreground">
              {result.startDate} → {result.endDate} · {result.settledGames} settled games
              of {result.totalGames} total
            </p>

            {result.settledGames === 0 ? (
              <p className="font-mono text-sm text-muted-foreground">
                No settled games in this window. Try clicking "Run 7-day backtest" after some games complete, or pick an earlier date in the slate picker.
              </p>
            ) : (
              <>
                {/* Comparison table */}
                <div className="overflow-x-auto">
                  <table className="w-full font-mono text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                        <th className="pb-2 pr-6">Model</th>
                        <th className="pb-2 pr-6">Correct</th>
                        <th className="pb-2 pr-6">Accuracy</th>
                        <th className="pb-2 pr-6">Brier ↓</th>
                        <th className="pb-2">Log-Loss ↓</th>
                      </tr>
                    </thead>
                    <tbody>
                      <MetricRow label={result.modelV3} m={result.v3} />
                      <MetricRow label={result.modelV4} m={result.v4} highlight />
                    </tbody>
                  </table>
                </div>

                {/* Delta row */}
                {result.v3 && result.v4 && (
                  <div className="grid grid-cols-3 gap-3 border-t border-border pt-4">
                    <DeltaStat
                      label="Accuracy Δ"
                      value={((result.v4.accuracy - result.v3.accuracy) * 100).toFixed(1) + "%"}
                      positive={(result.v4.accuracy - result.v3.accuracy) >= 0}
                    />
                    <DeltaStat
                      label="Brier Δ"
                      value={(result.v4.brier - result.v3.brier).toFixed(4)}
                      positive={(result.v4.brier - result.v3.brier) <= 0}
                      lowerBetter
                    />
                    <DeltaStat
                      label="Log-Loss Δ"
                      value={(result.v4.logLoss - result.v3.logLoss).toFixed(4)}
                      positive={(result.v4.logLoss - result.v3.logLoss) <= 0}
                      lowerBetter
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function MetricRow({
  label,
  m,
  highlight,
}: {
  label: string;
  m: { correct: number; accuracy: number; brier: number; logLoss: number } | null;
  highlight?: boolean;
}) {
  if (!m) return null;
  return (
    <tr className={`border-b border-border/40 ${highlight ? "text-foreground" : "text-muted-foreground"}`}>
      <td className="py-2 pr-6 font-mono text-xs">
        {highlight && <span className="mr-1 text-primary">▶</span>}
        {label}
      </td>
      <td className="py-2 pr-6">{m.correct}</td>
      <td className="py-2 pr-6">{pct(m.accuracy)}</td>
      <td className="py-2 pr-6">{m.brier.toFixed(4)}</td>
      <td className="py-2">{m.logLoss.toFixed(4)}</td>
    </tr>
  );
}

function DeltaStat({
  label,
  value,
  positive,
  lowerBetter,
}: {
  label: string;
  value: string;
  positive: boolean;
  lowerBetter?: boolean;
}) {
  const good = lowerBetter ? positive : positive;
  return (
    <div className="border border-border bg-secondary/30 p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-1 font-display text-2xl ${good ? "text-green-400" : "text-red-400"}`}>
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
        {lowerBetter ? "v0.4 vs v0.3 (lower = better)" : "v0.4 vs v0.3"}
      </div>
    </div>
  );
}

// ─── Comparison card ──────────────────────────────────────────────────────────

function ComparisonCard({ game }: { game: PredictedGameV4 }) {
  const [expanded, setExpanded] = useState(false);
  const homeV3 = game.homeWinProb;
  const homeV4 = game.v4WinProb;
  const diff = Math.abs(homeV4 - homeV3);
  const v4FavorsHome = homeV4 >= 0.5;

  return (
    <div
      id={`game-card-v2-${game.gameId}`}
      className="border border-border bg-card hover:border-primary/50 transition-colors"
    >
      {/* Teams row */}
      <div className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {game.venue}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-display text-xl">{game.home.abbreviation}</span>
              <span className="font-mono text-xs text-muted-foreground">vs</span>
              <span className="font-display text-xl">{game.away.abbreviation}</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {game.home.name} · {game.home.record} — {game.away.name} · {game.away.record}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Status
            </div>
            <div className="mt-1 font-mono text-xs text-foreground">{game.status}</div>
          </div>
        </div>
      </div>

      {/* Probability comparison */}
      <div className="grid grid-cols-2 divide-x divide-border border-b border-border/60">
        <ProbCell
          label="v0.3 (baseline)"
          homeProb={homeV3}
          homeAbbr={game.home.abbreviation}
          awayAbbr={game.away.abbreviation}
        />
        <ProbCell
          label="v0.4 (enhanced)"
          homeProb={homeV4}
          homeAbbr={game.home.abbreviation}
          awayAbbr={game.away.abbreviation}
          highlight
        />
      </div>

      {/* Delta bar */}
      {diff >= 0.01 && (
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-2 font-mono text-xs">
          <span className="text-muted-foreground">v0.4 shifts home by</span>
          <span className={homeV4 > homeV3 ? "text-primary" : "text-muted-foreground"}>
            {delta(homeV4, homeV3)} {v4FavorsHome ? "▲" : "▼"}
          </span>
        </div>
      )}

      {/* New feature signals */}
      <FeatureSignals game={game} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </div>
  );
}

function ProbCell({
  label,
  homeProb,
  homeAbbr,
  awayAbbr,
  highlight,
}: {
  label: string;
  homeProb: number;
  homeAbbr: string;
  awayAbbr: string;
  highlight?: boolean;
}) {
  const favorHome = homeProb >= 0.5;
  const favProb = favorHome ? homeProb : 1 - homeProb;
  const favTeam = favorHome ? homeAbbr : awayAbbr;

  return (
    <div className={`px-4 py-3 ${highlight ? "bg-primary/5" : ""}`}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`font-display text-3xl ${highlight ? "text-primary" : "text-foreground"}`}>
          {pct(favProb)}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{favTeam}</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full ${highlight ? "bg-primary" : "bg-foreground/40"}`}
          style={{ width: `${homeProb * 100}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground">
        <span>{homeAbbr} {pct(homeProb)}</span>
        <span>{awayAbbr} {pct(1 - homeProb)}</span>
      </div>
    </div>
  );
}

function FeatureSignals({
  game,
  expanded,
  onToggle,
}: {
  game: PredictedGameV4;
  expanded: boolean;
  onToggle: () => void;
}) {
  const f = game.features;
  const signals = [
    {
      label: "OPS",
      home: f.homeHitting.ops?.toFixed(3) ?? "—",
      away: f.awayHitting.ops?.toFixed(3) ?? "—",
      edge: f.homeHitting.ops != null && f.awayHitting.ops != null
        ? f.homeHitting.ops > f.awayHitting.ops ? "home" : f.homeHitting.ops < f.awayHitting.ops ? "away" : null
        : null,
    },
    {
      label: "WHIP",
      home: f.homePitching.whip?.toFixed(2) ?? "—",
      away: f.awayPitching.whip?.toFixed(2) ?? "—",
      edge: f.homePitching.whip != null && f.awayPitching.whip != null
        ? f.homePitching.whip < f.awayPitching.whip ? "home" : f.homePitching.whip > f.awayPitching.whip ? "away" : null
        : null,
    },
    {
      label: "Rest",
      home: `${f.homeRest.daysSinceLastGame}d`,
      away: `${f.awayRest.daysSinceLastGame}d`,
      edge: f.homeRest.daysSinceLastGame > f.awayRest.daysSinceLastGame ? "home"
        : f.homeRest.daysSinceLastGame < f.awayRest.daysSinceLastGame ? "away" : null,
    },
    {
      label: "L5",
      home: `${f.homeL5.wins}-${f.homeL5.losses}`,
      away: `${f.awayL5.wins}-${f.awayL5.losses}`,
      edge: f.homeL5.pct > f.awayL5.pct ? "home" : f.homeL5.pct < f.awayL5.pct ? "away" : null,
    },
    {
      label: "H2H",
      home: String(f.h2h.homeWins),
      away: String(f.h2h.awayWins),
      edge: f.h2h.totalGames >= 2
        ? f.h2h.homeWins > f.h2h.awayWins ? "home" : f.h2h.homeWins < f.h2h.awayWins ? "away" : null
        : null,
    },
  ];

  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-2.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>New features ({signals.filter((s) => s.edge).length} signals)</span>
        <span>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-5 py-3">
          <div className="grid grid-cols-5 gap-2">
            {signals.map((s) => (
              <div key={s.label} className="text-center">
                <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                  {s.label}
                </div>
                <div
                  className={`mt-1 font-mono text-xs ${s.edge === "home" ? "text-primary" : s.edge === "away" ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {s.home}
                </div>
                <div className="my-0.5 font-mono text-[9px] text-muted-foreground">vs</div>
                <div
                  className={`font-mono text-xs ${s.edge === "away" ? "text-primary" : s.edge === "home" ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {s.away}
                </div>
                {s.edge && (
                  <div className="mt-1 font-mono text-[8px] uppercase tracking-widest text-primary">
                    {s.edge} ▲
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* v0.4 rationale */}
          <div className="mt-3 border-t border-border/40 pt-3">
            <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
              v0.4 log-odds breakdown
            </div>
            <ul className="space-y-0.5">
              {game.v4Rationale.map((r, i) => (
                <li key={i} className="font-mono text-[10px] text-muted-foreground">
                  · {r}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-64 animate-pulse border border-border bg-card" />
      ))}
    </div>
  );
}
