import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
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
import { SiteNav } from "@/components/SiteNav";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Track Record — Diamond Edge" },
      {
        name: "description",
        content:
          "Accuracy, Brier score, log loss, and betting returns at the stored odds for every model — Poisson, Calibrated, Recent Form, Bullpen, Simulator, Market Blend, and the devigged Market — tracked from " +
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

const LEGEND_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

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

  // Hero leaderboard: every model's overall win rate, best first.
  const accuracyRanked = React.useMemo(
    () =>
      models
        .filter((m) => m.settled.n > 0 && m.settled.accuracy != null)
        .map((m) => ({
          version: m.version,
          label: modelLabel(m.version),
          accuracy: m.settled.accuracy as number,
          n: m.settled.n,
        }))
        .sort((a, b) => b.accuracy - a.accuracy),
    [models],
  );

  // Running (cumulative) win rate per model over time — far smoother than daily.
  const runningAccuracy = React.useMemo(
    () =>
      calculateRunningAccuracy(
        games,
        models.map((m) => m.version),
      ),
    [games, models],
  );

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
              Every model we run — the Poisson analytic model, the recent-form and bullpen sims, the
              calibrated and headline Simulator, the market blend and the devigged market line —
              scored identically on every settled game. A clean start: all lines begin together at{" "}
              {trackingSince}.
            </p>
          </div>
          <SiteNav />
        </div>

        {/* Model scoreboard — every tracked model, click to inspect */}
        <div className="border-t border-border bg-secondary/30">
          <div className="mx-auto grid max-w-6xl grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x lg:grid-cols-5 lg:divide-y-0">
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
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <MiniStat label="Win rate" value={pct(m.settled.accuracy)} />
                  <MiniStat label="Games" value={`${m.settled.n}`} />
                  <MiniStat label="Waiting" value={`${m.pending}`} />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* How the site's own featured picks are doing */}
        {segments && (
          <div className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <span className="text-primary">How our featured picks are doing</span>
              {(["all", "recommended", "best_odds"] as Segment[]).map((seg) => (
                <span key={seg}>
                  {SEGMENT_LABEL[seg]}:{" "}
                  <span className="text-foreground">{pct(segments[seg]?.accuracy)}</span>
                  <span> · {segments[seg]?.n ?? 0} games</span>
                </span>
              ))}
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
            <div className="mt-4 border border-border bg-secondary/20 px-5 py-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">How to read this page. </span>
              Each card says in plain English what it shows and whether a higher or lower number is
              better. “Right” means the model’s favored team actually won. Tap any model in the
              scoreboard above to spotlight it in the charts.
            </div>

            {/* 1 — the headline comparison: who picks the most winners */}
            <ChartCard
              title="Which model picks the most winners?"
              subtitle={`Out of every finished game since ${trackingSince}, how often each model’s favored team actually won. Bigger number = better. The line down the middle is a 50/50 coin flip.`}
              better="up"
            >
              <AccuracyLeaderboard
                rows={accuracyRanked}
                colorOf={colorOf}
                selected={selected}
                onSelect={setSelectedModel}
              />
            </ChartCard>

            {/* 2 — the trend: is each model getting better or worse */}
            <ChartCard
              title="Is each model getting better or worse over time?"
              subtitle="Each line is a model’s win rate as more games finish — it steadies as the season builds. Higher is better; the dashed line is a coin flip."
              better="up"
            >
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart
                  data={runningAccuracy}
                  margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    minTickGap={24}
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    stroke="var(--color-muted-foreground)"
                    fontSize={11}
                    tickFormatter={(v: number) => `${v}%`}
                    width={40}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-card)",
                      border: "1px solid var(--color-border)",
                      fontFamily: "var(--font-mono)",
                    }}
                    formatter={(value, name) => [value != null ? `${value}%` : "—", name]}
                  />
                  <Legend wrapperStyle={LEGEND_STYLE} />
                  <ReferenceLine
                    y={50}
                    stroke="var(--color-muted-foreground)"
                    strokeDasharray="4 4"
                    label={{
                      value: "coin flip",
                      position: "insideBottomRight",
                      fontSize: 10,
                      fill: "var(--color-muted-foreground)",
                    }}
                  />
                  {models.map((m) => (
                    <Line
                      key={m.version}
                      type="monotone"
                      dataKey={`${m.version}_run`}
                      name={modelLabel(m.version)}
                      stroke={colorOf(m.version)}
                      strokeWidth={selected === m.version ? 3 : 1.5}
                      strokeOpacity={selected === m.version ? 1 : 0.3}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 3 — money: what betting every pick would have done */}
            <ChartCard
              title="If you bet $100 on every pick…"
              subtitle="Running profit or loss from a flat $100 bet on each model’s pick, paid at the real sportsbook price. Above the middle line = up money; below = down. Same games for every model."
              better="up"
            >
              {returns.rows.length > 0 ? (
                <>
                  <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                    {returns.totals.map((t) => (
                      <span
                        key={t.version}
                        className="inline-flex items-center gap-1.5 font-mono text-xs"
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: colorOf(t.version) }}
                        />
                        <span className="uppercase tracking-widest text-muted-foreground">
                          {modelLabel(t.version)}
                        </span>
                        <span className={t.units >= 0 ? "text-emerald-600" : "text-red-500"}>
                          {fmtDollars(t.units)}
                        </span>
                        <span className="text-muted-foreground">
                          · {t.roi != null ? `${(t.roi * 100).toFixed(1)}% ROI` : "—"} · {t.bets}{" "}
                          bets
                        </span>
                      </span>
                    ))}
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart
                      data={returns.rows}
                      margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="var(--color-border)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="date"
                        stroke="var(--color-muted-foreground)"
                        fontSize={11}
                        minTickGap={24}
                      />
                      <YAxis
                        stroke="var(--color-muted-foreground)"
                        fontSize={11}
                        width={54}
                        tickFormatter={(v: number) => fmtDollars(v)}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--color-card)",
                          border: "1px solid var(--color-border)",
                          fontFamily: "var(--font-mono)",
                        }}
                        formatter={(value) => fmtDollars(Number(value))}
                      />
                      <Legend wrapperStyle={LEGEND_STYLE} />
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
                          strokeWidth={selected === t.version ? 3 : 1.5}
                          strokeOpacity={selected === t.version ? 1 : 0.3}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Losing favorites don’t pay much, so a model can pick lots of winners and still
                    lose money — that’s the sportsbook’s edge, not a bug. Games with no stored price
                    are skipped for every model so the lines compare on the same slate.
                  </p>
                </>
              ) : (
                <div className="flex h-40 items-center justify-center text-muted-foreground">
                  No settled picks with a stored price yet — this plots once priced games go final.
                </div>
              )}
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

/** A model's cumulative unit P/L expressed as dollars on a flat $100 stake. */
function fmtDollars(units: number): string {
  const d = units * 100;
  return `${d >= 0 ? "+" : "−"}$${Math.abs(d).toFixed(0)}`;
}

function BetterBadge({ dir }: { dir: "up" | "down" }) {
  const up = dir === "up";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
        up ? "border-emerald-600/40 text-emerald-600" : "border-red-500/40 text-red-500"
      }`}
    >
      {up ? "Higher is better ↑" : "Lower is better ↓"}
    </span>
  );
}

/**
 * The headline comparison: a plain ranked leaderboard of every model's overall
 * win rate. An honest 0–100% track with a 50% coin-flip marker, the real number
 * shown large, best first. Click a row to spotlight that model in the charts.
 */
function AccuracyLeaderboard({
  rows,
  colorOf,
  selected,
  onSelect,
}: {
  rows: Array<{ version: string; label: string; accuracy: number; n: number }>;
  colorOf: (v: string) => string;
  selected: string;
  onSelect: (v: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-muted-foreground">
        No settled games yet.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const acc = r.accuracy * 100;
        const isSel = selected === r.version;
        return (
          <button
            key={r.version}
            onClick={() => onSelect(r.version)}
            className={`block w-full rounded-sm px-1 py-1 text-left transition-colors ${isSel ? "bg-secondary/40" : "hover:bg-secondary/20"}`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: colorOf(r.version) }}
                />
                <span className={isSel ? "text-primary" : "text-foreground"}>{r.label}</span>
              </span>
              <span className="font-display text-2xl leading-none text-foreground">
                {acc.toFixed(1)}%
                <span className="ml-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  of {r.n}
                </span>
              </span>
            </div>
            <div className="relative h-3 w-full overflow-hidden rounded bg-secondary">
              <div
                className="h-full rounded"
                style={{
                  width: `${acc}%`,
                  background: colorOf(r.version),
                  opacity: isSel ? 1 : 0.6,
                }}
              />
              {/* 50% coin-flip reference marker */}
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-foreground/40" />
            </div>
          </button>
        );
      })}
      <div className="flex items-center gap-2 pt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="inline-block h-3 w-px bg-foreground/40" />
        the middle line is a 50/50 coin flip — anything past it beats guessing
      </div>
    </div>
  );
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

/**
 * Cumulative (running) win rate per model over time, in percent. One row per
 * date carrying `${version}_run` = correct/total through that date. Far smoother
 * than day-by-day accuracy, so the "getting better or worse?" trend is legible.
 */
function calculateRunningAccuracy(games: TrackedGame[], versions: string[]) {
  const run = new Map(versions.map((v) => [v, { c: 0, n: 0 }]));
  const byDate = new Map<string, TrackedGame[]>();
  for (const g of [...games].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const arr = byDate.get(g.date) ?? [];
    arr.push(g);
    byDate.set(g.date, arr);
  }
  const rows: Array<Record<string, number | string | null>> = [];
  for (const [date, dayGames] of byDate) {
    for (const g of dayGames) {
      for (const v of versions) {
        const s = g.models[v];
        if (!s || s.correct == null) continue;
        const r = run.get(v)!;
        r.n += 1;
        if (s.correct) r.c += 1;
      }
    }
    const row: Record<string, number | string | null> = { date };
    for (const v of versions) {
      const r = run.get(v)!;
      row[`${v}_run`] = r.n > 0 ? Number(((r.c / r.n) * 100).toFixed(1)) : null;
    }
    rows.push(row);
  }
  return rows;
}

function ChartCard({
  title,
  subtitle,
  better,
  children,
}: {
  title: string;
  subtitle?: string;
  better?: "up" | "down";
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-xl leading-tight text-foreground">{title}</h3>
          {better && <BetterBadge dir={better} />}
        </div>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
