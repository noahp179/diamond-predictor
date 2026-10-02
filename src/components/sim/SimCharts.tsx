import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

/**
 * The simulator's charts — hand-drawn SVG rather than a charting library,
 * because the one thing these must do well is put a reference line at a
 * half-point (a 3.5-point spread, a 7.5-run total) between two integer bars,
 * and category axes can't.
 *
 * Specs follow the site's chart conventions: bars at most 24px wide with a
 * 2px gap, 4px rounded tops and square bases, solid hairline grid, text in
 * text colours (never the series colour), a hover/focus readout on every bar,
 * and a table view beneath for anyone who would rather read numbers.
 */

export type Bin = { x: number; p: number; color: string };
export type RefMark = { x: number; label: string };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceStep(raw: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

export function Histogram({
  bins,
  refs = [],
  height = 200,
  xFmt = (x) => String(x),
  describe,
  ariaLabel,
}: {
  bins: Bin[];
  refs?: RefMark[];
  height?: number;
  xFmt?: (x: number) => string;
  /** Tooltip text for one bin: [value line, label line]. */
  describe: (b: Bin) => [string, string];
  ariaLabel: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 40, r: 10, t: refs.length ? 22 : 10, b: 26 };
  const plotW = Math.max(10, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const n = bins.length;
  const xmin = bins[0]?.x ?? 0;
  const step = n ? plotW / n : plotW;
  const barW = Math.max(1, Math.min(24, step - 2));
  const maxP = Math.max(1e-6, ...bins.map((b) => b.p));
  const yStep = niceStep(maxP / 3);
  const yTop = Math.ceil(maxP / yStep) * yStep;
  const yTicks = useMemo(() => {
    const t: number[] = [];
    for (let v = 0; v <= yTop + 1e-9; v += yStep) t.push(v);
    return t;
  }, [yTop, yStep]);
  const xEvery = Math.max(1, niceStep(34 / Math.max(step, 0.1)));
  const y = (p: number) => pad.t + plotH - (p / yTop) * plotH;
  const xc = (i: number) => pad.l + (i + 0.5) * step;
  const xAt = (v: number) => pad.l + (v - xmin + 0.5) * step;

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else return;
    e.preventDefault();
  };

  const tip = hover != null ? bins[hover] : null;
  const [tipValue, tipLabel] = tip ? describe(tip) : ["", ""];
  const tipX = hover != null ? xc(hover) : 0;

  return (
    <div ref={box} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={pad.l}
                x2={width - pad.r}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={pad.l - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[10px] tabular-nums"
              >
                {`${Math.round(t * 1000) / 10}%`}
              </text>
            </g>
          ))}
          {bins.map((b, i) => {
            const h = Math.max(0, y(0) - y(b.p));
            const x0 = xc(i) - barW / 2;
            const r = Math.min(4, barW / 2, h);
            const top = y(b.p);
            const d =
              h <= 0
                ? ""
                : `M${x0},${y(0)} L${x0},${top + r} Q${x0},${top} ${x0 + r},${top} L${x0 + barW - r},${top} Q${x0 + barW},${top} ${x0 + barW},${top + r} L${x0 + barW},${y(0)} Z`;
            return (
              <g key={b.x}>
                {d && (
                  <path d={d} fill={b.color} opacity={hover == null || hover === i ? 1 : 0.55} />
                )}
                <rect
                  x={pad.l + i * step}
                  y={pad.t}
                  width={Math.max(step, 1)}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                />
              </g>
            );
          })}
          {bins
            .filter((b) => b.x % xEvery === 0)
            .map((b) => (
              <text
                key={`t${b.x}`}
                x={xAt(b.x)}
                y={height - pad.b + 16}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[10px] tabular-nums"
              >
                {xFmt(b.x)}
              </text>
            ))}
          <line
            x1={pad.l}
            x2={width - pad.r}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--color-muted-foreground)"
            strokeWidth={1}
          />
          {refs.map((r) => {
            const rx = xAt(r.x);
            if (rx < pad.l || rx > width - pad.r) return null;
            return (
              <g key={r.label}>
                <line
                  x1={rx}
                  x2={rx}
                  y1={pad.t - 4}
                  y2={y(0)}
                  stroke="var(--color-foreground)"
                  strokeWidth={1.5}
                />
                <text
                  x={rx}
                  y={pad.t - 9}
                  textAnchor="middle"
                  className="fill-foreground font-mono text-[10px] uppercase tracking-wider"
                >
                  {r.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {tip && (
        <div
          className="pointer-events-none absolute z-10 min-w-[8rem] -translate-x-1/2 border border-border bg-popover/95 px-3 py-2 font-mono text-[11px] shadow-lg"
          style={{
            left: Math.min(Math.max(tipX, 70), Math.max(70, width - 70)),
            top: 0,
            background: "var(--color-card)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3" style={{ background: tip.color }} />
            <span className="text-sm font-semibold text-foreground">{tipValue}</span>
          </div>
          <div className="mt-0.5 text-muted-foreground">{tipLabel}</div>
        </div>
      )}
    </div>
  );
}

/** Two-sided probability bar: away on the left, home on the right, a tie
 *  share (if any) in neutral grey between them. */
export function WinBar({
  away,
  home,
  tie,
  awayLabel,
  homeLabel,
  awayColor,
  homeColor,
}: {
  away: number;
  home: number;
  tie: number;
  awayLabel: string;
  homeLabel: string;
  awayColor: string;
  homeColor: string;
}) {
  const seg = (p: number) => `${Math.max(0, p) * 100}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: awayColor }} />
          {awayLabel}
        </span>
        <span className="flex items-center gap-2">
          {homeLabel}
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: homeColor }} />
        </span>
      </div>
      <div
        className="mt-2 flex h-3 w-full gap-[2px] overflow-hidden"
        role="img"
        aria-label={`${awayLabel} ${(away * 100).toFixed(1)} percent, ${homeLabel} ${(home * 100).toFixed(1)} percent`}
      >
        <div className="rounded-l-[4px]" style={{ width: seg(away), background: awayColor }} />
        {tie > 0.0005 && (
          <div style={{ width: seg(tie), background: "var(--color-muted-foreground)" }} />
        )}
        <div className="rounded-r-[4px]" style={{ width: seg(home), background: homeColor }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-3xl font-semibold text-foreground">{(away * 100).toFixed(1)}%</span>
        {tie > 0.0005 && (
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Tie {(tie * 100).toFixed(1)}%
          </span>
        )}
        <span className="text-3xl font-semibold text-foreground">{(home * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}

/** The numbers behind a histogram, for reading without hovering. */
export function BinTable({
  bins,
  xLabel,
  xFmt,
}: {
  bins: Bin[];
  xLabel: string;
  xFmt: (x: number) => string;
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
        Show as table
      </summary>
      <div className="mt-2 grid max-h-56 grid-cols-2 gap-x-6 overflow-y-auto font-mono text-[11px] sm:grid-cols-4">
        {bins
          .filter((b) => b.p > 0)
          .map((b) => (
            <div
              key={b.x}
              className="flex justify-between border-b border-border/40 py-0.5 tabular-nums"
            >
              <span className="text-muted-foreground">
                {xLabel} {xFmt(b.x)}
              </span>
              <span className="text-foreground">{(b.p * 100).toFixed(1)}%</span>
            </div>
          ))}
      </div>
    </details>
  );
}
