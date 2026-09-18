/**
 * nfl-props-reasons.ts — why the board likes a prop, read out of the model.
 *
 * Every phrase here is the model's own arithmetic restated in words. For a
 * logistic, a feature's contribution to the log-odds is
 *
 *     coef[i] * ((x[i] - mean[i]) / std[i])
 *
 * which is exactly "how far this player is from an average qualifying player on
 * this input, times how much this market cares about it". Ranking those and
 * naming the top few gives a reason that cannot drift from the number beside
 * it, because it IS the number beside it. Nothing here is written by hand about
 * a player, and nothing is an LLM's opinion.
 *
 * WHY EACH MARKET GETS ITS OWN ATTRIBUTION. The fourteen markets are fourteen
 * separate fits. Target share is most of the story for 7+ receptions and nearly
 * irrelevant to 80+ rushing yards, and the coefficients already know that — so
 * the same player can surface with different reasons on two rungs, which is
 * correct rather than inconsistent.
 *
 * TWO RULES THE PHRASES OBEY:
 *
 *   gate on the raw value, not the contribution. A player can have a large
 *   positive push on `catch` while catching 58% of his targets, which is not
 *   worth printing. Every phrase checks the actual number is worth saying.
 *
 *   never let a caveat lose to a compliment. A three-game window is the one
 *   thing that qualifies every other number on the card, and it is stated
 *   unconditionally rather than competing for a slot.
 */

export type PropReasonContext = {
  /** The market key, e.g. "rushy40". The reason a prop is doubted has to come
   *  from the channel the prop is ABOUT: a back's target share is not why he
   *  misses 40 rushing yards, however much the coefficient dislikes it. */
  market: string;
  team: string;
  opponent: string;
  /** Games of this player's history inside the team's last-8 window. */
  games: number;
  /** How many of those games cleared this exact market, and out of how many.
   *  The raw count, not the shrunk rate the model sees — "6 of his last 8" is
   *  both more useful and more honest than "a 0.71 shrunk rate". */
  ownHits: number;
  ownOf: number;
};

export type PropSpec = {
  features: string[];
  coef: number[];
  mean: number[];
  std: number[];
};

/** A phrase sees its own feature's value, the context, and every other feature
 *  — because a share is only meaningful for a player who operates in that
 *  channel, and the model has no position field to key that off. A receiver
 *  with a rounding error of a carry share should not be faulted for it. */
type Feats = Record<string, number>;
type Phrase = (v: number, c: PropReasonContext, f: Feats) => string | null;

/** Enough of a runner / receiver for a share or an efficiency rate about that
 *  channel to be worth printing at all. */
const RUNS = (f: Feats) => (f.car_pg_l ?? 0) >= 3;
const CATCHES = (f: Feats) => (f.tgt_pg_l ?? 0) >= 2;

/** Which channel a market is about. Scrimmage yards is genuinely both. */
function channel(market: string): "rush" | "recv" | "both" | "pass" {
  if (market.startsWith("rushy")) return "rush";
  if (market.startsWith("rec")) return "recv";
  if (market.startsWith("scrim")) return "both";
  return "pass";
}
const ABOUT_RUSH = (c: PropReasonContext) =>
  channel(c.market) === "rush" || channel(c.market) === "both";
const ABOUT_RECV = (c: PropReasonContext) =>
  channel(c.market) === "recv" || channel(c.market) === "both";

const n0 = (v: number) => Math.round(v).toString();
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Below this many games in the window, the sample is the headline. */
const THIN_WINDOW = 4;

/**
 * Reasons FOR, keyed by feature. Each gates on the raw value so the board never
 * prints a number that does not deserve a line.
 *
 * The short-window twins (`_s`) are deliberately absent where a long-window
 * version exists: they say the same thing about the same player and only one of
 * them should take a slot. `overlaps` catches the rest.
 */
const FOR: Record<string, Phrase> = {
  car_pg_l: (v) => (v >= 8 ? `${n1(v)} carries a game` : null),
  tgt_pg_l: (v) => (v >= 4 ? `${n1(v)} targets a game` : null),
  rec_pg_l: (v) => (v >= 3 ? `${n1(v)} catches a game` : null),
  ry_pg_l: (v) => (v >= 35 ? `${n0(v)} rushing yards a game` : null),
  cy_pg_l: (v) => (v >= 35 ? `${n0(v)} receiving yards a game` : null),
  scrim_pg_l: (v) => (v >= 60 ? `${n0(v)} scrimmage yards a game` : null),
  carry_share: (v, _c, f) => (RUNS(f) && v >= 0.45 ? `${pct(v)} of the team's carries` : null),
  target_share: (v, _c, f) => (CATCHES(f) && v >= 0.2 ? `${pct(v)} of the team's targets` : null),
  ypc: (v, _c, f) => (RUNS(f) && v >= 4.6 ? `${n1(v)} yards a carry` : null),
  ypr: (v, _c, f) => (CATCHES(f) && v >= 12 ? `${n1(v)} yards a catch` : null),
  catch: (v, _c, f) => ((f.tgt_pg_l ?? 0) >= 3 && v >= 0.72 ? `catches ${pct(v)} of his targets` : null),
  team_plays_pg: (v) => (v >= 64 ? `${n0(v)} plays a game` : null),
  team_pass_rate: (v) => (v >= 0.6 ? `throws on ${pct(v)} of snaps` : null),
  opp_rush_ypg: (v, c) => (v >= 125 ? `${c.opponent} concede ${n0(v)} rushing yards a game` : null),
  opp_pass_ypg: (v, c) => (v >= 235 ? `${c.opponent} concede ${n0(v)} passing yards a game` : null),
  is_home: (v) => (v > 0.5 ? "at home" : null),
  mkt_implied_total: (v, c) => (v >= 24 ? `${c.team} implied for ${n1(v)} points` : null),
  mkt_total: (v) => (v >= 47 ? `${n1(v)}-point total` : null),
  mkt_margin: (v, c) => (v >= 4 ? `${c.team} favoured by ${n0(v)}` : null),
  // The player's own record against this exact line. Quoted from the raw count
  // rather than the shrunk feature the model consumes, and only when the window
  // is long enough for a fraction to mean anything.
  own_l: (_v, c) =>
    c.ownOf >= 4 && c.ownHits / c.ownOf >= 0.5
      ? `cleared this in ${c.ownHits} of his last ${c.ownOf}`
      : null,
};

/** Reasons AGAINST — the single strongest thing arguing the other way. */
const AGAINST: Record<string, Phrase> = {
  hist_g: (v) => (v <= THIN_WINDOW ? `only ${n0(v)} game${v === 1 ? "" : "s"} in the window` : null),
  season_gp: (v) => (v <= 1 ? "almost none of the window is from this season" : null),
  carry_share: (v, c, f) =>
    ABOUT_RUSH(c) && RUNS(f) && v <= 0.25 ? `only ${pct(v)} of the team's carries` : null,
  target_share: (v, c, f) =>
    ABOUT_RECV(c) && CATCHES(f) && v <= 0.12 ? `only ${pct(v)} of the team's targets` : null,
  // A back catching 58% of five targets is not the reason to fade him, so this
  // only speaks for players the passing game actually runs through.
  catch: (v, c, f) =>
    ABOUT_RECV(c) && (f.tgt_pg_l ?? 0) >= 4 && v <= 0.58
      ? `catches ${pct(v)} of his targets`
      : null,
  ypc: (v, c, f) =>
    ABOUT_RUSH(c) && RUNS(f) && v > 0 && v <= 3.8 ? `${n1(v)} yards a carry` : null,
  opp_rush_ypg: (v, c) =>
    ABOUT_RUSH(c) && v > 0 && v <= 95 ? `${c.opponent} allow ${n0(v)} rushing yards a game` : null,
  opp_pass_ypg: (v, c) =>
    (ABOUT_RECV(c) || channel(c.market) === "pass") && v > 0 && v <= 190
      ? `${c.opponent} allow ${n0(v)} passing yards a game`
      : null,
  mkt_margin: (v, c) => (v <= -5 ? `${c.team} ${n0(-v)}-point underdogs` : null),
  mkt_implied_total: (v, c) => (v > 0 && v <= 18 ? `${c.team} implied for only ${n1(v)}` : null),
  own_l: (_v, c) =>
    c.ownOf >= 4 && c.ownHits / c.ownOf <= 0.25
      ? `cleared this in ${c.ownHits} of his last ${c.ownOf}`
      : null,
};

/** Two phrases about the same underlying thing; keep the stronger. */
const SAME_IDEA: string[][] = [
  ["carries a game", "of the team's carries", "yards a carry"],
  ["targets a game", "catches a game", "of the team's targets", "catches"],
  ["rushing yards a game", "scrimmage yards a game"],
  ["receiving yards a game", "yards a catch"],
  ["implied for", "-point total", "favoured by"],
];

function overlaps(a: string, b: string): boolean {
  return SAME_IDEA.some((group) => group.some((g) => a.includes(g)) && group.some((g) => b.includes(g)));
}

/**
 * The top few reasons this market likes this player, and the strongest thing
 * against, both read out of the fitted coefficients.
 */
export function explainProp(
  spec: PropSpec,
  x: number[],
  ctx: PropReasonContext,
  limit = 3,
): { reasons: string[]; against: string | null } {
  const contributions = spec.features.map((name, i) => ({
    name,
    value: x[i],
    push: spec.coef[i] * ((x[i] - spec.mean[i]) / spec.std[i]),
  }));
  const feats: Feats = Object.fromEntries(spec.features.map((name, i) => [name, x[i]]));

  const reasons: string[] = [];
  for (const c of [...contributions].sort((a, b) => b.push - a.push)) {
    if (c.push <= 0) break; // nothing below here argues for the pick
    const phrase = FOR[c.name]?.(c.value, ctx, feats);
    if (!phrase) continue;
    if (reasons.some((r) => overlaps(r, phrase))) continue;
    reasons.push(phrase);
    if (reasons.length === limit) break;
  }

  // A thin window qualifies every other number on the card, so it is stated
  // rather than entered into a competition for the one `against` slot.
  if (ctx.games <= THIN_WINDOW) {
    return {
      reasons,
      against: `only ${ctx.games} game${ctx.games === 1 ? "" : "s"} of form behind this`,
    };
  }

  let against: string | null = null;
  for (const c of [...contributions].sort((a, b) => a.push - b.push)) {
    if (c.push >= 0) break;
    const phrase = AGAINST[c.name]?.(c.value, ctx, feats);
    if (phrase) {
      against = phrase;
      break;
    }
  }
  return { reasons, against };
}
