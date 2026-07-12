import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getTrackRecord, type ModelTrack, type TrackedGame } from "@/lib/mlb.functions";
import { TRACKED_MODELS, TRACK_RECORD_START } from "@/lib/mlb-models";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Track Record — Diamond Edge" },
      {
        name: "description",
        content:
          "Accuracy, Brier score, log loss, and betting returns at the stored odds for every model — sim-elo-v2, odds-blend-v1, the devigged market, and the baseline — tracked from " +
          TRACK_RECORD_START +
          " forward.",
      },
    ],
  }),
  component: HistoryPage,
});

type Segment = "all" | "recommended" | "best_odds";
const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All games",
  recommended: "Recommended",
  best_odds: "Best Odds",
};
const CHIP_COLOR = {
  recommended: "var(--color-chart-2)",
  best_odds: "var(--color-chart-3)",
};

const MODEL_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

function modelLabel(version: string): string {
  return TRACKED_MODELS.find((m) => m.version === version)?.label ?? version;
}

function modelNote(version: string): string | null {
  return TRACKED_MODELS.find((m) => m.version === version)?.note ?? null;
}

function pct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number | null | undefined, digits = 3) {
  return n != null ? n.toFixed(digits) : "—";
}

function HistoryPage() {
  const fetchTrackRecord = useServerFn(getTrackRecord);
  const { data, isLoading } = useQuery({
    queryKey: ["track-record"],
    queryFn: () => fetchTrackRecord(),
    staleTime: 5 * 60_000,
  });

  const models: ModelTrack[] = React.useMemo(() => data?.models ?? [], [data]);
  const games: TrackedGame[] = React.useMemo(() => data?.games ?? [], [data]);
  const primaryModel = data?.primaryModel ?? "sim-elo-v2";
  const trackingSince = data?.trackingSince ?? TRACK_RECORD_START;
  const segments = data?.segments ?? null;

  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);
  const selected = selectedModel ?? primaryModel;
  const [activeTab, setActiveTab] = React.useState<"graphs" | "history">("graphs");
  const [tableFilter, setTableFilter] = React.useState<Segment>("all");

  const colorOf = React.useMemo(() => {
    const map = new Map<string, string>();
    models.forEach((m, i) => map.set(m.version, MODEL_COLORS[i % MODEL_COLORS.length]));
    return (version: string) => map.get(version) ?? MODEL_COLORS[0];
  }, [models]);

  const totalSettled = models.reduce((a, m) => a + m.settled.n, 0);
  const totalPending = models.reduce((a, m) => a + m.pending, 0);

  // One chart row per date; columns per model for accuracy and Brier.
  const mergedDaily = React.useMemo(() => {
    const byDate = new Map<string, Record<string, number | string | null>>();
    for (const m of models) {
      for (const d of m.daily) {
        const row = byDate.get(d.date) ?? { date: d.date };
        row[`${m.version}_accuracy`] =
          d.accuracy != null ? Number((d.accuracy * 100).toFixed(1)) : null;
        row[`${m.version}_brier`] = d.brier != null ? Number(d.brier.toFixed(4)) : null;
        byDate.set(d.date, row);
      }
    }
    return Array.from(byDate.values()).sort((a, b) =>
      (a.date as string) < (b.date as string) ? -1 : 1,
    );
  }, [models]);

  const returns = React.useMemo(
    () =>
      calculateReturns(
        games,
        models.map((m) => m.version),
      ),
    [games, models],
  );

  const filteredGames = React.useMemo(() => {
    const withSelected = games.filter((g) => g.models[selected]);
    if (tableFilter === "all") return withSelected;
    return withSelected.filter((g) =>
      tableFilter === "recommended" ? g.isRecommended : g.isBestOdds,
    );
  }, [games, selected, tableFilter]);

  const calibration = React.useMemo(() => calculateCalibration(games, selected), [games, selected]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Track Record · tracking since {trackingSince}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Box Score</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every model we run — the simulator ensemble, the odds blend, the devigged market line,
              and the legacy baseline — scored identically on every settled game since{" "}
              {trackingSince}.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Today's slate
            </Link>
            <Link
              to="/history"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
              aria-current="page"
            >
              Track record
            </Link>
            <Link
              to="/teams"
              className="border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground hover:border-primary"
            >
              Teams
            </Link>
            <Link
              to="/algorithm-v2"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Algorithm V2
            </Link>
            <Link
              to="/model"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Recommended
            </Link>
            <Link
              to="/best-odds"
              className="border border-primary/60 bg-primary/10 px-4 py-2 font-mono text-xs uppercase tracking-widest text-primary hover:border-primary"
            >
              Best Odds
            </Link>
          </div>
        </div>

        {/* Model scoreboard — every tracked model, click to inspect */}
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
            {models.map((m) => (
              <button
                key={m.version}
                onClick={() => setSelectedModel(m.version)}
                className={`px-6 py-4 text-left transition-colors ${selected === m.version ? "bg-card" : "hover:bg-card/50"}`}
              >
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: colorOf(m.version) }}
                  />
                  {modelLabel(m.version)}
                  {selected === m.version && <span className="text-primary">· selected</span>}
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  <MiniStat label="Acc" value={pct(m.settled.accuracy)} />
                  <MiniStat label="Brier" value={num(m.settled.brier)} />
                  <MiniStat label="n" value={`${m.settled.n}`} />
                  <MiniStat label="Pending" value={`${m.pending}`} />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Primary-model page-pick segments */}
        {segments && (
          <div className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <span className="text-primary">{modelLabel(primaryModel)} page picks</span>
              {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
                <span key={seg}>
                  {SEGMENT_LABEL[seg]}:{" "}
                  <span className="text-foreground">{pct(segments[seg]?.accuracy)}</span>
                  <span> · n={segments[seg]?.n ?? 0}</span>
                </span>
              ))}
              <span className="normal-case tracking-normal">
                (Best Odds picks scored with odds-blend-v1)
              </span>
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Tab Controls */}
        <div className="border-b border-border pb-4">
          <div className="-mb-px flex flex-wrap">
            <button
              onClick={() => setActiveTab("graphs")}
              className={`inline-flex items-center border-b-2 border-transparent px-4 py-2 text-sm font-medium ${
                activeTab === "graphs"
                  ? "border-primary text-primary"
                  : "text-muted-foreground hover:border-primary/50 hover:text-primary"
              }`}
            >
              Graphs
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`ml-4 inline-flex items-center border-b-2 border-transparent px-4 py-2 text-sm font-medium ${
                activeTab === "history"
                  ? "border-primary text-primary"
                  : "text-muted-foreground hover:border-primary/50 hover:text-primary"
              }`}
            >
              Game History
            </button>
          </div>
        </div>

        {isLoading && <div className="mt-4 h-72 animate-pulse border border-border bg-card" />}

        {!isLoading && totalSettled === 0 && (
          <div className="mt-4 border border-border bg-card p-10 text-center">
            <div className="font-display text-3xl">
              {totalPending > 0 ? "First results settle tonight" : "Waiting for the first run"}
            </div>
            <p className="mx-auto mt-2 max-w-xl font-mono text-sm text-muted-foreground">
              Tracking started {trackingSince}.{" "}
              {totalPending > 0
                ? `${totalPending} predictions are recorded across ${models.filter((m) => m.pending > 0).length} models for the current slate — they'll be scored as games go final.`
                : "The daily pipeline hasn't recorded today's predictions yet — trigger it (or revive the cron) to start the clock."}
            </p>
          </div>
        )}

        {activeTab === "graphs" && !isLoading && totalSettled > 0 && (
          <>
            <ChartCard title="Cumulative return by model — flat 1u on every pick at the stored line">
              {returns.rows.length > 0 ? (
                <>
                  <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    {returns.totals.map((t) => (
                      <span key={t.version} className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: colorOf(t.version) }}
                        />
                        {modelLabel(t.version)}:{" "}
                        <span className={t.units >= 0 ? "text-emerald-500" : "text-red-500"}>
                          {fmtUnits(t.units)}
                        </span>
                        <span>
                          · ROI {t.roi != null ? `${(t.roi * 100).toFixed(1)}%` : "—"} · {t.bets}{" "}
                          bets
                        </span>
                      </span>
                    ))}
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={returns.rows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                      <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} />
                      <YAxis
                        stroke="var(--color-muted-foreground)"
                        fontSize={11}
                        tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}u`}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--color-card)",
                          border: "1px solid var(--color-border)",
                          fontFamily: "var(--font-mono)",
                        }}
                        formatter={(value) => `${Number(value) >= 0 ? "+" : ""}${value}u`}
                      />
                      <Legend
                        wrapperStyle={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      />
                      <ReferenceLine
                        y={0}
                        stroke="var(--color-muted-foreground)"
                        strokeDasharray="4 4"
                      />
                      {returns.totals.map((t) => (
                        <Line
                          key={t.version}
                          type="monotone"
                          dataKey={`${t.version}_units`}
                          name={modelLabel(t.version)}
                          stroke={colorOf(t.version)}
                          strokeWidth={selected === t.version ? 2.5 : 1.5}
                          strokeOpacity={selected === t.version ? 1 : 0.35}
                          dot={{ r: selected === t.version ? 3 : 2 }}
                          connectNulls
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                  <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                    1 unit staked on each model's pick, settled at the stored DraftKings moneyline
                    for that side. Games with no cached line are skipped for every model, so the
                    curves compare on the same slate.
                  </p>
                </>
              ) : (
                <div className="flex h-40 items-center justify-center text-muted-foreground">
                  No settled picks with a stored line yet — returns plot once games with cached odds
                  go final.
                </div>
              )}
            </ChartCard>

            <ChartCard title={`Daily accuracy by model — ${modelLabel(selected)} emphasized`}>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={mergedDaily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <YAxis
                    domain={[0, 100]}
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    unit="%"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  <Legend
                    wrapperStyle={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  />
                  {models.map((m) => (
                    <Line
                      key={m.version}
                      type="monotone"
                      dataKey={`${m.version}_accuracy`}
                      name={modelLabel(m.version)}
                      stroke={colorOf(m.version)}
                      strokeWidth={selected === m.version ? 2.5 : 1.5}
                      strokeOpacity={selected === m.version ? 1 : 0.35}
                      dot={{ r: selected === m.version ? 3 : 2 }}
                      connectNulls
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Daily Brier score by model (lower is better)">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={mergedDaily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={11} />
                  <YAxis stroke="var(--color-muted-foreground)" fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                  <Legend
                    wrapperStyle={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  />
                  {models.map((m) => (
                    <Line
                      key={m.version}
                      type="monotone"
                      dataKey={`${m.version}_brier`}
                      name={modelLabel(m.version)}
                      stroke={colorOf(m.version)}
                      strokeWidth={selected === m.version ? 2.5 : 1.5}
                      strokeOpacity={selected === m.version ? 1 : 0.35}
                      dot={{ r: selected === m.version ? 3 : 2 }}
                      connectNulls
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title={`Calibration — ${modelLabel(selected)}: predicted vs actual win rate`}
            >
              <ResponsiveContainer width="100%" height={260}>
                {calibration.length > 0 ? (
                  <BarChart data={calibration}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="bucket" stroke="var(--color-muted-foreground)" fontSize={11} />
                    <YAxis
                      domain={[0, 1]}
                      stroke="var(--color-muted-foreground)"
                      fontSize={11}
                      tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-card)",
                        border: "1px solid var(--color-border)",
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                    <Bar
                      dataKey="actual"
                      fill={colorOf(selected)}
                      barSize={28}
                      radius={[4, 4, 0, 0]}
                    />
                    <Line
                      type="monotone"
                      dataKey="ideal"
                      stroke="var(--color-muted-foreground)"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                      dot={false}
                    />
                  </BarChart>
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    Not enough settled {modelLabel(selected)} games for a calibration chart
                  </div>
                )}
              </ResponsiveContainer>
            </ChartCard>
          </>
        )}

        {activeTab === "history" && !isLoading && totalSettled > 0 && (
          <>
            <div className="mb-4 mt-4 flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-widest">
              <span className="text-muted-foreground">
                {modelLabel(selected)}
                {modelNote(selected) ? ` — ${modelNote(selected)}` : ""} ·
              </span>
              {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
                <button
                  key={seg}
                  onClick={() => setTableFilter(seg)}
                  className={`border px-3 py-1.5 ${
                    tableFilter === seg
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {SEGMENT_LABEL[seg]}
                </button>
              ))}
            </div>
            {filteredGames.length > 0 ? (
              <section className="border border-border bg-card">
                <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {modelLabel(selected)} — settled predictions ({filteredGames.length} games)
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/40 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">Date</th>
                        <th className="px-4 py-2.5 font-medium">Matchup</th>
                        <th className="px-4 py-2.5 font-medium">Predicted</th>
                        <th className="px-4 py-2.5 font-medium">Final Score</th>
                        <th className="px-4 py-2.5 font-medium">Result</th>
                        <th className="px-4 py-2.5 font-medium">Picks</th>
                        <th className="px-4 py-2.5 font-medium text-right">Brier</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredGames.map((g) => {
                        const s = g.models[selected];
                        const predictedWinner = s.prob >= 0.5 ? g.home : g.away;
                        const predictedProb = s.prob >= 0.5 ? s.prob : 1 - s.prob;
                        return (
                          <tr
                            key={g.gameId}
                            className="border-b border-border/20 hover:bg-secondary/10"
                          >
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className="font-mono text-xs text-muted-foreground">
                                {g.date}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className="font-display">
                                {g.away} @ {g.home}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className="font-display">{predictedWinner}</span>
                              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                                {(predictedProb * 100).toFixed(0)}%
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                              {g.homeScore != null && g.awayScore != null
                                ? `${g.awayScore}–${g.homeScore}`
                                : "—"}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              {s.correct == null ? (
                                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                                  Pending
                                </span>
                              ) : (
                                <span
                                  className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                                    s.correct
                                      ? "bg-emerald-500/10 text-emerald-600"
                                      : "bg-red-500/10 text-red-500"
                                  }`}
                                >
                                  {s.correct ? "✓ Correct" : "✗ Miss"}
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <div className="flex gap-1.5">
                                {g.isRecommended && (
                                  <SegmentChip color={CHIP_COLOR.recommended} label="Rec" />
                                )}
                                {g.isBestOdds && (
                                  <SegmentChip color={CHIP_COLOR.best_odds} label="Odds" />
                                )}
                                {!g.isRecommended && !g.isBestOdds && (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </div>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                              {num(s.brier)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <div className="border border-border bg-card p-10 text-center">
                <div className="font-display text-3xl">No settled games in this view</div>
                <p className="mt-2 font-mono text-sm text-muted-foreground">
                  {modelLabel(selected)} has no settled predictions
                  {tableFilter !== "all"
                    ? ` in the ${SEGMENT_LABEL[tableFilter]} segment`
                    : ""}{" "}
                  since {trackingSince}.
                </p>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-display text-lg text-foreground">{value}</div>
    </div>
  );
}

function SegmentChip({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground"
      style={{ background: `color-mix(in oklch, ${color} 18%, transparent)` }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Winning a 1u flat bet at an American moneyline pays this profit. */
function moneylineProfit(ml: number): number {
  return ml > 0 ? ml / 100 : 100 / -ml;
}

function fmtUnits(u: number): string {
  return `${u >= 0 ? "+" : ""}${u.toFixed(2)}u`;
}

/**
 * Cumulative flat-stake returns per model: 1u on the model's pick of every
 * settled game, paid at the stored moneyline for that side. Games without a
 * cached line are skipped — the same slate for every model, so the curves
 * compare fairly.
 */
function calculateReturns(games: TrackedGame[], versions: string[]) {
  const running = new Map(versions.map((v) => [v, { units: 0, bets: 0, wins: 0 }]));
  const byDate = new Map<string, TrackedGame[]>();
  for (const g of [...games].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const arr = byDate.get(g.date) ?? [];
    arr.push(g);
    byDate.set(g.date, arr);
  }

  const rows: Array<Record<string, number | string | null>> = [];
  for (const [date, dayGames] of byDate) {
    let settledBets = false;
    for (const g of dayGames) {
      for (const v of versions) {
        const s = g.models[v];
        if (!s || s.correct == null) continue;
        const ml = s.prob >= 0.5 ? g.homeMoneyline : g.awayMoneyline;
        if (ml == null || ml === 0) continue;
        const r = running.get(v)!;
        r.bets++;
        if (s.correct) {
          r.wins++;
          r.units += moneylineProfit(ml);
        } else {
          r.units -= 1;
        }
        settledBets = true;
      }
    }
    if (!settledBets) continue;
    const row: Record<string, number | string | null> = { date };
    for (const v of versions) {
      const r = running.get(v)!;
      row[`${v}_units`] = r.bets > 0 ? Number(r.units.toFixed(2)) : null;
    }
    rows.push(row);
  }

  const totals = versions
    .map((v) => {
      const r = running.get(v)!;
      return {
        version: v,
        units: r.units,
        bets: r.bets,
        wins: r.wins,
        roi: r.bets > 0 ? r.units / r.bets : null,
      };
    })
    .filter((t) => t.bets > 0);
  return { rows, totals };
}

function calculateCalibration(games: TrackedGame[], version: string) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    min: i * 0.1,
    max: (i + 1) * 0.1,
    count: 0,
    correct: 0,
  }));
  games.forEach((game) => {
    const s = game.models[version];
    if (!s || s.correct == null) return;
    const predictedProb = s.prob >= 0.5 ? s.prob : 1 - s.prob;
    const bucketIndex = Math.min(Math.floor(predictedProb * 10), 9);
    buckets[bucketIndex].count += 1;
    if (s.correct) buckets[bucketIndex].correct += 1;
  });
  return buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({
      bucket: `${(bucket.min * 100).toFixed(0)}-${(bucket.max * 100).toFixed(0)}%`,
      actual: bucket.correct / bucket.count,
      ideal: bucket.min + 0.05,
    }));
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 border border-border bg-card">
      <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
