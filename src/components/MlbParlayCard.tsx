import { useMemo, useState } from "react";

import {
  buildSizedParlay,
  SIZE_EVIDENCE,
  SIZE_RULES,
  type ParlayCandidate,
} from "@/lib/mlb-parlay";

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

/** The slip sizes offered, with what each actually did on the hold-out season. */
const SIZES = [5, 10, 15];

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
  const [size, setSize] = useState(5);
  const [dropCautioned, setDropCautioned] = useState(false);
  const parlay = useMemo(
    () => buildSizedParlay(candidates, size, dropCautioned),
    [candidates, size, dropCautioned],
  );
  const cautionedAvailable = useMemo(
    () => buildSizedParlay(candidates, size).cautioned,
    [candidates, size],
  );
  const evidence = SIZE_EVIDENCE[size];
  const rule = SIZE_RULES[size];

  return (
    <section className="mb-10 border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-2xl">Today's parlay</h2>
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {parlay.legs.length} legs · one per player · fair {fmtPrice(parlay.fairPrice)}
          </div>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Pick a size and the slip fills with that many legs, ranked by confidence and never by
          price. <strong className="text-foreground">Every player appears at most once</strong> — no
          pitcher stacked across 5+, 6+ and 7+ strikeouts, and no batter counted twice through two
          markets that describe the same night. Each size also caps how many legs may come from one
          game, because legs from the same lineup lose together; that cap beat the uncapped slip in
          every configuration tested.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {SIZES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSize(n)}
              aria-pressed={size === n}
              className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                size === n
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {n} legs
            </button>
          ))}
          {evidence && rule && (
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
              backtest: cashed {(evidence.realised * 100).toFixed(1)}% of {evidence.filled} slates ·
              legs ≥ {Math.round(rule.floor * 100)}% · max {rule.maxPerGame}/game
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

      {!isLoading && parlay.legs.length < size && (
        <div className="px-5 py-10 text-center">
          <div className="font-display text-2xl">
            Only {parlay.legs.length} of {size} legs available
          </div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            One leg per player means a short slate caps the slip. Try a smaller size, or wait for
            the rest of today's lineups to post.
          </p>
        </div>
      )}

      {!isLoading && parlay.legs.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            <Cell label="Legs" value={`${parlay.legs.length}`} />
            <Cell label="Chance it hits" value={pct(parlay.combinedProb)} />
            <Cell label="Backtested at this size" value={evidence ? pct(evidence.realised) : "—"} />
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
              &quot;Chance it hits&quot; multiplies the leg probabilities. With one leg per player
              and the per-game cap, that assumption held up on the 2026 hold-out — five-leg slips
              were predicted at 30.2% and landed 35.3%, ten-leg at 6.4% against 8.2%. The
              fifteen-leg figure rests on a single winning slip in 109 days, so treat it as an order
              of magnitude, not a rate.
            </div>
            <div className="mt-1">
              Longer slips cannot have safer legs — filling fifteen means reaching deeper into the
              board, so mean leg quality falls from about 79% at five legs to 74% at fifteen. Each
              size is made as safe as its length allows, not equally safe.
            </div>
            <div className="mt-1">
              No player-prop prices exist in this data source, so &quot;fair price&quot; is what the
              model&apos;s own probability implies, not a quote. Compare it with your book: if they
              pay less than this, the bet is bad however good the pick is.
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
