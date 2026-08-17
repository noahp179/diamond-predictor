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
 * Charts for the forward-tested ledger.
 *
 * Every series here comes from `event_predictions` — rows written the morning
 * of an event and scored after it. Nothing is derived from a backtest; where a
 * backtest number appears it is a dashed REFERENCE LINE, never a plotted
 * series, so the eye cannot mistake what was claimed for what happened.
 *
 * All three charts show sample size somewhere, because with a young ledger the
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
}: {
  running: { i: number; date: string; accuracy: number }[];
  claim: number | null;
  meaningfulN: number;
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
            value: "settled calls",
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
          labelFormatter={(i) => `after ${i} settled`}
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
            label={{
              value: `backtest ${(claim * 100).toFixed(1)}%`,
              position: "insideTopRight",
              fill: "var(--color-primary)",
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
              value: `only ${running.length} settled`,
              position: "insideBottomRight",
              fill: AXIS,
              fontSize: 10,
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey="pct"
          name="live hit rate"
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
 * Calibration: predictions bucketed by confidence, against how often they hit.
 *
 * Two bars per bucket — what the model said, and what actually happened — so
 * the comparison is a direct height difference rather than a distance from a
 * diagonal. Bars beat a scatter here because the question is asked one bucket
 * at a time ("when it says 70%, does 70% land?"), and a bucket is a category,
 * not a point in space.
 *
 * The sample size is printed under each bucket rather than encoded in the
 * geometry. A bucket of four calls and a bucket of four hundred draw identical
 * bars, and the only honest fix is to say so in words.
 */
export function CalibrationChart({
  calibration,
}: {
  calibration: { band: string; n: number; predicted: number; actual: number }[];
}) {
  const data = calibration.map((c) => ({
    band: c.band,
    said: Number((c.predicted * 100).toFixed(1)),
    happened: Number((c.actual * 100).toFixed(1)),
    n: c.n,
    label: `${c.band}\nn=${c.n}`,
  }));

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="band" stroke={AXIS} fontSize={11} tickLine={false} />
        <YAxis
          domain={[0, 100]}
          stroke={AXIS}
          fontSize={11}
          width={42}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip
          contentStyle={TOOLTIP}
          formatter={(v, n, p) => (n === "calls in bucket" ? [v, n] : [`${v}%`, n])}
          labelFormatter={(band, payload) =>
            `${band} · ${(payload?.[0]?.payload as { n?: number })?.n ?? 0} calls`
          }
        />
        <Legend wrapperStyle={LEGEND} {...LEGEND_TOP} />
        <ReferenceLine y={50} stroke={AXIS} strokeDasharray="4 4" />
        <Bar
          dataKey="said"
          name="the model said"
          fill="var(--color-chart-1)"
          isAnimationActive={false}
        />
        <Bar
          dataKey="happened"
          name="how often it hit"
          fill="var(--color-chart-2)"
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * How much the ledger settles per day, and how it did.
 *
 * The bars are the point: they show how fast this page is actually filling up.
 * Daily accuracy rides on top as a line, deliberately thin, because a single
 * day is almost never a meaningful sample and should not read like one.
 */
export function VolumeChart({ daily }: { daily: { date: string; n: number; accuracy: number }[] }) {
  const data = daily.map((d) => ({
    date: d.date.slice(5),
    n: d.n,
    pct: Number((d.accuracy * 100).toFixed(1)),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="date" stroke={AXIS} fontSize={11} minTickGap={20} />
        <YAxis yAxisId="left" stroke={AXIS} fontSize={11} width={34} allowDecimals={false} />
        <YAxis
          yAxisId="right"
          orientation="right"
          domain={[0, 100]}
          stroke={AXIS}
          fontSize={11}
          width={42}
          tickFormatter={(v: number) => `${v}%`}
        />
        <Tooltip contentStyle={TOOLTIP} />
        <Legend wrapperStyle={LEGEND} {...LEGEND_TOP} />
        <ReferenceLine yAxisId="right" y={50} stroke={AXIS} strokeDasharray="4 4" />
        <Bar
          yAxisId="left"
          dataKey="n"
          name="calls settled"
          fill="var(--color-chart-1)"
          isAnimationActive={false}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="pct"
          name="that day's hit rate"
          stroke="var(--color-chart-2)"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Shown in place of a chart when the ledger has nothing to draw yet. */
export function EmptyChart({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[220px] items-center justify-center border border-dashed border-border px-6 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
