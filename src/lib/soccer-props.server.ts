/**
 * soccer-props.server.ts — live player-prop probabilities for the five leagues.
 *
 * Ten binary markets on starting players (shots, shots on target, goals,
 * assists, goal involvement, cards, fouls), each a per-league logistic fitted in
 * research/soccer/props_soccer.py and read from soccer-props-model.json.
 *
 * WHAT THIS COSTS, AND WHY
 * ------------------------
 * ESPN publishes no season-to-date soccer aggregates carrying the fields these
 * models need — shots, shots on target, fouls. The only source is the per-match
 * summary, so season form has to be REPLAYED: fetch every completed match in
 * the league this season, sum each player's stats, and rebuild the same
 * features the backtest built.
 *
 * That is a few hundred summary calls. It happens once per league per server
 * instance and is cached at module scope; a refresh only fetches matches played
 * since the last replay. The first request after a cold start is slow, every
 * one after it is instant. There is no cheaper endpoint, and feeding the model
 * features it was not fitted on would be worse than waiting.
 *
 * THE PORT
 * --------
 * `featuresFor` below is a line-by-line port of build() in
 * research/soccer/props_soccer.py, including which quantities are shrunk and
 * which are raw — team and opponent per-game rates are deliberately NOT shrunk
 * there, and are not shrunk here either. Drift between the two silently
 * invalidates every backtested number shown on the page, so the feature ORDER
 * is taken from the model file rather than from a list in this file, and the
 * arithmetic is checked by scripts/test-soccer-props.ts.
 *
 * One honest deviation from the research, which prices only confirmed starters:
 * ESPN does not post lineups until shortly before kick-off, so the live board
 * prices LIKELY starters — players who have started at least half their
 * appearances. Their features are otherwise identical.
 */

import propsModels from "./soccer-props-model.json";
import { leagueOf, type LeagueSlug } from "./soccer-leagues";
import { seasonOf } from "./soccer.server";

type Tier = { label: string; minProb: number; hitRate: number; n: number };

type Market = {
  label: string;
  auc: number;
  base: number;
  meanPred: number;
  logloss: number;
  top1: number;
  top5: number;
  n: number;
  tiers: Tier[];
  features: string[];
  mean: number[];
  std: number[];
  coef: number[];
  intercept: number;
  plattA: number;
  plattB: number;
};

type PropsModel = { league: string; name: string; markets: Record<string, Market> };

const MODELS = propsModels as unknown as Record<string, PropsModel>;

export function propsModelFor(slug: LeagueSlug): PropsModel {
  return MODELS[slug];
}

// ------------------------------------------------- constants from the research

/** League per-appearance rates used as shrinkage targets. */
const LG = { sh: 1.02, sot: 0.34, goal: 0.11, asst: 0.08, card: 0.15, foul: 0.84 };
const K_APP = 12.0;
const K_G = 10.0;
const WINDOW = 6;
const APPS_CAP = 38; // a season's worth; the research clamps here too

/** Market → (did it hit in this match, league prior for the own-rate feature). */
const MARKETS: Record<string, { hit: (r: PlayerMatch) => number; prior: number }> = {
  sh1: { hit: (r) => (r.sh >= 1 ? 1 : 0), prior: 0.55 },
  sh2: { hit: (r) => (r.sh >= 2 ? 1 : 0), prior: 0.28 },
  sh3: { hit: (r) => (r.sh >= 3 ? 1 : 0), prior: 0.13 },
  sot1: { hit: (r) => (r.sot >= 1 ? 1 : 0), prior: 0.25 },
  sot2: { hit: (r) => (r.sot >= 2 ? 1 : 0), prior: 0.08 },
  goal1: { hit: (r) => (r.goal >= 1 ? 1 : 0), prior: 0.1 },
  asst1: { hit: (r) => (r.asst >= 1 ? 1 : 0), prior: 0.07 },
  ga1: { hit: (r) => (r.goal + r.asst >= 1 ? 1 : 0), prior: 0.16 },
  card1: { hit: (r) => (r.card >= 1 ? 1 : 0), prior: 0.15 },
  foul2: { hit: (r) => (r.foul >= 2 ? 1 : 0), prior: 0.25 },
};

const shrunk = (num: number, den: number, prior: number, k: number) =>
  (num + k * prior) / (den + k);

/**
 * Position one-hots, copied verbatim from the research — INCLUDING their flaw.
 *
 * ESPN publishes positional-SLOT codes, not plain positions: a centre-back is
 * "CD-L" or "CD-R", a centre-forward "CF-L" or "CF-R". None of those are in the
 * lists below, so across 195,161 starter appearances only 51.8% of players get
 * any position flag at all, and centre-backs get none ever.
 *
 * That is a defect in the feature, and it must be reproduced here exactly.
 * The coefficients were fitted with these semantics; "fixing" the matching live
 * would feed the model a feature distribution it never saw and silently break
 * the calibration every number on the page is quoted from. The fix belongs in a
 * refit — widen the lists in props_soccer.py, re-run the sweep, re-ship — not
 * in the scorer. scripts/test-soccer-props.ts pins the current behaviour so the
 * two cannot be changed independently by accident.
 */
const FW = new Set(["F", "CF", "LW", "RW", "ST", "SS"]);
const MF = new Set(["M", "CM", "AM", "DM", "LM", "RM"]);
const DF = new Set(["D", "CB", "LB", "RB", "WB"]);

// ------------------------------------------------------------------- fetch

const API = "https://site.api.espn.com/apis/site/v2/sports/soccer";

async function fetchJson<T>(url: string, ms = 15000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Run jobs with bounded concurrency so a season replay does not open 380 sockets. */
async function pool<T>(jobs: (() => Promise<T>)[], width = 12): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

type Summary = {
  rosters?: {
    homeAway?: string;
    team?: { id?: string };
    roster?: {
      athlete?: { id?: string; displayName?: string };
      position?: { abbreviation?: string };
      starter?: boolean;
      subbedIn?: boolean;
      subbedOut?: boolean;
      formationPlace?: string | number;
      stats?: { name?: string; value?: number }[];
    }[];
  }[];
};

/** One player's line in one match — the unit every feature is built from. */
export type PlayerMatch = {
  matchId: string;
  date: string;
  playerId: string;
  name: string;
  teamId: string;
  oppId: string;
  isHome: number;
  pos: string;
  starter: number;
  formationPlace: number;
  mins: number;
  sh: number;
  sot: number;
  goal: number;
  asst: number;
  card: number;
  foul: number;
};

function parseSummary(
  matchId: string,
  date: string,
  homeId: string,
  awayId: string,
  d: Summary,
): PlayerMatch[] {
  const rows: PlayerMatch[] = [];
  for (const side of d.rosters ?? []) {
    const teamId = side.team?.id ?? "";
    const isHome = side.homeAway === "home" ? 1 : 0;
    for (const p of side.roster ?? []) {
      const id = p.athlete?.id;
      if (!id) continue;
      const stats = new Map<string, number>();
      for (const s of p.stats ?? []) if (s.name) stats.set(s.name, Number(s.value) || 0);
      const g = (k: string) => stats.get(k) ?? 0;
      const starter = p.starter ? 1 : 0;
      // ESPN gives no minutes; the research approximates them the same way.
      const mins = starter ? (p.subbedOut ? 65 : 90) : p.subbedIn ? 25 : 0;
      rows.push({
        matchId,
        date,
        playerId: id,
        name: p.athlete?.displayName ?? "",
        teamId,
        oppId: isHome ? awayId : homeId,
        isHome,
        pos: p.position?.abbreviation ?? "",
        starter,
        formationPlace: Number(p.formationPlace) || 0,
        mins,
        sh: g("totalShots"),
        sot: g("shotsOnTarget"),
        goal: g("totalGoals"),
        asst: g("goalAssists"),
        card: g("yellowCards") + g("redCards"),
        foul: g("foulsCommitted"),
      });
    }
  }
  return rows;
}

type SeasonForm = { at: number; season: number; rows: PlayerMatch[]; seen: Set<string> };

const formCache = new Map<string, SeasonForm>();
const FORM_TTL = 30 * 60 * 1000;

async function seasonForm(slug: LeagueSlug, season: number): Promise<SeasonForm> {
  const key = `${slug}:${season}`;
  const hit = formCache.get(key);
  if (hit && Date.now() - hit.at < FORM_TTL) return hit;

  const league = leagueOf(slug);
  const sb = await fetchJson<{
    events?: {
      id: string;
      date: string;
      status?: { type?: { completed?: boolean } };
      competitions?: { competitors?: { homeAway: string; team: { id: string } }[] }[];
    }[];
  }>(`${API}/${league.espn}/scoreboard?dates=${season}0701-${season + 1}0630&limit=1000`, 20000);

  const played = (sb?.events ?? [])
    .filter((e) => e.status?.type?.completed)
    .map((e) => {
      const cs = e.competitions?.[0]?.competitors ?? [];
      return {
        id: e.id,
        date: e.date.slice(0, 10),
        homeId: cs.find((c) => c.homeAway === "home")?.team.id ?? "",
        awayId: cs.find((c) => c.homeAway === "away")?.team.id ?? "",
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const form: SeasonForm = hit ?? { at: 0, season, rows: [], seen: new Set() };
  const todo = played.filter((m) => !form.seen.has(m.id));
  const fetched = await pool(
    todo.map((m) => async () => {
      const d = await fetchJson<Summary>(`${API}/${league.espn}/summary?event=${m.id}`);
      return d ? parseSummary(m.id, m.date, m.homeId, m.awayId, d) : [];
    }),
  );
  for (const m of todo) form.seen.add(m.id);
  form.rows.push(...fetched.flat());
  // Matches are folded in chronological order, exactly as the research walks
  // them, so a player's state is always "before this match" when it is used.
  form.rows.sort((a, b) => a.date.localeCompare(b.date) || a.matchId.localeCompare(b.matchId));
  form.at = Date.now();
  form.season = season;
  formCache.set(key, form);
  return form;
}

// ---------------------------------------------------------------- the state

type PlayerState = {
  name: string;
  teamId: string;
  pos: string;
  formationPlace: number;
  app: number;
  start: number;
  mins: number;
  sh: number;
  sot: number;
  goal: number;
  asst: number;
  card: number;
  foul: number;
  /** Market hit counts, for the own-rate feature. */
  hits: Record<string, number>;
  /** Last WINDOW matches, for the recent-form features. */
  window: { sh: number; sot: number; goal: number }[];
};

type TeamState = { gm: number; sh: number; goal: number; foul: number; shA: number; goalA: number };

const newPlayer = (): PlayerState => ({
  name: "",
  teamId: "",
  pos: "",
  formationPlace: 0,
  app: 0,
  start: 0,
  mins: 0,
  sh: 0,
  sot: 0,
  goal: 0,
  asst: 0,
  card: 0,
  foul: 0,
  hits: Object.fromEntries(Object.keys(MARKETS).map((k) => [k, 0])),
  window: [],
});

const newTeam = (): TeamState => ({ gm: 0, sh: 0, goal: 0, foul: 0, shA: 0, goalA: 0 });

/** Fold a whole season's matches into per-player and per-team state. */
export function foldSeason(rows: PlayerMatch[]) {
  const players = new Map<string, PlayerState>();
  const teams = new Map<string, TeamState>();

  const byMatch = new Map<string, PlayerMatch[]>();
  for (const r of rows) {
    const list = byMatch.get(r.matchId) ?? [];
    list.push(r);
    byMatch.set(r.matchId, list);
  }

  for (const list of byMatch.values()) {
    for (const r of list) {
      const p = players.get(r.playerId) ?? newPlayer();
      p.name = r.name || p.name;
      p.teamId = r.teamId || p.teamId;
      p.pos = r.pos || p.pos;
      p.formationPlace = r.formationPlace || p.formationPlace;
      p.app += 1;
      p.start += r.starter;
      p.mins += r.mins;
      p.sh += r.sh;
      p.sot += r.sot;
      p.goal += r.goal;
      p.asst += r.asst;
      p.card += r.card;
      p.foul += r.foul;
      for (const [k, m] of Object.entries(MARKETS)) p.hits[k] += m.hit(r);
      p.window.push({ sh: r.sh, sot: r.sot, goal: r.goal });
      if (p.window.length > WINDOW) p.window.shift();
      players.set(r.playerId, p);
    }

    // Team totals are per side per match, not per player-row.
    const sides = new Map<string, { opp: string; sh: number; goal: number; foul: number }>();
    for (const r of list) {
      const s = sides.get(r.teamId) ?? { opp: r.oppId, sh: 0, goal: 0, foul: 0 };
      s.sh += r.sh;
      s.goal += r.goal;
      s.foul += r.foul;
      sides.set(r.teamId, s);
    }
    for (const [tid, s] of sides) {
      const t = teams.get(tid) ?? newTeam();
      t.gm += 1;
      t.sh += s.sh;
      t.goal += s.goal;
      t.foul += s.foul;
      teams.set(tid, t);
      const o = teams.get(s.opp) ?? newTeam();
      o.shA += s.sh;
      o.goalA += s.goal;
      teams.set(s.opp, o);
    }
  }
  return { players, teams };
}

/** Last season's per-player totals, for the prior-season features. */
export function priorSeason(rows: PlayerMatch[]) {
  const out = new Map<string, { pa: number; sh: number; goal: number }>();
  for (const r of rows) {
    const p = out.get(r.playerId) ?? { pa: 0, sh: 0, goal: 0 };
    p.pa += 1;
    p.sh += r.sh;
    p.goal += r.goal;
    out.set(r.playerId, p);
  }
  return out;
}

/**
 * The feature vector for one player in one fixture, by NAME.
 *
 * Port of build() in research/soccer/props_soccer.py. Note what is NOT shrunk:
 * the five team/opponent per-game rates are raw ratios there, and raw here.
 */
export function featuresFor(
  p: PlayerState,
  isHome: number,
  team: TeamState,
  opp: TeamState,
  py: { pa: number; sh: number; goal: number } | undefined,
): Record<string, number> {
  const app = p.app;
  const w = p.window;
  const wg = w.length;
  const wsum = (f: (r: { sh: number; sot: number; goal: number }) => number) =>
    w.reduce((s, r) => s + f(r), 0);

  const f: Record<string, number> = {
    sh_pa: shrunk(p.sh, app, LG.sh, K_APP),
    sot_pa: shrunk(p.sot, app, LG.sot, K_APP),
    goal_pa: shrunk(p.goal, app, LG.goal, K_APP),
    asst_pa: shrunk(p.asst, app, LG.asst, K_APP),
    card_pa: shrunk(p.card, app, LG.card, K_APP),
    foul_pa: shrunk(p.foul, app, LG.foul, K_APP),
    conv_rate: shrunk(p.goal, Math.max(p.sh, 0), 0.11, 8.0),
    w_sh_pa: shrunk(
      wsum((r) => r.sh),
      wg,
      LG.sh,
      4.0,
    ),
    w_sot_pa: shrunk(
      wsum((r) => r.sot),
      wg,
      LG.sot,
      4.0,
    ),
    w_goal_pa: shrunk(
      wsum((r) => r.goal),
      wg,
      LG.goal,
      4.0,
    ),
    w_apps: wg,
    py_sh_pa: py ? shrunk(py.sh, py.pa, LG.sh, K_APP) : LG.sh,
    py_goal_pa: py ? shrunk(py.goal, py.pa, LG.goal, K_APP) : LG.goal,
    py_apps: py ? Math.min(py.pa, APPS_CAP) : 0,
    py_known: py ? 1 : 0,
    apps: Math.min(app, APPS_CAP),
    start_rate: p.start / app,
    mins_avg: p.mins / app,
    is_home: isHome,
    pos_fw: FW.has(p.pos) ? 1 : 0,
    pos_mf: MF.has(p.pos) ? 1 : 0,
    pos_df: DF.has(p.pos) ? 1 : 0,
    pos_gk: p.pos === "G" ? 1 : 0,
    formation_place: p.formationPlace,
    team_sh_pg: team.sh / team.gm,
    team_goals_pg: team.goal / team.gm,
    opp_sh_allowed: opp.shA / opp.gm,
    opp_goals_allowed: opp.goalA / opp.gm,
    opp_fouls_pg: opp.foul / opp.gm,
  };
  for (const [k, m] of Object.entries(MARKETS)) {
    f[`own_${k}`] = shrunk(p.hits[k], app, m.prior, K_G);
  }
  return f;
}

export function scoreMarket(m: Market, f: Record<string, number>): number {
  let z = m.intercept;
  for (let i = 0; i < m.features.length; i += 1) {
    const v = f[m.features[i]] ?? 0;
    z += ((v - m.mean[i]) / (m.std[i] || 1)) * m.coef[i];
  }
  const raw = 1 / (1 + Math.exp(-z));
  const c = Math.min(Math.max(raw, 1e-9), 1 - 1e-9);
  const lg = Math.log(c / (1 - c));
  return 1 / (1 + Math.exp(-(m.plattA * lg + m.plattB)));
}

/** Tiers are stored as descending probability floors: the first one we clear wins. */
export function tierOf(m: Market, p: number): Tier | null {
  for (const t of m.tiers) if (p >= t.minProb) return t;
  return null;
}

// -------------------------------------------------------------------- API

export type SoccerPropPick = {
  playerId: string;
  player: string;
  team: string;
  opponent: string;
  pos: string;
  market: string;
  label: string;
  prob: number;
  base: number;
  edge: number;
  tier: string | null;
  tierHitRate: number | null;
  apps: number;
  startRate: number;
};

export type SoccerPropsFixture = {
  matchId: string;
  matchup: string;
  kickoff: string;
  picks: SoccerPropPick[];
};

export type SoccerPropsSlate = {
  league: LeagueSlug;
  date: string;
  fixtures: SoccerPropsFixture[];
  markets: { key: string; label: string; auc: number; base: number }[];
  note: string | null;
};

/** The research's gates: a player and both teams need three matches of history. */
const MIN_APPS = 3;
const MIN_TEAM_GAMES = 3;
/** Live-only gate: without posted lineups, price players who usually start. */
const MIN_START_RATE = 0.5;

export async function soccerProps(slug: LeagueSlug, date: string): Promise<SoccerPropsSlate> {
  const league = leagueOf(slug);
  const model = propsModelFor(slug);
  const markets = Object.entries(model.markets).map(([key, m]) => ({
    key,
    label: m.label,
    auc: m.auc,
    base: m.base,
  }));

  const season = seasonOf(date);
  const day = await fetchJson<{
    events?: {
      id: string;
      date: string;
      competitions?: {
        competitors?: {
          homeAway: string;
          team: { id: string; abbreviation?: string; shortDisplayName?: string };
        }[];
      }[];
    }[];
  }>(`${API}/${league.espn}/scoreboard?dates=${date.replace(/-/g, "")}&limit=100`);

  const events = day?.events ?? [];
  if (events.length === 0) return { league: slug, date, fixtures: [], markets, note: null };

  const [thisSeason, lastSeason] = await Promise.all([
    seasonForm(slug, season),
    seasonForm(slug, season - 1),
  ]);
  // When a new season starts, early matchdays have fewer than 3 games per team/player.
  // Include last season's completed matches so form has sufficient history to price
  // player props starting from matchday 1.
  const activeRows =
    thisSeason.rows.length < 600
      ? [...lastSeason.rows, ...thisSeason.rows]
      : thisSeason.rows;

  const { players, teams } = foldSeason(activeRows);
  const py = priorSeason(lastSeason.rows);

  const fixtures: SoccerPropsFixture[] = [];
  for (const e of events) {
    const cs = e.competitions?.[0]?.competitors ?? [];
    const home = cs.find((c) => c.homeAway === "home");
    const away = cs.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const nameOf = (c: NonNullable<typeof home>) =>
      c.team.abbreviation ?? c.team.shortDisplayName ?? "?";

    const picks: SoccerPropPick[] = [];
    for (const [side, other, isHome] of [
      [home, away, 1],
      [away, home, 0],
    ] as const) {
      const team = teams.get(side.team.id);
      const opp = teams.get(other.team.id);
      if (!team || !opp || team.gm < MIN_TEAM_GAMES || opp.gm < MIN_TEAM_GAMES) continue;

      for (const [pid, p] of players) {
        if (p.teamId !== side.team.id) continue;
        if (p.app < MIN_APPS || p.start / p.app < MIN_START_RATE) continue;
        const f = featuresFor(p, isHome, team, opp, py.get(pid));
        for (const [key, m] of Object.entries(model.markets)) {
          const prob = scoreMarket(m, f);
          const t = tierOf(m, prob);
          picks.push({
            playerId: pid,
            player: p.name,
            team: nameOf(side),
            opponent: nameOf(other),
            pos: p.pos,
            market: key,
            label: m.label,
            prob,
            base: m.base,
            edge: prob - m.base,
            tier: t?.label ?? null,
            tierHitRate: t?.hitRate ?? null,
            apps: p.app,
            startRate: p.start / p.app,
          });
        }
      }
    }
    picks.sort((x, y) => y.edge - x.edge);
    fixtures.push({
      matchId: e.id,
      matchup: `${nameOf(away)} @ ${nameOf(home)}`,
      kickoff: e.date,
      picks,
    });
  }

  const totalPicks = fixtures.reduce((sum, f) => sum + f.picks.length, 0);

  return {
    league: slug,
    date,
    fixtures,
    markets,
    note:
      totalPicks === 0 && events.length > 0
        ? "Not enough team or player history available yet to project player props for these fixtures."
        : thisSeason.rows.length === 0 && lastSeason.rows.length === 0
          ? "No completed matches yet this season, so there is no form to project from. Props return once the campaign is under way."
          : null,
  };
}
