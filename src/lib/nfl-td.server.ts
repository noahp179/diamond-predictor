/**
 * nfl-td.server.ts — live "most likely touchdown scorer" picks for an NFL slate.
 *
 * The model is a logistic regression on season-to-date usage + the market's
 * implied team total (research/nfl-td-scorer, backtested AUC ~0.70 out of
 * sample). Weights are frozen in td-model.json; this module rebuilds the same
 * season-to-date features live from ESPN box scores, then applies them.
 *
 * Data path (all public ESPN, cached; never touches Supabase):
 *   scoreboard(date)            → the slate
 *   teams/{id}/schedule         → each team's completed games this season
 *   summary?event=…             → per-game box scores (usage) + game total/spread
 *
 * Season-to-date means every completed game strictly before the slate date, so
 * the features are always genuinely pre-game (no leakage), exactly as trained.
 */
import model from "./td-model.json";
import { fetchScoreboard, seasonOf, type SlateGame } from "./espn.server";

const NFL = "football/nfl";
const C = model.constants;

// ------------------------------------------------------------- inference
/** Standardize → logistic → Platt calibration, matching export_model.py. */
function infer(x: number[]): number {
  let z = model.intercept;
  for (let i = 0; i < model.coef.length; i++) z += model.coef[i] * ((x[i] - model.mean[i]) / model.std[i]);
  const raw = 1 / (1 + Math.exp(-z));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(model.platt_a * lg + model.platt_b)));
}

// --------------------------------------------------------------- fetching
type Cached<T> = { at: number; v: T };
const summaryCache = new Map<number, Cached<ParsedSummary | null>>();
const scheduleCache = new Map<string, Cached<number[]>>();
const oddsCache = new Map<number, Cached<{ total: number; homeSpread: number } | null>>();
const SUMMARY_TTL = 24 * 60 * 60 * 1000; // finals are immutable
const SCHEDULE_TTL = 6 * 60 * 60 * 1000;
const ODDS_TTL = 30 * 60 * 1000;

async function getJson(url: string, ms = 10000): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`ESPN ${res.status}: ${url}`);
  return res.json();
}

type BoxPlayer = {
  id: string; name: string; car: number; tgt: number; ry: number; cy: number; rtd: number; ctd: number;
};
type BoxTeam = { abbr: string; isHome: boolean; players: BoxPlayer[]; rushTd: number; recTd: number };
type ParsedSummary = { date: string; teams: BoxTeam[] };

const num = (v: unknown) => {
  const n = Number(String(v ?? "").split("/")[0]);
  return Number.isFinite(n) ? n : 0;
};

function parseSummary(d: any): ParsedSummary | null {
  const comp = d?.header?.competitions?.[0];
  const box = d?.boxscore?.players;
  if (!comp || !Array.isArray(box)) return null;
  const homeAbbr = comp.competitors?.find((c: any) => c.homeAway === "home")?.team?.abbreviation;
  const teams: BoxTeam[] = [];
  for (const tb of box) {
    const abbr = tb?.team?.abbreviation;
    if (!abbr) continue;
    const byId = new Map<string, BoxPlayer>();
    for (const cat of tb.statistics ?? []) {
      const keys: string[] = cat.keys ?? [];
      for (const a of cat.athletes ?? []) {
        const id = a?.athlete?.id;
        if (!id) continue;
        const p = byId.get(id) ?? {
          id, name: a.athlete.displayName ?? "", car: 0, tgt: 0, ry: 0, cy: 0, rtd: 0, ctd: 0,
        };
        const s = Object.fromEntries(keys.map((k, i) => [k, a.stats?.[i]]));
        if (cat.name === "rushing") {
          p.car = num(s.rushingAttempts); p.ry = num(s.rushingYards); p.rtd = num(s.rushingTouchdowns);
        } else if (cat.name === "receiving") {
          p.tgt = num(s.receivingTargets); p.cy = num(s.receivingYards);
          p.ctd = num(s.receivingTouchdowns);
        } else continue;
        byId.set(id, p);
      }
    }
    const players = [...byId.values()];
    teams.push({
      abbr, isHome: abbr === homeAbbr, players,
      rushTd: players.reduce((s, p) => s + p.rtd, 0),
      recTd: players.reduce((s, p) => s + p.ctd, 0),
    });
  }
  return { date: (comp.date ?? "").slice(0, 10), teams };
}

async function fetchSummary(eventId: number): Promise<ParsedSummary | null> {
  const c = summaryCache.get(eventId);
  if (c && Date.now() - c.at < SUMMARY_TTL) return c.v;
  let v: ParsedSummary | null = null;
  try {
    v = parseSummary(await getJson(`https://site.api.espn.com/apis/site/v2/sports/${NFL}/summary?event=${eventId}`));
  } catch (err) {
    console.error(`[nfl-td summary] ${eventId}:`, err);
  }
  summaryCache.set(eventId, { at: Date.now(), v });
  return v;
}

/** Completed regular-season game ids for a team this season. */
async function fetchTeamCompletedIds(teamId: string, season: number): Promise<number[]> {
  const key = `${teamId}:${season}`;
  const c = scheduleCache.get(key);
  if (c && Date.now() - c.at < SCHEDULE_TTL) return c.v;
  let ids: number[] = [];
  try {
    const d = (await getJson(
      `https://site.api.espn.com/apis/site/v2/sports/${NFL}/teams/${teamId}/schedule?season=${season}&seasontype=2`,
    )) as { events?: any[] };
    ids = (d.events ?? [])
      .filter((e) => e?.competitions?.[0]?.status?.type?.completed)
      .map((e) => Number(e.id))
      .filter((n) => Number.isFinite(n));
  } catch (err) {
    console.error(`[nfl-td schedule] ${teamId}:`, err);
  }
  scheduleCache.set(key, { at: Date.now(), v: ids });
  return ids;
}

/** Market total + home spread for a game. The game summary's `pickcenter`
 *  carries `overUnder` and the home `spread` for both upcoming and past games
 *  (the core odds feed empties out once a game is old), so read it from there. */
async function fetchTotalSpread(eventId: number): Promise<{ total: number; homeSpread: number } | null> {
  const c = oddsCache.get(eventId);
  if (c && Date.now() - c.at < ODDS_TTL) return c.v;
  let v: { total: number; homeSpread: number } | null = null;
  try {
    const d = (await getJson(
      `https://site.api.espn.com/apis/site/v2/sports/${NFL}/summary?event=${eventId}`,
    )) as { pickcenter?: { overUnder?: number; spread?: number }[] };
    for (const it of d.pickcenter ?? []) {
      if (typeof it.overUnder === "number" && typeof it.spread === "number") {
        v = { total: it.overUnder, homeSpread: it.spread };
        break;
      }
    }
  } catch (err) {
    console.error(`[nfl-td odds] ${eventId}:`, err);
  }
  oddsCache.set(eventId, { at: Date.now(), v });
  return v;
}

// ------------------------------------------------------------ aggregation
type PlayerAgg = {
  id: string; name: string; gp: number; car: number; tgt: number; ry: number; cy: number;
  rtd: number; ctd: number; scg: number;
};
type TeamAgg = {
  players: Map<string, PlayerAgg>;
  gp: number; car: number; tgt: number; rtd: number; ctd: number; dRtd: number; dCtd: number;
};

/** Season-to-date usage + team offense/defense, from this team's completed
 *  games strictly before `beforeDate`. */
async function aggregateTeam(teamAbbr: string, teamId: string, season: number, beforeDate: string): Promise<TeamAgg> {
  const agg: TeamAgg = { players: new Map(), gp: 0, car: 0, tgt: 0, rtd: 0, ctd: 0, dRtd: 0, dCtd: 0 };
  const ids = await fetchTeamCompletedIds(teamId, season);
  const summaries = await Promise.all(ids.map(fetchSummary));
  for (const s of summaries) {
    if (!s || s.date >= beforeDate) continue;
    const mine = s.teams.find((t) => t.abbr === teamAbbr);
    const opp = s.teams.find((t) => t.abbr !== teamAbbr);
    if (!mine) continue;
    agg.gp += 1;
    agg.rtd += mine.rushTd; agg.ctd += mine.recTd;
    if (opp) { agg.dRtd += opp.rushTd; agg.dCtd += opp.recTd; }
    for (const p of mine.players) {
      agg.car += p.car; agg.tgt += p.tgt;
      const a = agg.players.get(p.id) ?? {
        id: p.id, name: p.name, gp: 0, car: 0, tgt: 0, ry: 0, cy: 0, rtd: 0, ctd: 0, scg: 0,
      };
      a.gp += 1; a.car += p.car; a.tgt += p.tgt; a.ry += p.ry; a.cy += p.cy;
      a.rtd += p.rtd; a.ctd += p.ctd; a.scg += p.rtd + p.ctd > 0 ? 1 : 0;
      a.name = p.name || a.name;
      agg.players.set(p.id, a);
    }
  }
  return agg;
}

// -------------------------------------------------------------- features
function featureVector(
  p: PlayerAgg, team: TeamAgg, oppDef: TeamAgg, isHome: boolean, impliedTotal: number,
  total: number, margin: number,
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
};
export type TdGame = {
  gameId: number;
  date: string;
  home: string;
  away: string;
  matchup: string;
  total: number | null;
  picks: TdPick[]; // top scorers across both teams, most likely first
};

function confidenceFor(pick: { prob: number; gp: number; touches: number }, secondProb: number): number {
  const sep = Math.min(1, Math.max(0, (pick.prob - secondProb) / (pick.prob + 1e-9) / 0.5));
  const maturity = Math.min(1, pick.gp / 6);
  const volume = Math.min(1, pick.touches / 18);
  return Math.round(100 * (0.45 * sep + 0.3 * maturity + 0.25 * volume));
}

/** Top touchdown-scorer picks for every game on `date`. */
export async function tdScorersSlate(date: string): Promise<{ season: number | null; games: TdGame[] }> {
  const season = seasonOf("nfl", date);
  const slate = await fetchScoreboard("nfl", date);
  if (season == null || slate.length === 0) return { season, games: [] };

  const games = await Promise.all(
    slate.map(async (g: SlateGame): Promise<TdGame | null> => {
      const [homeAgg, awayAgg, odds] = await Promise.all([
        aggregateTeam(g.home.abbr, g.home.id, season, date),
        aggregateTeam(g.away.abbr, g.away.id, season, date),
        fetchTotalSpread(g.id),
      ]);
      const total = odds?.total ?? 45;
      const homeSpread = odds?.homeSpread ?? 0;
      const homeImplied = total / 2 - homeSpread / 2; // home margin = -spread
      const awayImplied = total / 2 + homeSpread / 2;

      const cand: { pick: TdPick; gp: number; touches: number }[] = [];
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
            pick: { playerId: p.id, player: p.name, team: abbr, prob, confidence: 0 },
            gp: p.gp, touches: (p.car + p.tgt) / p.gp,
          });
        }
      }
      if (cand.length === 0) return null;
      cand.sort((a, b) => b.pick.prob - a.pick.prob);
      const secondProb = cand[1]?.pick.prob ?? 0;
      const picks = cand.slice(0, 4).map((c, i) => ({
        ...c.pick,
        confidence: confidenceFor(
          { prob: c.pick.prob, gp: c.gp, touches: c.touches },
          i === 0 ? secondProb : cand[0].pick.prob,
        ),
      }));
      return {
        gameId: g.id, date: g.date, home: g.home.abbr, away: g.away.abbr,
        matchup: `${g.away.abbr} @ ${g.home.abbr}`, total: odds?.total ?? null, picks,
      };
    }),
  );

  return { season, games: games.filter((g): g is TdGame => g !== null) };
}
