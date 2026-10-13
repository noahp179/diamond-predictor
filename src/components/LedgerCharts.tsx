import type { ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Charts for a scored set of predictions.
 *
 * Two sources feed these, and they are NEVER drawn on the same axes:
 *
 *   the live ledger  rows from `event_predictions`, written the morning of an
 *                    event and scored after it — the real forward record;
 *   the replay       the model re-run over completed matches, each priced with
 *                    only what was known before it — a backtest.
 *
 * These components are shared because the arithmetic is identical and two
 * copies would drift. Keeping the two APART is the calling page's job: it puts
 * them under separate headings that say which is which. Nothing in here labels
 * itself "live", so nothing in here can mislabel a backtest as one.
 *
 * Every chart shows sample size somewhere, because with a young ledger the
 * sample is the story. A hit rate over eleven calls is a shape, not a result.
 */

const AXIS = "var(--color-muted-foreground)";
const GRID = "var(--color-border)";
const TOOLTIP = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};
const LEGEND = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  textTransform: "uppercase" as const,
};
/** Legends go above the plot: at the bottom they collide with the axis label. */
const LEGEND_TOP = { verticalAlign: "top" as const, align: "right" as const, height: 24 };

export function ChartCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: string;
}) {
  return (
    <section className="mb-8 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-display text-2xl">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="px-2 py-5 sm:px-4">{children}</div>
      {footer && (
        <div className="border-t border-border px-5 py-3 font-mono text-[11px] text-muted-foreground">
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * Cumulative hit rate as calls settle, against what the backtest claimed.
 *
 * Cumulative rather than per-day: a single matchday is far too small to read,
 * and a running average makes the convergence visible — wild early, steadier as
 * the denominator grows. The claim is a dashed line so the question the page
 * exists to answer ("is it doing what it said?") is a visual one.
 */
export function AccuracyTrend({
  running,
  claim,
  meaningfulN,
  /** Named by the caller, because only the caller knows which source this is. */
  seriesName = "right so far",
  /** A yardstick with no skill in it, e.g. a coin flip's 50%. */
  baseline,
  claimLabel = "it said",
}: {
  running: { i: number; date: string; accuracy: number }[];
  claim: number | null;
  meaningfulN: number;
  seriesName?: string;
  baseline?: { y: number; label: string };
  claimLabel?: string;
}) {
  const data = running.map((r) => ({
    ...r,
    pct: Number((r.accuracy * 100).toFixed(1)),
  }));
  const enough = running.length >= meaningfulN;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis
          dataKey="i"
          stroke={AXIS}
          fontSize={11}
          minTickGap={28}
          label={{
            value: "results so far",
            position: "insideBottom",
            offset: -4,
            fill: AXIS,
            fontSize: 10,
          }}
        />
        <YAxis
          domain={[0, 100]}
          stroke={AXIS}
          fontSize={11}
          width={42}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          contentStyle={TOOLTIP}
          labelFormatter={(i) => `after ${i} results`}
          formatter={(v, n, p) => [
            `${v}%`,
            `${n} · ${(p?.payload as { date?: string })?.date ?? ""}`,
          ]}
        />
        <Legend wrapperStyle={LEGEND} {...LEGEND_TOP} />
        {claim != null && (
          <ReferenceLine
            y={Number((claim * 100).toFixed(1))}
            stroke="var(--color-primary)"
            strokeDasharray="5 4"
            // Lifted clear of the line. A converging series ends up sitting
            // exactly on the reference it is converging toward, which is where
            // this label would otherwise be printed.
            label={{
              value: `${claimLabel} ${(claim * 100).toFixed(0)}%`,
              position: "insideTopRight",
              dy: -8,
              fill: "var(--color-primary)",
              fontSize: 10,
            }}
          />
        )}
        {baseline && (
          <ReferenceLine
            y={baseline.y * 100}
            stroke={AXIS}
            strokeDasharray="2 4"
            label={{
              value: baseline.label,
              position: "insideBottomRight",
              fill: AXIS,
              fontSize: 10,
            }}
          />
        )}
        {/* Below this many settled calls the line is noise; the shaded edge says so. */}
        {!enough && running.length > 0 && (
          <ReferenceLine
            x={running.length}
            stroke={AXIS}
            strokeDasharray="2 4"
            label={{
              value: `only ${running.length} so far`,
              position: "insideBottomRight",
              fill: AXIS,
              fontSize: 10,
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey="pct"
          name={seriesName}
          stroke="var(--color-chart-2)"
          strokeWidth={2}
          dot={running.length <= 40}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * Right and wrong, week by week (or day by day while the record is young).
 *
 * This replaces a bar-and-line chart on two y-scales — calls per day on the
 * left, that day's hit rate on the right — which asked the reader to compare
 * heights that shared no units. Here there is one scale, a count: each bar is
 * the calls settled that week, split into the ones that were right and the
 * ones that were wrong. How full it is and how good it was read off the same
 * bar, and the exact rate is in the tooltip.
 */
export function ResultsOverTime({
  daily,
  rightLabel = "right",
  wrongLabel = "wrong",
}: {
  daily: { date: string; n: number; correct: number }[];
  rightLabel?: string;
  wrongLabel?: string;
}) {
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const span =
    sorted.length > 1
      ? (Date.parse(sorted[sorted.length - 1].date) - Date.parse(sorted[0].date)) / 864e5
      : 0;
  const weekly = span > 28;
  const groups = new Map<string, { key: string; n: number; correct: number }>();
  for (const d of sorted) {
    const key = weekly ? mondayOf(d.date) : d.date;
    const g = groups.get(key) ?? { key, n: 0, correct: 0 };
    g.n += d.n;
    g.correct += d.correct;
    groups.set(key, g);
  }
  const data = [...groups.values()].map((g) => ({
    label: shortDate(g.key),
    right: g.correct,
    wrong: g.n - g.correct,
    rate: g.n ? Math.round((g.correct / g.n) * 100) : 0,
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="label" stroke={AXIS} fontSize={11} minTickGap={16} tickLine={false} />
          <YAxis stroke={AXIS} fontSize={11} width={34} allowDecimals={false} />
          <Tooltip
            contentStyle={TOOLTIP}
            cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }}
            labelFormatter={(l, p) => {
              const row = p?.[0]?.payload as { rate?: number } | undefined;
              return `${weekly ? "Week of " : ""}${l} · ${row?.rate ?? 0}% ${rightLabel}`;
            }}
          />
          <Legend wrapperStyle={LEGEND} {...LEGEND_TOP} />
          <Bar
            dataKey="right"
            stackId="r"
            maxBarSize={48}
            name={`✓ ${rightLabel}`}
            fill="var(--color-chart-2)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="wrong"
            stackId="r"
            maxBarSize={48}
            name={`✗ ${wrongLabel}`}
            fill="var(--color-muted-foreground)"
            fillOpacity={0.45}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Shown in place of a chart when the ledger has nothing to draw yet. */
export function EmptyChart({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[220px] items-center justify-center border border-dashed border-border px-6 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
