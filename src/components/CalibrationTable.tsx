/**
 * CalibrationTable — "is a 60% pick really a 60% pick", in words.
 *
 * WHAT THIS REPLACES AND WHY. The same data used to be a combo chart: bars for
 * how many picks landed in each bucket on a left axis, and two lines for
 * claimed-vs-actual percentages on a right axis. Two y-scales on one chart is
 * the single most common way a chart becomes unreadable — the bars and the
 * lines share no units, so the eye compares heights that mean nothing to each
 * other, and the reader is left decoding a legend instead of learning anything.
 *
 * The data's actual job is before-and-after for each bucket: what the board
 * claimed, and what happened. Two values, one scale. So each row is a track
 * from 0 to 100% with two markers on it, and the count moves out of the
 * encoding and into a plain column where it belongs.
 *
 * Identity never rests on colour: the two markers differ by position on the
 * track, by shape (hollow ring for the claim, filled dot for the result), and
 * by a direct label on every row. The whole thing is a table, so it reads
 * correctly with no colour at all.
 *
 * THE VERDICT COLUMN IS THE POINT. A reader should not have to know what a
 * calibration curve is. Each row ends in a plain sentence, and — this is the
 * part that keeps it honest — a bucket holding fifteen picks cannot support a
 * verdict, so it does not get one. The margin is computed rather than guessed:
 * the standard error of a proportion at that bucket's claim and count, doubled.
 * A gap inside that is noise, and the row says so.
 */

export type CalibrationRow = {
  band: string;
  n: number;
  predicted: number;
  actual: number;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Two standard errors on a proportion of `n` draws at probability `p` — the
 * width inside which a gap is indistinguishable from chance. Quoting it beside
 * the verdict is what stops "over-confident" being read into eleven picks.
 */
function margin(p: number, n: number): number {
  if (n <= 0) return 1;
  return 2 * Math.sqrt(Math.max(p * (1 - p), 0.01) / n);
}

function verdict(r: CalibrationRow): { text: string; tone: "flat" | "over" | "under" } {
  const gap = r.actual - r.predicted;
  const m = margin(r.predicted, r.n);
  if (Math.abs(gap) <= m) return { text: "about right", tone: "flat" };
  if (gap > 0) return { text: `scored ${pct(Math.abs(gap))} more often than it claimed`, tone: "under" };
  return { text: `scored ${pct(Math.abs(gap))} less often than it claimed`, tone: "over" };
}

function Track({ predicted, actual }: { predicted: number; actual: number }) {
  const claim = Math.min(Math.max(predicted, 0), 1) * 100;
  const got = Math.min(Math.max(actual, 0), 1) * 100;
  const lo = Math.min(claim, got);
  const span = Math.abs(claim - got);
  return (
    <div className="relative h-4 w-full min-w-[120px]" aria-hidden="true">
      {/* the 0-100% rule, one shade off the surface */}
      <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      {/* the gap between claim and result, which is the thing being read */}
      <div
        className="absolute top-1/2 h-px -translate-y-1/2 bg-muted-foreground/50"
        style={{ left: `${lo}%`, width: `${span}%` }}
      />
      {/* claimed: hollow, recessive — it is the reference, not the finding */}
      <div
        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-muted-foreground bg-card"
        style={{ left: `${claim}%` }}
      />
      {/* what happened: filled, accent */}
      <div
        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
        style={{ left: `${got}%` }}
      />
    </div>
  );
}

export function CalibrationTable({
  rows,
  /** What one row is: "picks" here, "calls" on the game ledger. */
  unit = "picks",
}: {
  rows: CalibrationRow[];
  unit?: string;
}) {
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const solid = rows.filter((r) => Math.abs(r.actual - r.predicted) > margin(r.predicted, r.n));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-muted-foreground bg-card" />
          what it claimed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
          what actually happened
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse font-mono text-[11px]">
          <thead>
            <tr className="border-b border-border text-left uppercase tracking-widest text-muted-foreground">
              <th className="py-2 pr-3 font-normal">When it said</th>
              <th className="py-2 pr-3 text-right font-normal tabular-nums">{unit}</th>
              <th className="w-[38%] py-2 pr-3 font-normal">0% → 100%</th>
              <th className="py-2 pr-3 text-right font-normal tabular-nums">They scored</th>
              <th className="py-2 font-normal">So?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = verdict(r);
              return (
                <tr key={r.band} className="border-b border-border/60 last:border-b-0">
                  <td className="py-3 pr-3 text-foreground tabular-nums">{r.band}</td>
                  <td className="py-3 pr-3 text-right text-muted-foreground tabular-nums">{r.n}</td>
                  <td className="py-3 pr-3">
                    <Track predicted={r.predicted} actual={r.actual} />
                  </td>
                  <td className="py-3 pr-3 text-right text-foreground tabular-nums">
                    {pct(r.actual)}
                  </td>
                  <td
                    className={`py-3 normal-case ${
                      v.tone === "flat" ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {v.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Read a row as a sentence: <em>of the {rows[0].n} picks the board called{" "}
        {rows[0].band}, {pct(rows[0].actual)} scored.</em> The two dots are the claim and the
        result — the closer they sit, the more the number on the card can be taken at face value.{" "}
        {solid.length === 0 ? (
          <>
            Across all {total} settled {unit}, no bucket is off by more than chance can explain at
            this sample size, so every row reads “about right”. That is the expected state early
            on, not a finding.
          </>
        ) : (
          <>
            A row only gets a verdict when the gap is bigger than two standard errors for that
            bucket’s size — otherwise it says “about right”, because a handful of picks cannot tell
            a good model from a lucky one.
          </>
        )}
      </p>
    </div>
  );
}
