/**
 * td-reasons.ts — why the model likes a touchdown pick, in plain English.
 *
 * The honest way to explain a linear model is to read its own arithmetic back
 * out. For a logistic regression, each feature's push on the log-odds is
 * exactly `coef[i] * (x[i] - mean[i]) / std[i]` — so ranking those tells you
 * which facts about this player, in this game, actually moved the number, and
 * by how much relative to each other.
 *
 * The alternative — writing plausible-sounding sentences about carries and
 * red-zone looks — produces text that reads better and drifts from the model
 * the first time anything is refitted. This cannot drift: if a coefficient
 * changes sign, the sentence changes with it.
 *
 * Two deliberate choices:
 *
 *   The caveat is shown too. The largest NEGATIVE contribution is surfaced
 *   when it is material, because "62%, and here is the one thing arguing
 *   against it" is more use than three reasons to feel good.
 *
 *   Maturity terms never appear as a reason. `gp` counts how much evidence
 *   there is, not how good the player is; "he has played eight games" is not a
 *   reason to expect a touchdown. It can still appear as a caveat, where
 *   thin evidence genuinely is the thing to know.
 */

export type ModelSpec = {
  features: string[];
  mean: number[];
  std: number[];
  coef: number[];
};

/** Renders one feature's raw value as a phrase, or null to stay silent. */
type Phrase = (v: number, ctx: ReasonContext) => string | null;

export type ReasonContext = {
  /** Games of usage behind the numbers. */
  games: number;
  team: string;
  opponent?: string;
  /** Carries and catches per game. A shrunk rate on no volume is the league
   *  prior wearing the player's name — "scores on 4% of his carries" for a
   *  tight end with no carries is the model's default, not a fact about him —
   *  so every rate phrase is gated on the volume behind it. */
  carries?: number;
  catches?: number;
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * Feature → phrase. A feature absent from the map is silent, which is how
 * maturity terms and anything not worth a sentence are kept out.
 */
const PHRASES: Record<string, Phrase> = {
  carry_share: (v) => (v >= 0.12 ? `takes ${pct(v)} of the team's carries` : null),
  rec_share: (v) => (v >= 0.12 ? `${pct(v)} of the team's catches` : null),
  target_share: (v) => (v >= 0.12 ? `${pct(v)} of the team's targets` : null),
  cpg: (v) => (v >= 4 ? `${one(v)} carries a game` : null),
  rpg: (v) => (v >= 2 ? `${one(v)} catches a game` : null),
  tpg: (v) => (v >= 3 ? `${one(v)} targets a game` : null),
  rush_ypg: (v) => (v >= 25 ? `${Math.round(v)} rushing yards a game` : null),
  rec_ypg: (v) => (v >= 25 ? `${Math.round(v)} receiving yards a game` : null),
  rush_td_rate: (v, c) =>
    v >= 0.04 && (c.carries ?? 0) >= 3 ? `scores on ${pct(v)} of his carries` : null,
  rec_td_rate: (v, c) =>
    v >= 0.06 && (c.catches ?? 0) >= 1.5 ? `scores on ${pct(v)} of his catches` : null,
  // Shown as a rate, not a count. It is shrunk toward the league's ~24%, so
  // turning it into "3 of his last 5" invents a record he may not have — and
  // it only says anything at all once it is clear of that prior.
  anytime_rate: (v) => (v >= 0.32 ? `scores in ${pct(v)} of his games` : null),
  team_rush_tdpg: (v, c) => (v >= 0.8 ? `${c.team} run in ${one(v)} touchdowns a game` : null),
  team_rec_tdpg: (v, c) => (v >= 0.8 ? `${c.team} throw ${one(v)} touchdowns a game` : null),
  opp_rush_td_allowed_pg: (v, c) =>
    v >= 1 ? `${c.opponent ?? "the defence"} give up ${one(v)} rushing touchdowns a game` : null,
  opp_rec_td_allowed_pg: (v, c) =>
    v >= 1 ? `${c.opponent ?? "the defence"} give up ${one(v)} receiving touchdowns a game` : null,
  is_home: (v) => (v >= 0.5 ? "at home" : null),
  proj_team_pts: (v, c) => `${c.team} projected for ${Math.round(v)} points`,
  mkt_implied_total: (v, c) => `${c.team} implied for ${Math.round(v)} points`,
  proj_total: (v) => (v >= 45 ? `a projected ${Math.round(v)}-point game` : null),
  mkt_total: (v) => (v >= 44 ? `total set at ${one(v)}` : null),
  elo_margin: (v, c) =>
    Math.abs(v) < 2
      ? null
      : v > 0
        ? `${c.team} favoured by ${Math.round(v)}`
        : `${c.team} ${Math.round(-v)}-point underdogs`,
  mkt_team_margin: (v, c) =>
    Math.abs(v) < 2
      ? null
      : v > 0
        ? `${c.team} favoured by ${Math.round(v)}`
        : `${c.team} ${Math.round(-v)}-point underdogs`,
};

/**
 * Phrases for the caveat side, where the negative reading is the point.
 *
 * Usage shares are deliberately absent. A running back with 0% of the catches
 * reads as a damning statistic and is not one — it is what a running back
 * looks like. The same for a receiver with no carries. A share is only
 * meaningful against a player in the channel he actually plays in, and the
 * model has no position to key that off, so the safer thing is to let volume
 * and evidence speak instead.
 */
const AGAINST: Record<string, Phrase> = {
  gp: (v) => (v <= 4 ? `only ${Math.round(v)} games of usage behind this` : null),
  anytime_rate: (v, c) =>
    v <= 0.18 && c.games >= 4 ? `scores in only ${pct(v)} of his games` : null,
  elo_margin: (v, c) => (v <= -7 ? `${c.team} ${Math.round(-v)}-point underdogs` : null),
  mkt_team_margin: (v, c) => (v <= -7 ? `${c.team} ${Math.round(-v)}-point underdogs` : null),
  proj_team_pts: (v, c) =>
    v <= 20 ? `${c.team} projected for only ${Math.round(v)} points` : null,
  mkt_implied_total: (v, c) =>
    v <= 19 ? `${c.team} implied for only ${Math.round(v)} points` : null,
  proj_total: (v) => (v <= 42 ? `a low-scoring projection (${Math.round(v)})` : null),
  mkt_total: (v) => (v <= 41 ? `a low total (${one(v)})` : null),
  rush_td_rate: (v, c) =>
    v < 0.03 && (c.carries ?? 0) >= 5 ? `a thin ${pct(v)} touchdown rate on the ground` : null,
};

/** Below this many games, the sample is the story. */
const THIN_EVIDENCE = 5;

export type Reasoning = {
  /** Up to `limit` drivers, strongest first. */
  reasons: string[];
  /** The single biggest thing arguing against, when there is one. */
  against: string | null;
};

/**
 * Rank a pick's feature contributions and render the top few.
 *
 * `x` must be in the same order as `spec.features` — the caller builds both
 * from the same place, and both TD modules assert that order at import.
 */
export function explain(spec: ModelSpec, x: number[], ctx: ReasonContext, limit = 3): Reasoning {
  const contributions = spec.features.map((name, i) => ({
    name,
    value: x[i],
    push: spec.coef[i] * ((x[i] - spec.mean[i]) / spec.std[i]),
  }));

  const reasons: string[] = [];
  for (const c of [...contributions].sort((a, b) => b.push - a.push)) {
    if (c.push <= 0) break; // nothing below here is arguing for the pick
    const phrase = PHRASES[c.name]?.(c.value, ctx);
    if (!phrase) continue;
    // Two features can say the same thing in different words — carry share and
    // carries a game, say. Keep the stronger and move on.
    if (reasons.some((r) => overlaps(r, phrase))) continue;
    reasons.push(phrase);
    if (reasons.length === limit) break;
  }

  // Thin evidence outranks everything the coefficients have to say.
  //
  // Under the pairwise ranker `gp` carries a positive weight, so three games of
  // usage does register as a push against the pick — unlike the logistic this
  // replaced, where the coefficient came out slightly negative and a thin
  // sample argued faintly IN FAVOUR. But the honest weight is not enough on its
  // own: `against` surfaces exactly one phrase, the single most negative
  // contribution, and in September gp is routinely outvoted by a soft matchup
  // or a low target share. The caveat that qualifies every other number on the
  // card should not lose that race, so it is stated unconditionally.
  if (ctx.games < THIN_EVIDENCE)
    return { reasons, against: `only ${Math.round(ctx.games)} games of usage behind this` };

  let against: string | null = null;
  for (const c of [...contributions].sort((a, b) => a.push - b.push)) {
    if (c.push >= 0) break;
    const phrase = AGAINST[c.name]?.(c.value, ctx);
    if (phrase) {
      against = phrase;
      break;
    }
  }

  return { reasons, against };
}

/** Crude near-duplicate check: two phrases about carries, or about catches. */
function overlaps(a: string, b: string): boolean {
  const key = (s: string) =>
    /carr/.test(s)
      ? "rush"
      : /catch|target|receiv/.test(s)
        ? "rec"
        : /point|total/.test(s)
          ? "env"
          : s;
  return key(a) === key(b) && key(a) !== a;
}

/**
 * The same phrases, ranked by a model's global feature importance instead of a
 * per-pick coefficient push.
 *
 * A forest has no coefficients, so the attribution `explain` does above is not
 * available for the college model — a tree ensemble cannot say how much THIS
 * player's carry share moved THIS probability without a per-prediction
 * attribution method (SHAP and friends), which is a great deal of machinery to
 * ship for a line of card copy.
 *
 * So the ranking becomes global rather than per-pick: the forest's feature
 * importances say which facts matter most for this kind of prediction, and the
 * same volume gates as above decide which are true enough of this player to be
 * worth saying. The individual numbers are still his.
 *
 * The distinction matters and is why this is a separate function rather than a
 * flag: `explain` says "here is what moved the number for him", and this says
 * "here are the numbers that matter, for him". The second is a weaker claim,
 * and overstating it would be the kind of quiet dishonesty the phrase gates
 * above exist to prevent.
 */
export function explainByImportance(
  features: string[],
  importances: Record<string, number>,
  x: number[],
  ctx: ReasonContext,
  limit = 3,
): Reasoning {
  const ranked = features
    .map((name, i) => ({ name, value: x[i], weight: importances[name] ?? 0 }))
    .sort((a, b) => b.weight - a.weight);

  const reasons: string[] = [];
  for (const f of ranked) {
    const phrase = PHRASES[f.name]?.(f.value, ctx);
    if (!phrase) continue;
    if (reasons.some((r) => overlaps(r, phrase))) continue;
    reasons.push(phrase);
    if (reasons.length === limit) break;
  }

  // Thin evidence still outranks everything — it qualifies every number on the
  // card in September, whatever the model thinks of the features.
  if (ctx.games < THIN_EVIDENCE)
    return { reasons, against: `only ${Math.round(ctx.games)} games of usage behind this` };

  // Without per-pick attribution there is no "biggest thing arguing against",
  // so only the unambiguous caveats fire: a genuinely low scoring rate, a heavy
  // underdog, a low-scoring projection.
  let against: string | null = null;
  for (const f of ranked) {
    const phrase = AGAINST[f.name]?.(f.value, ctx);
    if (phrase) {
      against = phrase;
      break;
    }
  }
  return { reasons, against };
}
