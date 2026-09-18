/**
 * nfl-props.server.ts — live NFL player-prop projections for a slate.
 *
 * Fourteen markets: the receptions ladder (3+/5+/7+), receiving yards
 * (40+/60+/80+), rushing yards (40+/60+/80+), scrimmage yards (60+/90+) and
 * for quarterbacks passing yards (225+/275+) and 2+ passing touchdowns. Each
 * is its own logistic model over trailing usage, team pace, the opposing
 * defence and the market's line, trained in research/nfl-props on 2021-24,
 * tested on 2025, and frozen in nfl-props-model.json. See NFL-PROPS-BACKTEST.md.
 *
 * Anytime touchdowns are deliberately NOT here. The TD Scorers page already
 * prices that event with its own model; quoting the same question twice from
 * two models is how a board ends up contradicting itself.
 *
 * Windows are TRAILING GAMES and they cross the season boundary — "this
 * player's last 8 games", not "this season so far" — so Week 1 has real
 * features instead of an empty board. The same definitions live in
 * research/nfl-props/features.py, and the model file ships selftest vectors
 * that prove this file computes what that one trained.
 *
 * Availability is applied before anything is ranked: a player the injury report
 * has ruled out cannot record a reception, so he is removed rather than
 * discounted. In the held-out season 20.3% of the picks this board would
 * otherwise have shown went to someone who never took the field.
 */
import model from "./nfl-props-model.json";
import {
  fetchActiveRoster,
  fetchGameContext,
  fetchSummary,
  trailingTeamGames,
  type BoxPlayer,
  type BoxTeam,
  type PlayerStatus,
} from "./nfl-espn.server";
import { fetchScoreboard, seasonOf, type SlateGame } from "./espn.server";
import { explainProp } from "./nfl-props-reasons";
import { todayET } from "./date";

const C = model.constants;
const W_SHORT = C.W_SHORT;
const W_LONG = C.W_LONG;

type MarketModel = {
  label: string;
  kind: string;
  features: string[];
  mean: number[];
  std: number[];
  coef: number[];
  intercept: number;
  plattA: number;
  plattB: number;
  base: number;
  tiers: { minProb: number; label: string; hitRate: number; n: number }[];
  metrics: Record<string, number>;
};
const MARKETS = model.markets as unknown as Record<string, MarketModel>;

/** Standardize → logistic → Platt, the same three lines train.py exported. */
function infer(m: MarketModel, x: number[]): number {
  let z = m.intercept;
  for (let i = 0; i < m.coef.length; i++) z += m.coef[i] * ((x[i] - m.mean[i]) / m.std[i]);
  const raw = 1 / (1 + Math.exp(-z));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(m.plattA * lg + m.plattB)));
}

function tierFor(m: MarketModel, p: number) {
  for (const t of m.tiers ?? []) if (p >= t.minProb) return t;
  return null;
}

const shrink = (num: number, den: number, prior: number, k: number) =>
  den + k > 0 ? (num + k * prior) / (den + k) : prior;

// ------------------------------------------------------------------ windows

/** A player's line in one past game, plus that game's team and opponent totals. */
type Appearance = {
  p: BoxPlayer;
  team: BoxTeam;
  opp: BoxTeam;
  season: number;
  /** Index of the game within the team's window — what separates short from long. */
  gi: number;
};

type Windows = {
  short: Appearance[];
  long: Appearance[];
  seasonGp: number;
  /** How many of the long window came from an earlier season. */
  carried: number;
};

const sumP = (rows: Appearance[], f: (p: BoxPlayer) => number) =>
  rows.reduce((s, r) => s + f(r.p), 0);
const sumT = (rows: Appearance[], f: (t: BoxTeam) => number) =>
  rows.reduce((s, r) => s + f(r.team), 0);
const sumO = (rows: Appearance[], f: (t: BoxTeam) => number) =>
  rows.reduce((s, r) => s + f(r.opp), 0);

/** Market context: the total, this team's implied total and expected margin. */
function marketContext(
  odds: { total: number; homeSpread: number } | null,
  isHome: boolean,
): [number, number, number, number] {
  const known = odds ? 1 : 0;
  const total = odds ? odds.total : C.DEFAULT_TOTAL;
  const hs = odds ? odds.homeSpread : 0;
  const implied = isHome ? total / 2 - hs / 2 : total / 2 + hs / 2;
  const margin = isHome ? -hs : hs;
  return [total, implied, margin, known];
}

/**
 * The skill-position feature vector, in the order features.py emits it.
 * Any change here is a change there; the selftest at the bottom of this file's
 * model catches a divergence the moment it happens.
 */
function skillVector(
  w: Windows,
  teamGames: Appearance[],
  oppGames: Appearance[],
  isHome: boolean,
  ctx: [number, number, number, number],
  ownL: number,
  ownS: number,
): number[] {
  const hs = w.short;
  const hl = w.long;
  const gs = Math.max(hs.length, 1);
  const gl = Math.max(hl.length, 1);
  // Team volume comes from the TEAM's window — a player who missed three games
  // still ran behind a full-strength offence in them, and his usage share is a
  // share of what that offence actually did.
  const tg = Math.max(teamGames.length, 1);
  const og = Math.max(oppGames.length, 1);
  const teamCar = sumT(teamGames, (t) => t.car);
  const teamTgt = sumT(teamGames, (t) => t.tgt);
  const teamPatt = sumT(teamGames, (t) => t.patt);
  const plays = teamCar + teamPatt;
  const [total, implied, margin, known] = ctx;
  return [
    Math.min(hl.length, W_LONG),
    Math.min(w.seasonGp, W_LONG),
    sumP(hs, (p) => p.car) / gs,
    sumP(hl, (p) => p.car) / gl,
    sumP(hs, (p) => p.tgt) / gs,
    sumP(hl, (p) => p.tgt) / gl,
    sumP(hl, (p) => p.rec) / gl,
    sumP(hs, (p) => p.ry) / gs,
    sumP(hl, (p) => p.ry) / gl,
    sumP(hs, (p) => p.cy) / gs,
    sumP(hl, (p) => p.cy) / gl,
    (sumP(hl, (p) => p.ry) + sumP(hl, (p) => p.cy)) / gl,
    shrink(
      sumP(hl, (p) => p.ry),
      sumP(hl, (p) => p.car),
      C.LG.ypc,
      C.K.ypc,
    ),
    shrink(
      sumP(hl, (p) => p.cy),
      sumP(hl, (p) => p.rec),
      C.LG.ypr,
      C.K.ypr,
    ),
    shrink(
      sumP(hl, (p) => p.rec),
      sumP(hl, (p) => p.tgt),
      C.LG.catch,
      C.K.catch,
    ),
    teamCar ? sumP(hl, (p) => p.car) / teamCar : 0,
    teamTgt ? sumP(hl, (p) => p.tgt) / teamTgt : 0,
    plays / tg,
    plays ? teamPatt / plays : 0.55,
    // What the opponent's defence has given up, over the OPPONENT's window.
    sumO(oppGames, (t) => t.ry) / og,
    sumO(oppGames, (t) => t.py) / og,
    isHome ? 1 : 0,
    total,
    implied,
    margin,
    known,
    ownL,
    ownS,
  ];
}

/** The quarterback feature vector, in the order features.py emits it. */
function qbVector(
  w: Windows,
  teamGames: Appearance[],
  oppGames: Appearance[],
  isHome: boolean,
  ctx: [number, number, number, number],
  ownL: number,
  ownS: number,
): number[] {
  const hs = w.short;
  const hl = w.long;
  const gs = Math.max(hs.length, 1);
  const gl = Math.max(hl.length, 1);
  const tg = Math.max(teamGames.length, 1);
  const og = Math.max(oppGames.length, 1);
  const teamCar = sumT(teamGames, (t) => t.car);
  const teamPatt = sumT(teamGames, (t) => t.patt);
  const plays = teamCar + teamPatt;
  const [total, implied, margin, known] = ctx;
  return [
    Math.min(hl.length, W_LONG),
    Math.min(w.seasonGp, W_LONG),
    sumP(hs, (p) => p.patt) / gs,
    sumP(hl, (p) => p.patt) / gl,
    sumP(hs, (p) => p.py) / gs,
    sumP(hl, (p) => p.py) / gl,
    sumP(hl, (p) => p.ptd) / gl,
    sumP(hl, (p) => p.intc) / gl,
    shrink(
      sumP(hl, (p) => p.py),
      sumP(hl, (p) => p.patt),
      C.LG.ypa,
      C.K.ypa,
    ),
    shrink(
      sumP(hl, (p) => p.cmp),
      sumP(hl, (p) => p.patt),
      C.LG.cmp,
      C.K.cmp,
    ),
    plays / tg,
    plays ? teamPatt / plays : 0.55,
    sumO(oppGames, (t) => t.py) / og,
    isHome ? 1 : 0,
    total,
    implied,
    margin,
    known,
    ownL,
    ownS,
  ];
}

/** Did this market hit in a past game? Mirrors MARKETS in features.py. */
const HIT: Record<string, (p: BoxPlayer) => boolean> = {
  rec3: (p) => p.rec >= 3,
  rec5: (p) => p.rec >= 5,
  rec7: (p) => p.rec >= 7,
  recy40: (p) => p.cy >= 40,
  recy60: (p) => p.cy >= 60,
  recy80: (p) => p.cy >= 80,
  rushy40: (p) => p.ry >= 40,
  rushy60: (p) => p.ry >= 60,
  rushy80: (p) => p.ry >= 80,
  scrim60: (p) => p.ry + p.cy >= 60,
  scrim90: (p) => p.ry + p.cy >= 90,
  passy225: (p) => p.py >= 225,
  passy275: (p) => p.py >= 275,
  passtd2: (p) => p.ptd >= 2,
};

// ---------------------------------------------------------------- gathering

type TeamHistory = {
  /** Athlete id → their trailing appearances, oldest first. */
  players: Map<string, Appearance[]>;
  names: Map<string, string>;
  /** Team games in the long window, oldest first. */
  games: Appearance[];
  carried: number;
  seasonGames: number;
};

/**
 * One team's trailing window: the last W_LONG completed games before `date`,
 * with each game's box score resolved into this team's line, the team totals
 * and what the opponent put up (which is what this defence gave up).
 */
async function teamHistory(
  teamAbbr: string,
  teamId: string,
  season: number,
  beforeDate: string,
): Promise<TeamHistory> {
  const { games, carried } = await trailingTeamGames(teamId, season, beforeDate, W_LONG);
  const boxes = await Promise.all(games.map((g) => fetchSummary(g.id)));
  const players = new Map<string, Appearance[]>();
  const names = new Map<string, string>();
  const teamGames: Appearance[] = [];
  let seasonGames = 0;

  games.forEach((g, i) => {
    const box = boxes[i];
    if (!box || box.date >= beforeDate) return; // never read the slate's own day
    const mine = box.teams.find((t) => t.abbr === teamAbbr);
    const opp = box.teams.find((t) => t.abbr !== teamAbbr);
    if (!mine || !opp) return;
    const gameSeason = i < carried ? season - 1 : season;
    if (gameSeason === season) seasonGames++;
    // A synthetic "team" appearance so team and opponent totals share one shape.
    const gi = teamGames.length;
    teamGames.push({
      p: mine.players[0] ?? ({} as BoxPlayer),
      team: mine,
      opp,
      season: gameSeason,
      gi,
    });
    for (const p of mine.players) {
      names.set(p.id, p.name || names.get(p.id) || "");
      const list = players.get(p.id) ?? [];
      list.push({ p, team: mine, opp, season: gameSeason, gi });
      players.set(p.id, list);
    }
  });

  return { players, names, games: teamGames, carried, seasonGames };
}

/** A player's windows inside the team's. The short window is his appearances in
 *  the team's last W_SHORT games — not his own last W_SHORT — so a player who
 *  has missed a fortnight reads as absent from recent form rather than
 *  borrowing usage from a month ago. */
function windowsFor(appearances: Appearance[], team: TeamHistory, season: number): Windows {
  const shortFrom = team.games.length - W_SHORT;
  return {
    short: appearances.filter((a) => a.gi >= shortFrom),
    long: appearances,
    seasonGp: team.games.filter((g) => g.season === season).length,
    carried: appearances.filter((a) => a.season !== season).length,
  };
}

// ------------------------------------------------------------------- public

export type PropPick = {
  playerId: string;
  player: string;
  team: string;
  kind: "skill" | "qb";
  market: string;
  label: string;
  prob: number;
  base: number;
  /** prob − base: how far above a random qualifying player this is. */
  edge: number;
  tier: string | null;
  tierHitRate: number | null;
  /** Why this market likes him, read back out of ITS OWN coefficients — the
   *  fourteen markets are fourteen fits, so the same player can surface with
   *  different reasons on two rungs. See nfl-props-reasons.ts. */
  reasons: string[];
  /** The strongest thing arguing the other way, or a thin-window caveat. */
  against: string | null;
  /** Listed as questionable — see `cautions`. Never a player ruled out. */
  questionable: boolean;
  cautions: string[];
  opponent: string;
  /** The feature vector, only when the parity test asks for it. */
  x?: number[];
};

export type PropGame = {
  gameId: number;
  date: string;
  home: string;
  away: string;
  matchup: string;
  total: number | null;
  /** True when either side's window still reaches back into last season. */
  carryover: boolean;
  /** Players removed because the injury report ruled them out. */
  ruledOut: { name: string; team: string; status: string }[];
  picks: PropPick[];
};

export type PropsSlate = {
  season: number | null;
  games: PropGame[];
  markets: { key: string; label: string; kind: string; base: number; auc: number }[];
};

/** Picks kept per game before the board does its own filtering. Every rung of
 *  every ladder for every qualifying player is a few hundred rows a game; the
 *  board shows five. `keepPerGame` is raised only by the parity test, which
 *  needs to compare every row the model priced. */
const PER_GAME_KEEP = 40;

export async function propsSlate(
  date: string,
  opts?: { keepPerGame?: number; includeVectors?: boolean },
): Promise<PropsSlate> {
  const keep = opts?.keepPerGame ?? PER_GAME_KEEP;
  const markets = Object.entries(MARKETS).map(([key, m]) => ({
    key,
    label: m.label,
    kind: m.kind,
    base: m.base,
    auc: m.metrics.auc,
  }));
  const season = seasonOf("nfl", date);
  const slate = await fetchScoreboard("nfl", date);
  if (season == null || slate.length === 0) return { season, games: [], markets };

  // The roster and the injury report only describe today. ESPN serves the
  // CURRENT injury list even when asked about a game from 2023, so applying
  // either to an old slate would rule players out of games they in fact played.
  // Both are therefore live-season only.
  const liveSeason = seasonOf("nfl", todayET()) === season;

  const games = await Promise.all(
    slate.map(async (g: SlateGame): Promise<PropGame | null> => {
      const [ctxGame, homeHist, awayHist, homeRoster, awayRoster] = await Promise.all([
        fetchGameContext(g.id),
        teamHistory(g.home.abbr, g.home.id, season, date),
        teamHistory(g.away.abbr, g.away.id, season, date),
        liveSeason ? fetchActiveRoster(g.home.id) : Promise.resolve(null),
        liveSeason ? fetchActiveRoster(g.away.id) : Promise.resolve(null),
      ]);

      const picks: PropPick[] = [];
      const ruledOut: { name: string; team: string; status: string }[] = [];

      for (const [hist, oppHist, roster, abbr, oppAbbr, isHome] of [
        [homeHist, awayHist, homeRoster, g.home.abbr, g.away.abbr, true],
        [awayHist, homeHist, awayRoster, g.away.abbr, g.home.abbr, false],
      ] as [TeamHistory, TeamHistory, Set<string> | null, string, string, boolean][]) {
        if (hist.games.length === 0) continue;
        const ctx = marketContext(ctxGame.odds, isHome);

        for (const [pid, appearances] of hist.players) {
          const name = hist.names.get(pid) ?? "";
          const status: PlayerStatus | undefined = liveSeason ? ctxGame.status.get(pid) : undefined;

          // Ruled out: cannot record a stat, so he leaves the board rather than
          // being priced down. This is the whole injury feature; the research
          // found no measurable gain from redistributing his usage on top.
          if (status?.availability === "out") {
            if (appearances.length >= C.MIN_GAMES) {
              ruledOut.push({ name, team: abbr, status: status.label });
            }
            continue;
          }
          // Off the roster entirely — traded, released, on IR without a
          // week-by-week designation.
          if (roster && !roster.has(pid)) continue;

          const w = windowsFor(appearances, hist, season);
          if (w.long.length < C.MIN_GAMES) continue;
          const touches = sumP(w.long, (p) => p.car) + sumP(w.long, (p) => p.tgt);
          const attempts = sumP(w.long, (p) => p.patt);
          const kinds: ("skill" | "qb")[] = [];
          if (touches >= C.MIN_SKILL_TOUCHES) kinds.push("skill");
          if (attempts >= C.MIN_QB_ATTEMPTS) kinds.push("qb");
          if (kinds.length === 0) continue;

          const cautions: string[] = [];
          const questionable = status?.availability === "questionable";
          if (questionable) {
            cautions.push(
              `Listed ${status!.label.toLowerCase()} — the projection assumes a normal workload.`,
            );
          }
          if (w.carried > 0) {
            cautions.push(`${w.carried} of the last ${w.long.length} games are from last season.`);
          }

          for (const [key, m] of Object.entries(MARKETS)) {
            if (!kinds.includes(m.kind as "skill" | "qb")) continue;
            const hit = HIT[key];
            const ownL = shrink(
              w.long.filter((a) => hit(a.p)).length,
              w.long.length,
              m.base,
              C.K.own_l,
            );
            const ownS = shrink(
              w.short.filter((a) => hit(a.p)).length,
              w.short.length,
              m.base,
              C.K.own_l,
            );
            const x =
              m.kind === "skill"
                ? skillVector(w, hist.games, oppHist.games, isHome, ctx, ownL, ownS)
                : qbVector(w, hist.games, oppHist.games, isHome, ctx, ownL, ownS);
            const prob = infer(m, x);
            const t = tierFor(m, prob);
            const { reasons, against } = explainProp(m, x, {
              market: key,
              team: abbr,
              opponent: oppAbbr,
              games: w.long.length,
              ownHits: w.long.filter((a) => hit(a.p)).length,
              ownOf: w.long.length,
            });
            picks.push({
              playerId: pid,
              player: name,
              team: abbr,
              kind: m.kind as "skill" | "qb",
              market: key,
              label: m.label,
              prob,
              base: m.base,
              edge: prob - m.base,
              tier: t?.label ?? null,
              tierHitRate: t?.hitRate ?? null,
              reasons,
              against,
              questionable,
              cautions,
              opponent: oppAbbr,
              ...(opts?.includeVectors ? { x } : {}),
            });
          }
        }
      }

      if (picks.length === 0) return null;
      picks.sort((a, b) => b.edge - a.edge);
      return {
        gameId: g.id,
        date: g.date,
        home: g.home.abbr,
        away: g.away.abbr,
        matchup: `${g.away.abbr} @ ${g.home.abbr}`,
        total: ctxGame.odds?.total ?? null,
        carryover: homeHist.carried > 0 || awayHist.carried > 0,
        ruledOut,
        picks: picks.slice(0, keep),
      };
    }),
  );

  return { season, games: games.filter((g): g is PropGame => g !== null), markets };
}

/** Recompute the shipped selftest vectors. The Python trainer wrote both the
 *  inputs and the probabilities it produced for them; if this file's maths has
 *  drifted from features.py, this is where it shows. Used by
 *  scripts/test-nfl-props.ts. */
export function selfTest(): { market: string; expected: number; got: number; ok: boolean }[] {
  const out: { market: string; expected: number; got: number; ok: boolean }[] = [];
  for (const [key, cases] of Object.entries(
    model.selftest as Record<string, { x: number[]; p: number }[]>,
  )) {
    const m = MARKETS[key];
    if (!m) continue;
    for (const c of cases) {
      const got = infer(m, c.x);
      out.push({ market: key, expected: c.p, got, ok: Math.abs(got - c.p) < 1e-9 });
    }
  }
  return out;
}
