/**
 * nfl-td.server.ts — live "most likely touchdown scorer" picks for an NFL slate.
 *
 * The model is a logistic regression on season-to-date usage + the market's
 * implied team total (research/nfl-td-scorer, backtested AUC ~0.70 out of
 * sample). Weights are frozen in td-model.json; this module rebuilds the same
 * season-to-date features live from ESPN box scores, then applies them.
 *
 * Data path (all public ESPN, cached; never touches Supabase) goes through
 * nfl-espn.server.ts, which is shared with the prop board — one cache and one
 * request budget, so a Sunday does not fetch the same 285 KB box score twice.
 *
 * Season-to-date means every completed game strictly before the slate date, so
 * the features are always genuinely pre-game (no leakage), exactly as trained.
 * Early in the season there is no season-to-date yet — Week 1 has literally
 * none — so the usage window is topped up with last season's most recent games
 * (see USAGE_WINDOW) and the picks say so rather than the board going blank.
 */
import model from "./td-model.json";
import { todayET } from "./date";
import {
  fetchActiveRoster,
  fetchGameContext,
  fetchSummary,
  trailingTeamGames,
  type BoxPlayer,
  type BoxTeam,
} from "./nfl-espn.server";
import { fetchScoreboard, seasonOf, type SlateGame } from "./espn.server";

const C = model.constants;

// ------------------------------------------------------------- inference
/** Standardize → logistic → Platt calibration, matching export_model.py. */
function infer(x: number[]): number {
  let z = model.intercept;
  for (let i = 0; i < model.coef.length; i++)
    z += model.coef[i] * ((x[i] - model.mean[i]) / model.std[i]);
  const raw = 1 / (1 + Math.exp(-z));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(model.platt_a * lg + model.platt_b)));
}

// ------------------------------------------------------------ aggregation

/**
 * Games of usage the features need behind them. Season-to-date is what the
 * model was trained on, but in Week 1 season-to-date is empty and every team
 * would be skipped — which is exactly why the board rendered "No games to
 * project" on opening night. Below this many games this season, the window is
 * topped up with last season's most recent games. The top-up shrinks by one
 * per week and is gone by Week 7, so the model is back on pure season-to-date
 * as soon as there is enough of it.
 */
const USAGE_WINDOW = 6;

type PlayerAgg = {
  id: string;
  name: string;
  gp: number;
  /** Of `gp`, how many came from last season. */
  cgp: number;
  car: number;
  tgt: number;
  ry: number;
  cy: number;
  rtd: number;
  ctd: number;
  scg: number;
};
type TeamAgg = {
  players: Map<string, PlayerAgg>;
  gp: number;
  /** Of `gp`, how many were carried over from last season. */
  carried: number;
  car: number;
  tgt: number;
  rtd: number;
  ctd: number;
  dRtd: number;
  dCtd: number;
};

/** Season-to-date usage + team offense/defense, from this team's completed
 *  games strictly before `beforeDate`, topped up with last season's tail when
 *  this season is still too thin to read (see USAGE_WINDOW).
 *
 *  `roster` gates which players earn a *pick*: a player who is no longer on the
 *  roster — released, traded, on IR — can't score, and last season's box scores
 *  are full of them. Team totals still count everyone, because carry and target
 *  share are shares of what the offense actually did. */
async function aggregateTeam(
  teamAbbr: string,
  teamId: string,
  season: number,
  beforeDate: string,
  roster: Set<string> | null,
): Promise<TeamAgg> {
  const agg: TeamAgg = {
    players: new Map(),
    gp: 0,
    carried: 0,
    car: 0,
    tgt: 0,
    rtd: 0,
    ctd: 0,
    dRtd: 0,
    dCtd: 0,
  };

  // The team's last USAGE_WINDOW completed games before the slate's own day,
  // reaching into last season when this one is still too young to fill it.
  const { games: log, carried: carriedGames } = await trailingTeamGames(
    teamId,
    season,
    beforeDate,
    USAGE_WINDOW,
  );

  const summaries = await Promise.all(log.map((g) => fetchSummary(g.id)));
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    if (!s || s.date >= beforeDate) continue;
    const fromLastSeason = i < carriedGames;
    const mine = s.teams.find((t) => t.abbr === teamAbbr);
    const opp = s.teams.find((t) => t.abbr !== teamAbbr);
    if (!mine) continue;
    agg.gp += 1;
    if (fromLastSeason) agg.carried += 1;
    agg.rtd += mine.rushTd;
    agg.ctd += mine.recTd;
    if (opp) {
      agg.dRtd += opp.rushTd;
      agg.dCtd += opp.recTd;
    }
    for (const p of mine.players) {
      // Team denominators count the whole offense, departed players included.
      agg.car += p.car;
      agg.tgt += p.tgt;
      if (roster && !roster.has(p.id)) continue; // not available to score now
      const a = agg.players.get(p.id) ?? {
        id: p.id,
        name: p.name,
        gp: 0,
        cgp: 0,
        car: 0,
        tgt: 0,
        ry: 0,
        cy: 0,
        rtd: 0,
        ctd: 0,
        scg: 0,
      };
      a.gp += 1;
      if (fromLastSeason) a.cgp += 1;
      a.car += p.car;
      a.tgt += p.tgt;
      a.ry += p.ry;
      a.cy += p.cy;
      a.rtd += p.rtd;
      a.ctd += p.ctd;
      a.scg += p.rtd + p.ctd > 0 ? 1 : 0;
      a.name = p.name || a.name;
      agg.players.set(p.id, a);
    }
  }
  return agg;
}

// -------------------------------------------------------------- features
function featureVector(
  p: PlayerAgg,
  team: TeamAgg,
  oppDef: TeamAgg,
  isHome: boolean,
  impliedTotal: number,
  total: number,
  margin: number,
): number[] {
  return [
    team.car ? p.car / team.car : 0, // carry_share
    team.tgt ? p.tgt / team.tgt : 0, // target_share
    p.car / p.gp, // cpg
    p.tgt / p.gp, // tpg
    p.ry / p.gp, // rush_ypg
    p.cy / p.gp, // rec_ypg
    (p.rtd + C.K_RUSH * C.LG_RUSH) / (p.car + C.K_RUSH), // rush_td_rate
    (p.ctd + C.K_REC * C.LG_REC) / (p.tgt + C.K_REC), // rec_td_rate
    (p.scg + C.K_ANY * C.LG_ANY) / (p.gp + C.K_ANY), // anytime_rate
    Math.min(p.gp, 17), // gp
    team.rtd / team.gp, // team_rush_tdpg
    team.ctd / team.gp, // team_rec_tdpg
    oppDef.dRtd / oppDef.gp, // opp_rush_td_allowed_pg
    oppDef.dCtd / oppDef.gp, // opp_rec_td_allowed_pg
    isHome ? 1 : 0, // is_home
    impliedTotal, // mkt_implied_total
    total, // mkt_total
    margin, // mkt_team_margin
  ];
}

// ----------------------------------------------------------------- public
export type TdPick = {
  playerId: string;
  player: string;
  team: string;
  prob: number; // P(scores an anytime TD), 0..1
  confidence: number; // 0..100 (trust that this is a top scorer)
  /** Games of usage behind the pick, and how many of those are last season's.
   *  Non-zero `carried` is the honest caveat on an early-season number. */
  games: number;
  carried: number;
};
export type TdGame = {
  gameId: number;
  date: string;
  home: string;
  away: string;
  matchup: string;
  total: number | null;
  /** True when either side's usage is still partly last season's (Weeks 1-6). */
  carryover: boolean;
  picks: TdPick[]; // top scorers across both teams, most likely first
};

/** Last season's usage is real evidence, but a changed scheme and a changed
 *  depth chart make it weaker than a game played this year. It counts, at a
 *  discount, toward the maturity term — so a Week 1 pick built entirely on
 *  carryover tops out around "Solid" rather than claiming "Strong". */
const CARRYOVER_CREDIT = 0.5;

function confidenceFor(
  pick: { prob: number; gp: number; cgp: number; touches: number },
  secondProb: number,
): number {
  const sep = Math.min(1, Math.max(0, (pick.prob - secondProb) / (pick.prob + 1e-9) / 0.5));
  const fresh = pick.gp - pick.cgp;
  const maturity = Math.min(1, (fresh + CARRYOVER_CREDIT * pick.cgp) / 6);
  const volume = Math.min(1, pick.touches / 18);
  return Math.round(100 * (0.45 * sep + 0.3 * maturity + 0.25 * volume));
}

/** Top touchdown-scorer picks for every game on `date`. */
export async function tdScorersSlate(
  date: string,
): Promise<{ season: number | null; games: TdGame[] }> {
  const season = seasonOf("nfl", date);
  const slate = await fetchScoreboard("nfl", date);
  if (season == null || slate.length === 0) return { season, games: [] };

  // The roster endpoint only knows who is on the team *now*, so it can only
  // speak for the live season. Looking back at an old slate, don't filter.
  const liveSeason = seasonOf("nfl", todayET()) === season;

  const games = await Promise.all(
    slate.map(async (g: SlateGame): Promise<TdGame | null> => {
      const [homeRoster, awayRoster] = liveSeason
        ? await Promise.all([fetchActiveRoster(g.home.id), fetchActiveRoster(g.away.id)])
        : [null, null];
      const [homeAgg, awayAgg, ctx] = await Promise.all([
        aggregateTeam(g.home.abbr, g.home.id, season, date, homeRoster),
        aggregateTeam(g.away.abbr, g.away.id, season, date, awayRoster),
        fetchGameContext(g.id),
      ]);
      const odds = ctx.odds;
      const total = odds?.total ?? 45;
      const homeSpread = odds?.homeSpread ?? 0;
      const homeImplied = total / 2 - homeSpread / 2; // home margin = -spread
      const awayImplied = total / 2 + homeSpread / 2;

      const cand: { pick: TdPick; gp: number; cgp: number; touches: number }[] = [];
      const sides: [TeamAgg, TeamAgg, boolean, string, number, number][] = [
        [homeAgg, awayAgg, true, g.home.abbr, homeImplied, -homeSpread],
        [awayAgg, homeAgg, false, g.away.abbr, awayImplied, homeSpread],
      ];
      for (const [team, oppDef, isHome, abbr, implied, margin] of sides) {
        if (team.gp < 1 || oppDef.gp < 1) continue;
        for (const p of team.players.values()) {
          if (p.gp < 1 || p.car + p.tgt < 1) continue;
          const x = featureVector(p, team, oppDef, isHome, implied, total, margin);
          const prob = infer(x);
          cand.push({
            pick: {
              playerId: p.id,
              player: p.name,
              team: abbr,
              prob,
              confidence: 0,
              games: p.gp,
              carried: p.cgp,
            },
            gp: p.gp,
            cgp: p.cgp,
            touches: (p.car + p.tgt) / p.gp,
          });
        }
      }
      if (cand.length === 0) return null;
      cand.sort((a, b) => b.pick.prob - a.pick.prob);
      const secondProb = cand[1]?.pick.prob ?? 0;
      const picks = cand.slice(0, 4).map((c, i) => ({
        ...c.pick,
        confidence: confidenceFor(
          { prob: c.pick.prob, gp: c.gp, cgp: c.cgp, touches: c.touches },
          i === 0 ? secondProb : cand[0].pick.prob,
        ),
      }));
      return {
        gameId: g.id,
        date: g.date,
        home: g.home.abbr,
        away: g.away.abbr,
        matchup: `${g.away.abbr} @ ${g.home.abbr}`,
        total: odds?.total ?? null,
        carryover: homeAgg.carried > 0 || awayAgg.carried > 0,
        picks,
      };
    }),
  );

  return { season, games: games.filter((g): g is TdGame => g !== null) };
}
