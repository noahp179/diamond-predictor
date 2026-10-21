/**
 * nba-knobs.ts — the NBA engine's optional factors, each with a strength.
 *
 * Every factor here reads something the season totals don't carry (recent
 * box scores, the schedule, the officials, the market), arriving on the
 * matchup as `ctx.nba`. A factor at its "off" value leaves the engine exactly
 * as it was, so the factor backtest (scripts/props-backtest.ts with
 * NBA_KNOBS) can switch one on at a time. The values below are the ones the
 * backtest kept; see research/player-props/NBA_FACTORS.md.
 */
export const NBA_KNOBS = {
  // ---- minutes
  /** Weight on recent minutes (vs season minutes), at full recent sample. */
  recentW: 0,
  /** Recent games needed for full weight. */
  recentFull: 5,
  /** Minutes multiplier for a player's first game back after missing 3+. */
  ret1: 1,
  /** ... and for his second and third games back. */
  ret23: 1,
  /** 1: only the top nine (and half the tenth) keep their minutes. */
  cut9: 1,
  /** Most minutes anyone is planned for. */
  cap: 40,
  /** 1: starters are those who started most of their last five games. */
  startRecent: 0,
  /** Weight on a player's own game-to-game minutes spread (vs the league's). */
  cvW: 0,

  // ---- rates
  /** 1: offensive/defensive rebound split from his box scores, not position. */
  orebReal: 0,
  /** Pseudo-rebounds at the position's split when regressing it. */
  orebK: 30,
  /** Weight on recent per-minute rates (usage, passing, rebounding). */
  rateW: 0,
  /** Recent minutes needed for full weight. */
  rateFull: 250,
  /** Three-point prior moves this much per point of free-throw % above league. */
  fg3ft: 0,
  /** Pseudo-attempts / pseudo-minutes when regressing to the league. */
  k2: 150,
  k3: 250,
  kft: 60,
  kRate: 250,
  /** Last season's weight never falls below this (makeSeason). */
  wFloor: 0.2,
  /** Team games by which last season's weight reaches the floor. */
  half: 30,

  // ---- teams and the game
  /** Power on the defense's opponent-3P% factor (1 = taken at face value). */
  opp3: 1,
  /** Power on the defense's opponent-2P% factor. */
  opp2: 1,
  /** Make-probability factor per rest day beyond one (capped at three). */
  restDay: 0,
  /** Make-probability factor for a fourth game in six nights. */
  g4in6: 0,
  /** Make-probability factor per 1,000 miles travelled since the last game. */
  miles: 0,
  /** Make-probability factor per time zone moved east since the last game. */
  tzEast: 0,
  /** Make-probability factor for a visitor at altitude (Denver, Utah). */
  altitude: 0,
  /** Weight on each team's own home edge (vs the league's). */
  homeTeam: 0,
  /** Weight on the referee crew's free-throw / foul tendency. */
  refs: 0,
  /** Weight on the home scorer's assist / block / steal crediting. */
  scorer: 0,
  /** Weight on the market's total (pace) and spread (make probability). */
  mktTotal: 0,
  mktSpread: 0,
  /** Playoffs: rotation depth (9 = as in the regular season). */
  playoffDepth: 9,

  // ---- shot zones
  /** 1: twos priced by zone against this defense's rim and non-rim figures
   *  (in place of its overall two-point factor). */
  zones: 0,
  /** Weight on the shooter's rim share in how often a missed two is blocked. */
  zoneBlk: 0,
  /** Weight on the shooter's own assisted share in whether a make is assisted. */
  zoneAst: 0,
};

export type NbaKnobs = typeof NBA_KNOBS;

/** For the backtest: override knobs from a JSON object. */
export function setNbaKnobs(o: Partial<NbaKnobs>): void {
  for (const [k, v] of Object.entries(o))
    if (k in NBA_KNOBS && typeof v === "number") (NBA_KNOBS as Record<string, number>)[k] = v;
}
