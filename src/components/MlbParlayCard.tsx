import { useMemo, useState } from "react";

import { buildParlay, type ParlayCandidate } from "@/lib/mlb-parlay";

/**
 * The parlay card: every pick the model is confident enough about, with
 * overlapping legs collapsed onto the hardest one. Price is not an input — a
 * −1000 favorite belongs on the slip if the model is sure about it.
 *
 * The numbers under the slip come from the 2026 hold-out backtest
 * (research/mlb-props/parlay_backtest.py), including the correlation haircut:
 * multiplying leg probabilities assumes the legs are independent, and legs from
 * the same night are not. Realised parlay hit rates ran ~0.85x the independence
 * product across 2-6 leg slips, so that factor is shown alongside, not hidden.
 */

const CORRELATION_FACTOR = 0.85;

/** Backtested behaviour of the slip at each bar (2026, 129 slate days). */
const THRESHOLDS: { value: number; legsPerDay: string; note: string }[] = [
  { value: 0.55, legsPerDay: "~214", note: "never cashed in 129 days" },
  { value: 0.6, legsPerDay: "~149", note: "never cashed in 129 days" },
  { value: 0.65, legsPerDay: "~78", note: "never cashed in 129 days" },
  { value: 0.7, legsPerDay: "~23", note: "cashed 1 of 128 days" },
  { value: 0.75, legsPerDay: "~6", note: "cashed 33 of 122 days (27%)" },
];

/** Long slips produce absurd numbers honestly — 1e-17% and +9e20 are real
 *  consequences of "everything above the bar", so show them rather than round
 *  them into a comfortable lie. */
const pct = (x: number) =>
  x > 0 && x < 0.001 ? `${(x * 100).toExponential(1)}%` : `${(x * 100).toFixed(1)}%`;
const fmtPrice = (n: number) => {
  const sign = n > 0 ? "+" : "-";
  const a = Math.abs(n);
  return a >= 1e6 ? `${sign}${a.toExponential(1)}` : `${sign}${a.toLocaleString()}`;
};

export function MlbParlayCard({
  candidates,
  isLoading,
}: {
  candidates: ParlayCandidate[];
  isLoading?: boolean;
}) {
  const [threshold, setThreshold] = useState(0.75);
  const [dropCautioned, setDropCautioned] = useState(false);
  const parlay = useMemo(
    () => buildParlay(candidates, threshold, dropCautioned),
    [candidates, threshold, dropCautioned],
  );
  const cautionedAvailable = useMemo(
    () => buildParlay(candidates, threshold).cautioned,
    [candidates, threshold],
  );
  const active = THRESHOLDS.find((t) => t.value === threshold);
  const adjusted = parlay.combinedProb * CORRELATION_FACTOR;

  return (
    <section className="mb-10 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-2xl">Today's parlay</h2>
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {parlay.legs.length} legs · confidence ≥ {Math.round(threshold * 100)}%
          </div>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Every pick the model rates at or above the bar goes on the slip, whatever it pays. Legs
          that guarantee each other are collapsed onto the harder one — if we like 6+ strikeouts, 5+
          strikeouts is the same bet at a shorter price, not a second leg.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {THRESHOLDS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setThreshold(t.value)}
              aria-pressed={threshold === t.value}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                threshold === t.value
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {Math.round(t.value * 100)}%
            </button>
          ))}
          {active && (
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
              backtest: {active.legsPerDay} legs/day · {active.note}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDropCautioned((v) => !v)}
          aria-pressed={dropCautioned}
          className={`mt-3 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
            dropCautioned
              ? "border-primary text-primary"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
          title="Switch hitters hit 66.0% against a stated 72.1% across the 2025-26 hold-out. The models carry no handedness feature, so this is a known blind spot rather than a hunch."
        >
          {dropCautioned ? "▸ " : ""}Drop flagged legs ({cautionedAvailable})
        </button>
      </div>

      {isLoading && <div className="h-40 animate-pulse bg-secondary/30" />}

      {!isLoading && parlay.legs.length === 0 && (
        <div className="px-5 py-10 text-center">
          <div className="font-display text-2xl">No legs clear {Math.round(threshold * 100)}%</div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Nothing on today's board is confident enough. Drop the bar, or wait for lineups to post.
          </p>
        </div>
      )}

      {!isLoading && parlay.legs.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            <Cell label="Legs" value={`${parlay.legs.length}`} />
            <Cell label="If independent" value={pct(parlay.combinedProb)} />
            <Cell label="Correlation-adjusted" value={pct(adjusted)} />
            <Cell label="Fair price" value={fmtPrice(parlay.fairPrice)} />
          </div>

          <ol>
            {parlay.legs.map((leg, i) => (
              <li
                key={`${leg.subjectId}-${leg.market}`}
                className="flex items-center gap-3 border-t border-border px-5 py-3"
              >
                <span className="w-5 shrink-0 font-mono text-[11px] text-primary/70">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-display text-lg leading-tight">
                    {leg.subject}{" "}
                    <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                      {leg.label}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                    {leg.matchup}
                    {(leg.cautions?.length ?? 0) > 0 && (
                      <span className="text-clay"> · ⚠ {leg.cautions!.join(", ")}</span>
                    )}
                    {leg.absorbed.length > 0 && (
                      <>
                        {" · swallows "}
                        {leg.absorbed.map((a) => `${a.label} (${pct(a.prob)})`).join(", ")}
                      </>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right font-display text-2xl">{pct(leg.prob)}</div>
              </li>
            ))}
          </ol>

          <div className="border-t border-border px-5 py-4 font-mono text-[11px] text-muted-foreground">
            {parlay.droppedForOverlap > 0 && (
              <div>
                {parlay.droppedForOverlap} qualifying{" "}
                {parlay.droppedForOverlap === 1 ? "leg" : "legs"} removed as overlap — each one was
                guaranteed by a leg already on the slip, so it added price but no risk.
              </div>
            )}
            {parlay.correlatedGames.length > 0 && (
              <div className="mt-1">
                Same-game legs:{" "}
                {parlay.correlatedGames.map((g) => `${g.matchup} (${g.legs})`).join(", ")} — these
                can lose together, which is why the adjusted number is below the independent one.
              </div>
            )}
            {parlay.cautioned > 0 && (
              <div className="mt-1">
                {parlay.cautioned} flagged {parlay.cautioned === 1 ? "leg" : "legs"} on the slip —
                switch hitters hit 66.0% against a stated 72.1% across 2025-26, the models having no
                handedness feature. Two seasons of evidence, not proof.
              </div>
            )}
            <div className="mt-1">
              Backtested on 2026: legs above a 70% bar won 71.4% of the time, and realised parlay
              rates ran ~0.85× the independence product. Confidence is not profit — a leg at −1000
              is still a losing bet if it wins less than 91% of the time.
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl text-foreground">{value}</div>
    </div>
  );
}
