import type { ReactNode } from "react";

import { verdictOf, type Verdict } from "@/lib/verdict";

/**
 * The one comparison every record on the site reduces to, in words.
 *
 * Any set of picks has two numbers anyone can compare: how often they came in,
 * and how often the model SAID they would (the average probability it printed
 * on them). A model that says 60% and hits 60% is doing its job whatever the
 * number is; one that says 60% and hits 45% is not. The verdict is computed,
 * not eyeballed: a gap inside two standard errors at that sample size is luck,
 * and below ENOUGH results nothing is read into it at all.
 */

const pct = (x: number | null | undefined, d = 0) =>
  x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`;

export function VerdictPill({ v }: { v: Verdict }) {
  return (
    <span
      className={`inline-flex items-center gap-2 border px-3 py-1 font-mono text-[11px] uppercase tracking-widest ${v.tone}`}
    >
      <span aria-hidden>{v.icon}</span>
      {v.label}
    </span>
  );
}

/**
 * The headline block: the big hit rate, "X of N", what the model said, the
 * verdict, and any extra comparisons the page has (a coin flip, the backtest).
 */
export function RecordHeadline({
  hits,
  n,
  unit,
  verb,
  expected,
  compare = [],
  footnote,
}: {
  hits: number;
  n: number;
  /** "games", "picks", "slips". */
  unit: string;
  /** "picked right", "hit". */
  verb: string;
  /** The average probability the model put on these picks. */
  expected: number | null;
  /** Other yardsticks, e.g. ["A coin flip", 0.5]. */
  compare?: [string, number][];
  footnote?: ReactNode;
}) {
  const hitRate = n ? hits / n : 0;
  const v = verdictOf(n, hitRate, expected);
  return (
    <div className="grid gap-6 px-5 py-6 sm:px-6 md:grid-cols-[auto_1fr] md:items-center">
      <div>
        <div className="font-display text-6xl leading-none">{pct(hitRate)}</div>
        <div className="mt-2 text-sm text-foreground">
          {hits.toLocaleString()} of {n.toLocaleString()} {unit} {verb}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          It said it would be right {pct(expected)} of the time
        </div>
      </div>
      <div>
        <VerdictPill v={v} />
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{v.why}</p>
        {compare.length > 0 && (
          <ul className="mt-3 space-y-2">
            {[["This model", hitRate] as [string, number], ...compare].map(([label, x], i) => (
              <li key={label} className="grid grid-cols-[9.5rem_1fr_3rem] items-center gap-3">
                <span
                  className={`text-xs ${i === 0 ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {label}
                </span>
                <span className="h-2.5 rounded-full bg-secondary">
                  <span
                    className={`block h-full rounded-full ${i === 0 ? "bg-primary" : "bg-muted-foreground/50"}`}
                    style={{ width: `${Math.max(0, Math.min(1, x)) * 100}%` }}
                  />
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums text-foreground">
                  {pct(x)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {footnote && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{footnote}</p>}
      </div>
    </div>
  );
}
