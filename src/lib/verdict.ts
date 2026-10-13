/**
 * Is a record doing what it said it would? See RecordHeadline for the reading.
 *
 * A gap between the hit rate and the stated probability inside two standard
 * errors at that sample size is luck; below ENOUGH results nothing is read
 * into it at all.
 */

/** Below this many settled results a hit rate is mostly luck. */
export const ENOUGH = 50;

export type Verdict = { icon: string; label: string; tone: string; why: string };

export function verdictOf(n: number, hitRate: number, expected: number | null): Verdict {
  if (n < ENOUGH || expected == null)
    return {
      icon: "…",
      label: "Too early to tell",
      tone: "text-muted-foreground border-border",
      why: `Fewer than ${ENOUGH} results — a streak of luck either way would look the same as a good or bad model.`,
    };
  const band = 2 * Math.sqrt((expected * (1 - expected)) / n);
  const gap = hitRate - expected;
  if (Math.abs(gap) <= band)
    return {
      icon: "✓",
      label: "On track",
      tone: "text-emerald-500 border-emerald-500/50",
      why: "Right about as often as it said it would be — its percentages can be taken at face value.",
    };
  return gap > 0
    ? {
        icon: "▲",
        label: "Better than it said",
        tone: "text-emerald-500 border-emerald-500/50",
        why: "Right more often than it said, by more than luck usually explains.",
      }
    : {
        icon: "▼",
        label: "Worse than it said",
        tone: "text-red-500 border-red-500/50",
        why: "Right less often than it said — treat its percentages as too high until this closes.",
      };
}
