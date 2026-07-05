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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { getTrackRecordSegments, type SegmentedGame } from "@/lib/mlb.functions";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Track Record — Diamond Edge" },
      {
        name: "description",
        content:
          "Historical accuracy, Brier score, and log loss for every MLB prediction, all games, and the Recommended/Best Odds picks specifically.",
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
const SEGMENT_COLOR: Record<Segment, string> = {
  all: "var(--color-chart-1)",
  recommended: "var(--color-chart-2)",
  best_odds: "var(--color-chart-3)",
};

function pct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number | null | undefined, digits = 3) {
  return n != null ? n.toFixed(digits) : "—";
}

function HistoryPage() {
  const fetchSegments = useServerFn(getTrackRecordSegments);
  const { data, isLoading } = useQuery({
    queryKey: ["track-record-segments"],
    queryFn: () => fetchSegments(),
    staleTime: 5 * 60_000,
  });

  const [segment, setSegment] = React.useState<Segment>("all");
  const [activeTab, setActiveTab] = React.useState<"graphs" | "history">("graphs");
  const [tableFilter, setTableFilter] = React.useState<Segment>("all");

  const segments = data?.segments ?? { all: null, recommended: null, best_odds: null };
  const daily = React.useMemo(
    () => data?.daily ?? { all: [], recommended: [], best_odds: [] },
    [data],
  );
  const games: SegmentedGame[] = React.useMemo(() => data?.games ?? [], [data]);
  const comparisonBrier = data?.comparisonBrier ?? null;

  // Merge the three per-segment daily series into one row-per-date table for the trend chart.
  const mergedDaily = React.useMemo(() => {
    const byDate = new Map<string, Record<string, number | string | null>>();
    (["all", "recommended", "best_odds"] as Segment[]).forEach((seg) => {
      for (const d of daily[seg]) {
        const row = byDate.get(d.date) ?? { date: d.date };
        row[`${seg}_accuracy`] = d.accuracy != null ? Number((d.accuracy * 100).toFixed(1)) : null;
        row[`${seg}_brier`] = d.brier;
        row[`${seg}_n`] = d.n;
        byDate.set(d.date, row);
      }
    });
    return Array.from(byDate.values()).sort((a, b) =>
      (a.date as string) < (b.date as string) ? -1 : 1,
    );
  }, [daily]);

  const filteredGames =
    tableFilter === "all"
      ? games
      : games.filter((g) => (tableFilter === "recommended" ? g.isRecommended : g.isBestOdds));

  const calibration = React.useMemo(() => {
    const pool =
      segment === "all"
        ? games
        : games.filter((g) => (segment === "recommended" ? g.isRecommended : g.isBestOdds));
    return calculateCalibration(pool);
  }, [games, segment]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-6 px-6 py-10">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">
              Track Record · {data?.modelVersion ?? "sim-elo-v2"}
              {comparisonBrier != null && (
                <span className="ml-2 normal-case tracking-normal text-muted-foreground">
                  · baseline-v0.4 comparison Brier {num(comparisonBrier, 4)}
                </span>
              )}
            </div>
            <h1 className="mt-2 font-display text-6xl leading-none md:text-7xl">Box Score</h1>
            <p className="mt-3 max-w-xl text-sm text-muted-foreground">
              Every prediction we've made, scored against the final box, split into three honest
              segments: every game, the picks that would have been Recommended that day, and the
              picks that would have been Best Odds that day.
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

        {/* Segment comparison — the "all / recommended / best odds" analytics the header promises */}
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
              <button
                key={seg}
                onClick={() => setSegment(seg)}
                className={`px-6 py-4 text-left transition-colors ${segment === seg ? "bg-card" : "hover:bg-card/50"}`}
              >
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: SEGMENT_COLOR[seg] }}
                  />
                  {SEGMENT_LABEL[seg]}
                  {segment === seg && <span className="text-primary">· selected</span>}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-3">
                  <MiniStat label="Acc" value={pct(segments[seg]?.accuracy)} />
                  <MiniStat label="Brier" value={num(segments[seg]?.brier)} />
                  <MiniStat label="n" value={`${segments[seg]?.n ?? 0}`} />
                </div>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Tab Controls */}
        <div className="border-b border-border pb-4">
          <div className="flex flex-wrap -mb-px">
            <button
              onClick={() => setActiveTab("graphs")}
              className={`inline-flex items-center px-4 py-2 border-b-2 border-transparent text-sm font-medium ${
                activeTab === "graphs"
                  ? "text-primary border-primary"
                  : "text-muted-foreground hover:text-primary hover:border-primary/50"
              }`}
            >
              Graphs
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`inline-flex items-center px-4 py-2 border-b-2 border-transparent text-sm font-medium ml-4 ${
                activeTab === "history"
                  ? "text-primary border-primary"
                  : "text-muted-foreground hover:text-primary hover:border-primary/50"
              }`}
            >
              Game History
            </button>
          </div>
        </div>

        {activeTab === "graphs" && (
          <>
            {isLoading && <div className="h-72 animate-pulse border border-border bg-card" />}
            {!isLoading && mergedDaily.length === 0 && (
              <div className="border border-border bg-card p-10 text-center">
                <div className="font-display text-3xl">No daily metrics yet</div>
                <p className="mt-2 font-mono text-sm text-muted-foreground">
                  Once predictions settle, daily accuracy and Brier charts will appear here.
                </p>
              </div>
            )}
            {!isLoading && mergedDaily.length > 0 && (
              <>
                <ChartCard title={`Daily accuracy — ${SEGMENT_LABEL[segment]} emphasized`}>
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
                      {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
                        <Line
                          key={seg}
                          type="monotone"
                          dataKey={`${seg}_accuracy`}
                          name={SEGMENT_LABEL[seg]}
                          stroke={SEGMENT_COLOR[seg]}
                          strokeWidth={segment === seg ? 2.5 : 1.5}
                          strokeOpacity={segment === seg ? 1 : 0.35}
                          dot={{ r: segment === seg ? 3 : 2 }}
                          connectNulls
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Daily Brier score (lower is better)">
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
                      {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
                        <Line
                          key={seg}
                          type="monotone"
                          dataKey={`${seg}_brier`}
                          name={SEGMENT_LABEL[seg]}
                          stroke={SEGMENT_COLOR[seg]}
                          strokeWidth={segment === seg ? 2.5 : 1.5}
                          strokeOpacity={segment === seg ? 1 : 0.35}
                          dot={{ r: segment === seg ? 3 : 2 }}
                          connectNulls
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard
                  title={`Calibration — ${SEGMENT_LABEL[segment]}: predicted vs actual win rate`}
                >
                  <ResponsiveContainer width="100%" height={260}>
                    {calibration.length > 0 ? (
                      <BarChart data={calibration}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                        <XAxis
                          dataKey="bucket"
                          stroke="var(--color-muted-foreground)"
                          fontSize={11}
                        />
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
                          fill={SEGMENT_COLOR[segment]}
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
                        Not enough {SEGMENT_LABEL[segment].toLowerCase()} data for a calibration
                        chart
                      </div>
                    )}
                  </ResponsiveContainer>
                </ChartCard>
              </>
            )}
          </>
        )}

        {activeTab === "history" && (
          <>
            <div className="mb-4 flex gap-2 font-mono text-xs uppercase tracking-widest">
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
            {isLoading ? (
              <div className="h-48 animate-pulse border border-border bg-card" />
            ) : filteredGames.length > 0 ? (
              <section className="border border-border bg-card">
                <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Settled Predictions ({filteredGames.length} games)
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
                        <th className="px-4 py-2.5 font-medium">Segment</th>
                        <th className="px-4 py-2.5 font-medium text-right">Brier</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredGames.map((g) => (
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
                            <span className="font-display">{g.predictedWinner}</span>
                            <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                              {(g.predictedProb * 100).toFixed(0)}%
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                            {g.homeScore != null && g.awayScore != null
                              ? `${g.awayScore}–${g.homeScore}`
                              : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span
                              className={`inline-block rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
                                g.correct
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : "bg-red-500/10 text-red-500"
                              }`}
                            >
                              {g.correct ? "✓ Correct" : "✗ Miss"}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <div className="flex gap-1.5">
                              {g.isRecommended && (
                                <SegmentChip color={SEGMENT_COLOR.recommended} label="Rec" />
                              )}
                              {g.isBestOdds && (
                                <SegmentChip color={SEGMENT_COLOR.best_odds} label="Odds" />
                              )}
                              {!g.isRecommended && !g.isBestOdds && (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                            {num(g.brier)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <div className="border border-border bg-card p-10 text-center">
                <div className="font-display text-3xl">No settled games yet</div>
                <p className="mt-2 font-mono text-sm text-muted-foreground">
                  The pipeline scores predictions as games go final. Check back tomorrow.
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

function calculateCalibration(games: SegmentedGame[]) {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    min: i * 0.1,
    max: (i + 1) * 0.1,
    count: 0,
    correct: 0,
  }));
  games.forEach((game) => {
    if (game.correct !== null && game.predictedProb !== null) {
      const bucketIndex = Math.min(Math.floor(game.predictedProb * 10), 9);
      buckets[bucketIndex].count += 1;
      if (game.correct) buckets[bucketIndex].correct += 1;
    }
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
    <section className="border border-border bg-card mt-4">
      <div className="border-b border-border px-5 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
