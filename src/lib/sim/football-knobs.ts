/**
 * football-knobs.ts — the college football engine's optional factors, each
 * with a strength, like nba-knobs.ts. At its "off" value a factor leaves the
 * engine exactly as it was, so scripts/props-backtest-football.ts (with
 * FB_KNOBS) can switch one on at a time. The values below are the ones the
 * backtest kept; see research/player-props/CFB_FACTORS.md.
 */
export const FB_KNOBS = {
  /** Weight on recent targets and carries a game (vs the season's). */
  recentW: 0.75,
  /** Appearances needed for full weight. */
  recentFull: 3,
  /** Score margin from which a side's starters sit in the fourth quarter (0 = never). */
  pull: 28,
  /** Share of the usual work the sitting starters still get. */
  pullF: 0.25,
  /** 1: the trailing side sits its starters too, not just the leader. */
  pullBoth: 1,
  /** Weight on the market's total and spread. */
  mktTotal: 1,
  mktSpread: 1,
  /** Offensive efficiency factor per week of extra rest (a bye), and for a short week. */
  bye: 0,
  shortWeek: 0,
  /** Usage concentration on the regulars (college). */
  targetPow: 1.5,
  rushPow: 1.6,
  /** Game-to-game team form spread (college). */
  formSd: 0.09,
};

export type FbKnobs = typeof FB_KNOBS;

export function setFbKnobs(o: Partial<FbKnobs>): void {
  for (const [k, v] of Object.entries(o))
    if (k in FB_KNOBS && typeof v === "number") (FB_KNOBS as Record<string, number>)[k] = v;
}
