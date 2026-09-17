/**
 * cfb-td.server.ts — touchdown-scorer picks for a college football slate.
 *
 * One or two names per game, chosen by the model rather than by a fixed slot
 * count. Held out on 2025 and 2026 the board ran 1.45 picks a game, 54.3% of
 * shown picks scored, and 65.0% of games had at least one pick score. The
 * research lives in research/cfb; CFB-ANALYSIS.md is the write-up.
 *
 * WHY THIS IS NOT nfl-td.server.ts WITH A DIFFERENT PATH
 * -----------------------------------------------------
 * Three things college does differently, each of which changed the design:
 *
 *   No market inputs. The NFL model leans on the book's implied team total.
 *   ESPN serves college lines while a game is upcoming and drops them once it
 *   is final — sampled across 2024 and 2025, historical college games return a
 *   line for none of them. A feature that cannot be backtested cannot be
 *   trusted, so game environment is built from scoring history and the Elo
 *   rating instead.
 *
 *   Receptions, not targets. ESPN publishes no college target data at all, so
 *   every receiving share here is a share of catches.
 *
 *   Season totals, not replayed box scores. The NFL module rebuilds usage by
 *   fetching a box score per team per completed game. A 70-game Saturday is 140
 *   teams; by November that is over a thousand requests and a page that times
 *   out. ESPN's roster endpoint returns each player's season-to-date rushing
 *   and receiving in one call per team, so the whole slate costs ~140 requests
 *   and about ten seconds cold.
 *
 * ON POINT-IN-TIME CORRECTNESS
 * ----------------------------
 * Season-to-date totals are "as of now", not "as of the slate date", and that
 * distinction matters. For a game that has not kicked off they are the same
 * thing — a team's season so far *is* everything before its next game — so the
 * board is honest about what it knew for every game it is actually projecting.
 * For a date in the past it is not: the totals would include the very games
 * being projected. Rather than quietly show a number built from the answer,
 * `staleFeatures` marks those slates and the page says so.
 */
import model from "./cfb-td-model.json";
import { explain } from "./td-reasons";
import { todayET } from "./date";
import { fetchScoreboard, homeEdge, teamFormAsOf, type SlateGame } from "./espn.server";

const CFB = "football/college-football";
const C = model.constants;

/**
 * Games of usage a team needs before its numbers mean anything. Below this the
 * shortfall is borrowed from last season, scaled — the same rule the model was
 * fitted under (research/cfb/features.py, `carry_fraction`).
 *
 * Without it the board would be empty on the opening Saturday of the season and
 * thin for a fortnight after, which is the biggest slate of the year to be
 * missing. With it, Week 1 reads mostly last season and the borrowed share
 * falls away by Week 5.
 */
const USAGE_WINDOW = C.USAGE_WINDOW;

/** Rating points per point of expected margin — the standard Elo scale, and
 *  the same divisor the model was fitted with. */
const ELO_PER_POINT = 25;

// ------------------------------------------------------------- inference

/** Standardize → logistic. Mirrors final.py; the self-test below proves it. */
function infer(x: number[]): number {
  let z = model.intercept;
  for (let i = 0; i < model.coef.length; i++)
    z += model.coef[i] * ((x[i] - model.mean[i]) / model.std[i]);
  return 1 / (1 + Math.exp(-z));
}

/** Replays the vectors frozen in the model file and checks this port agrees
 *  with the Python that fitted it. Called by scripts/test-cfb-td.ts. */
export function selfTest(): { ok: boolean; worst: number } {
  let worst = 0;
  for (const t of model.selftest) worst = Math.max(worst, Math.abs(infer(t.x) - t.p));
  return { ok: worst < 1e-6, worst };
}

// --------------------------------------------------------------- fetching

type Cached<T> = { at: number; v: T };
const rosterCache = new Map<string, Cached<TeamUsage | null>>();
const ROSTER_TTL = 30 * 60 * 1000; // season totals only move on game days

// A full Saturday asks for 140 rosters at once. Fired all together ESPN
// throttles them and the board comes back half empty, which looks exactly like
// "the model has no picks". Bounding the in-flight requests keeps every one of
// them landing; the slate still resolves in about ten seconds cold.
const MAX_INFLIGHT = 12;
let inflight = 0;
const waiting: (() => void)[] = [];

function release() {
  inflight--;
  waiting.shift()?.();
}

function withLimit<T>(run: () => Promise<T>): Promise<T> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return run().finally(release);
  }
  return new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      inflight++;
      run().then(resolve, reject).finally(release);
    });
  });
}

async function getJson(url: string, ms = 12000): Promise<unknown> {
  return withLimit(async () => {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`ESPN ${res.status}: ${url}`);
    return res.json();
  });
}

type PlayerUsage = {
  id: string;
  name: string;
  pos: string;
  car: number;
  rec: number;
  ry: number;
  cy: number;
  rtd: number;
  ctd: number;
};

type TeamUsage = {
  players: PlayerUsage[];
  /** Team totals, summed over the roster — the denominators for usage share. */
  car: number;
  recs: number;
  rtd: number;
  ctd: number;
};

type StatBag = Record<string, number>;

/** ESPN nests each athlete's season under splits.categories[].stats[]. */
function readSplits(stats: unknown): StatBag {
  const out: StatBag = {};
  const splits = (stats as { splits?: { categories?: unknown[] } } | undefined)?.splits;
  for (const cat of (splits?.categories ?? []) as { name?: string; stats?: unknown[] }[]) {
    if (cat.name !== "rushing" && cat.name !== "receiving") continue;
    for (const st of (cat.stats ?? []) as { name?: string; value?: number }[]) {
      if (typeof st.name === "string" && typeof st.value === "number") out[st.name] = st.value;
    }
  }
  return out;
}

/** How much of last season a team still needs. Mirrors `carry_fraction`. */
function carryFraction(currentGp: number, priorGp: number): number {
  if (priorGp < 1) return 0;
  const need = USAGE_WINDOW - currentGp;
  return need > 0 ? Math.min(1, need / priorGp) : 0;
}

/** This season's usage plus `frac` of last season's, player by player. */
function blendUsage(cur: TeamUsage, prior: TeamUsage | null, frac: number): TeamUsage {
  if (frac <= 0 || !prior) return cur;
  const byId = new Map(cur.players.map((p) => [p.id, { ...p }]));
  for (const p of prior.players) {
    const held = byId.get(p.id);
    const add = {
      car: p.car * frac,
      rec: p.rec * frac,
      ry: p.ry * frac,
      cy: p.cy * frac,
      rtd: p.rtd * frac,
      ctd: p.ctd * frac,
    };
    if (held) {
      held.car += add.car;
      held.rec += add.rec;
      held.ry += add.ry;
      held.cy += add.cy;
      held.rtd += add.rtd;
      held.ctd += add.ctd;
    } else {
      // A returning player who has not touched the ball yet this season still
      // belongs on the board — last year is the only thing anyone knows.
      byId.set(p.id, { ...p, ...add });
    }
  }
  const players = [...byId.values()];
  return {
    players,
    car: players.reduce((t, p) => t + p.car, 0),
    recs: players.reduce((t, p) => t + p.rec, 0),
    rtd: players.reduce((t, p) => t + p.rtd, 0),
    ctd: players.reduce((t, p) => t + p.ctd, 0),
  };
}

/**
 * One team's season-to-date rushing and receiving, per player.
 *
 * This is the roster, so it answers "who can score for this team on Saturday"
 * as well as "what have they done" — players who transferred out or are off the
 * roster are simply not in it, which is the filter the NFL module has to make a
 * second request for.
 */
async function fetchTeamUsage(teamId: string, season: number): Promise<TeamUsage | null> {
  const key = `${teamId}:${season}`;
  const c = rosterCache.get(key);
  if (c && Date.now() - c.at < ROSTER_TTL) return c.v;
  let v: TeamUsage | null = null;
  try {
    const d = (await getJson(
      `https://site.web.api.espn.com/apis/common/v3/sports/${CFB}/teams/${teamId}/roster?season=${season}`,
    )) as {
      positionGroups?: {
        athletes?: {
          id?: string;
          displayName?: string;
          position?: { abbreviation?: string };
          statistics?: unknown;
        }[];
      }[];
    };
    const players: PlayerUsage[] = [];
    for (const group of d.positionGroups ?? []) {
      for (const a of group.athletes ?? []) {
        if (!a?.id) continue;
        const s = readSplits(a.statistics);
        const p: PlayerUsage = {
          id: String(a.id),
          name: a.displayName ?? "",
          pos: a.position?.abbreviation ?? "",
          car: s.rushingAttempts ?? 0,
          rec: s.receptions ?? 0,
          ry: s.rushingYards ?? 0,
          cy: s.receivingYards ?? 0,
          rtd: s.rushingTouchdowns ?? 0,
          ctd: s.receivingTouchdowns ?? 0,
        };
        if (p.car + p.rec > 0) players.push(p);
      }
    }
    if (players.length > 0) {
      v = {
        players,
        car: players.reduce((t, p) => t + p.car, 0),
        recs: players.reduce((t, p) => t + p.rec, 0),
        rtd: players.reduce((t, p) => t + p.rtd, 0),
        ctd: players.reduce((t, p) => t + p.ctd, 0),
      };
    }
  } catch (err) {
    console.error(`[cfb-td roster] ${teamId} ${season}:`, err);
  }
  rosterCache.set(key, { at: Date.now(), v });
  return v;
}

// -------------------------------------------------------------- features

/** The order here is the order in model.features, and changing one without the
 *  other is the single most likely way to break this file silently — which is
 *  what assertFeatureOrder below exists to stop. */
function featureVector(
  p: PlayerUsage,
  team: TeamUsage,
  gp: number,
  isHome: boolean,
  projTeamPts: number,
  projTotal: number,
  eloMargin: number,
): number[] {
  return [
    team.car ? p.car / team.car : 0, // carry_share
    team.recs ? p.rec / team.recs : 0, // rec_share
    p.car / gp, // cpg
    p.rec / gp, // rpg
    p.ry / gp, // rush_ypg
    p.cy / gp, // rec_ypg
    (p.rtd + C.K_RUSH * C.LG_RUSH) / (p.car + C.K_RUSH), // rush_td_rate
    (p.ctd + C.K_REC * C.LG_REC) / (p.rec + C.K_REC), // rec_td_rate
    // anytime_rate is games-scored-in over games played in the backtest. The
    // roster feed gives totals, not a game log, so it is approximated by
    // capping touchdowns at one a game — which is what "did he score" means,
    // and which matches for everyone except the rare multi-score afternoon.
    (Math.min(p.rtd + p.ctd, gp) + C.K_ANY * C.LG_ANY) / (gp + C.K_ANY), // anytime_rate
    Math.min(gp, 15), // gp
    team.rtd / gp, // team_rush_tdpg
    team.ctd / gp, // team_rec_tdpg
    isHome ? 1 : 0, // is_home
    projTeamPts, // proj_team_pts
    projTotal, // proj_total
    eloMargin, // elo_margin
  ];
}

const FEATURE_ORDER = [
  "carry_share",
  "rec_share",
  "cpg",
  "rpg",
  "rush_ypg",
  "rec_ypg",
  "rush_td_rate",
  "rec_td_rate",
  "anytime_rate",
  "gp",
  "team_rush_tdpg",
  "team_rec_tdpg",
  "is_home",
  "proj_team_pts",
  "proj_total",
  "elo_margin",
];

/** Fails loudly at import if the model file and featureVector have drifted
 *  apart. Silently misaligned features still produce plausible probabilities,
 *  which is the worst possible failure mode for a page like this. */
function assertFeatureOrder() {
  const a = model.features.join(",");
  const b = FEATURE_ORDER.join(",");
  if (a !== b) throw new Error(`cfb-td feature order drift:\n  model: ${a}\n  code:  ${b}`);
}
assertFeatureOrder();

// ----------------------------------------------------------------- public

export type CfbTdPick = {
  playerId: string;
  player: string;
  position: string;
  team: string;
  /** P(scores a rushing or receiving touchdown), 0..1. */
  prob: number;
  /** Backtested tier for that probability: Strong / Solid / Lean. */
  tier: string;
  /** Held-out hit rate for picks in this tier, 0..1. */
  tierHit: number;
  /** Games of usage behind the pick. */
  games: number;
  /** Why the model likes it — read back out of its own coefficients, strongest
   *  first. See td-reasons.ts. */
  reasons: string[];
  /** The biggest thing arguing against the pick, where there is one. */
  against: string | null;
};

export type CfbTdGame = {
  gameId: number;
  date: string;
  /** True once the game has kicked off. The ledger only records picks made
   *  before that — a "prediction" written at half time is not one. */
  started: boolean;
  home: string;
  away: string;
  matchup: string;
  /** The posted total, where the scoreboard has one. Display only — never a
   *  model input, since ESPN keeps no historical college lines to fit against. */
  total: number | null;
  /** Model's expected margin for the home side, in points. */
  homeMargin: number;
  picks: CfbTdPick[];
};

const TIERS = model.tiers;

function tierFor(p: number): { label: string; hit: number } {
  for (const t of TIERS) if (p >= t.min) return { label: t.label, hit: t.hit };
  return TIERS[TIERS.length - 1];
}

/**
 * How many picks a game gets.
 *
 * The lead pick always shows. The second shows only when the model gives it at
 * least `second_pick_min` (0.45), which is where the backtest says a second
 * name stops diluting the board: below it, second picks hit in the low 40s and
 * then the 30s; at it they held ~50% across both held-out seasons, against 56%
 * for lead picks. The result is 1.45 picks a game rather than a fixed two, and
 * 54.3% of shown picks scoring rather than 50.1%.
 */
function choosePicks<T extends { prob: number }>(ranked: T[]): T[] {
  if (ranked.length === 0) return [];
  const out = [ranked[0]];
  if (ranked.length > 1 && ranked[1].prob >= model.second_pick_min) out.push(ranked[1]);
  return out;
}

/** Touchdown picks for every game on `date`. */
export async function cfbTdSlate(date: string): Promise<{
  season: number | null;
  games: CfbTdGame[];
  /** True when the slate is in the past, where season-to-date usage includes
   *  the games being projected. The page must say so rather than imply the
   *  model knew something it did not. */
  staleFeatures: boolean;
}> {
  const slate = await fetchScoreboard("cfb", date);
  if (slate.length === 0) return { season: null, games: [], staleFeatures: false };

  const { form, season, ratingOf } = await teamFormAsOf("cfb", date);
  const staleFeatures = date < todayET();
  const hfa = homeEdge("cfb");

  // One roster call per distinct team on the slate, not per team per game.
  const teamIds = [...new Set(slate.flatMap((g) => [g.home.id, g.away.id]))];

  // Early in the season, last season is needed too. `prior` is last season's
  // final standing, which costs no new fetches — the Elo replay has already
  // read and cached those results.
  const needsCarry = teamIds.some((id) => (form.get(id)?.gp ?? 0) < USAGE_WINDOW);
  const prior = needsCarry ? await teamFormAsOf("cfb", `${season}-02-01`) : null;

  const usageById = new Map<string, TeamUsage | null>();
  await Promise.all(
    teamIds.map(async (id) => {
      const gp = form.get(id)?.gp ?? 0;
      const frac = prior ? carryFraction(gp, prior.form.get(id)?.gp ?? 0) : 0;
      const [cur, last] = await Promise.all([
        fetchTeamUsage(id, season),
        frac > 0 ? fetchTeamUsage(id, season - 1) : Promise.resolve(null),
      ]);
      const merged = cur ?? (last ? { players: [], car: 0, recs: 0, rtd: 0, ctd: 0 } : null);
      usageById.set(id, merged ? blendUsage(merged, last, frac) : null);
    }),
  );

  const games: (CfbTdGame | null)[] = slate.map((g: SlateGame): CfbTdGame | null => {
    const homeUsage = usageById.get(g.home.id) ?? null;
    const awayUsage = usageById.get(g.away.id) ?? null;
    const homeForm = form.get(g.home.id);
    const awayForm = form.get(g.away.id);
    if (!homeUsage || !awayUsage || !homeForm || !awayForm) return null;

    // The denominator for every per-game rate is the team's games, topped up
    // with last season's by the same fraction the usage was. A team with one
    // game played and four borrowed is divided by five, not by one.
    const homeGp =
      homeForm.gp +
      (prior?.form.get(g.home.id)?.gp ?? 0) *
        carryFraction(homeForm.gp, prior?.form.get(g.home.id)?.gp ?? 0);
    const awayGp =
      awayForm.gp +
      (prior?.form.get(g.away.id)?.gp ?? 0) *
        carryFraction(awayForm.gp, prior?.form.get(g.away.id)?.gp ?? 0);
    if (homeGp < 1 || awayGp < 1) return null;

    // The stand-in for a market total: this offence's scoring averaged with
    // what this defence gives up, which is what a total is estimating anyway.
    const hFor = homeForm.pointsFor / homeForm.gp;
    const hAgainst = homeForm.pointsAgainst / homeForm.gp;
    const aFor = awayForm.pointsFor / awayForm.gp;
    const aAgainst = awayForm.pointsAgainst / awayForm.gp;
    const projHome = (hFor + aAgainst) / 2;
    const projAway = (aFor + hAgainst) / 2;
    const projTotal = projHome + projAway;

    const edge = g.neutral ? 0 : hfa;
    const homeMargin = (ratingOf(g.home.id) - ratingOf(g.away.id) + edge) / ELO_PER_POINT;

    const cand: CfbTdPick[] = [];
    const sides: [TeamUsage, number, boolean, string, number, number][] = [
      [homeUsage, homeGp, true, g.home.abbr, projHome, homeMargin],
      [awayUsage, awayGp, false, g.away.abbr, projAway, -homeMargin],
    ];
    for (const [usage, teamGames, isHome, abbr, projPts, margin] of sides) {
      const gp = Math.max(1, teamGames);
      for (const p of usage.players) {
        if (p.car + p.rec < 1) continue;
        const x = featureVector(p, usage, gp, isHome, projPts, projTotal, margin);
        const prob = infer(x);
        const t = tierFor(prob);
        const { reasons, against } = explain(model, x, {
          games: gp,
          team: abbr,
          opponent: isHome ? g.away.abbr : g.home.abbr,
          carries: p.car / gp,
          catches: p.rec / gp,
        });
        cand.push({
          playerId: p.id,
          player: p.name,
          position: p.pos,
          team: abbr,
          prob,
          tier: t.label,
          tierHit: t.hit,
          games: Math.round(gp),
          reasons,
          against,
        });
      }
    }
    if (cand.length === 0) return null;
    cand.sort((a, b) => b.prob - a.prob);

    return {
      gameId: g.id,
      date: g.date,
      started: g.state !== "pre",
      home: g.home.abbr,
      away: g.away.abbr,
      matchup: `${g.away.abbr} @ ${g.home.abbr}`,
      total: g.total,
      homeMargin,
      picks: choosePicks(cand),
    };
  });

  return { season, games: games.filter((g): g is CfbTdGame => g !== null), staleFeatures };
}

/** The headline backtest numbers, so the page can quote them without a second
 *  source of truth drifting away from the model file. */
export const CFB_TD_BACKTEST = model.holdout;
