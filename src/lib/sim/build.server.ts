/**
 * build.server.ts — turns ESPN season totals into the rates the engines run on.
 *
 * Three ideas do all the work here.
 *
 * 1. **Two seasons, weighted.** Early in a season a player's numbers are a
 *    handful of games; late in one they are most of a year. Every count is
 *    pooled as `this season + w × last season`, where `w` starts at 1 before
 *    opening night and fades to 0.2 by mid-season. A player traded over the
 *    summer brings last season's numbers with him, because the stats are read
 *    league-wide and matched on the player, not the team.
 *
 * 2. **Regression toward the league.** Every rate is `(count + k × league) /
 *    (opportunities + k)`, with `k` sized to how noisy that stat is: free-throw
 *    percentage settles fast, three-point percentage and save percentage take
 *    hundreds of attempts. A rookie with no numbers at all simply *is* the
 *    league average, slightly discounted.
 *
 * 3. **Defense from the standings.** Player stats describe offense well and
 *    defense poorly — nobody records "shots a winger prevented". Each team's
 *    points allowed per game, relative to the league, becomes a single defense
 *    factor the engines apply to the opponent, again regressed halfway home.
 */

import {
  playerStats,
  roster as fetchRoster,
  scoreboard,
  seasonFor,
  seasonLabel,
  standings,
  teams as fetchTeams,
  type RosterEntry,
  type ScoreboardGame,
  type StatLine,
  type StandingRow,
  type TeamMeta,
} from "./espn-stats.server";
import type {
  Availability,
  MatchupContext,
  MlbBatter,
  MlbEnv,
  MlbPitcher,
  MlbTeam,
  NbaEnv,
  NbaPlayer,
  NbaTeam,
  NflEnv,
  NflPlayer,
  NflTeam,
  NhlEnv,
  NhlGoalie,
  NhlSkater,
  NhlTeam,
  PaRates,
  SimLeague,
  SimMatchup,
  TeamInfo,
} from "./types";

// ------------------------------------------------------------- blending

/** Games into a season by which last season stops mattering much. */
const HALF: Record<SimLeague, number> = { nba: 30, nhl: 30, nfl: 6, mlb: 50 };

type Season = {
  league: SimLeague;
  current: number;
  prior: number;
  /** Weight on last season's counts. */
  w: number;
  /** Average team games played this season. */
  gpNow: number;
  cur: Map<string, StatLine>;
  old: Map<string, StatLine>;
  stCur: Map<string, StandingRow>;
  stOld: Map<string, StandingRow>;
  basis: string;
};

const seasonCache = new Map<string, { at: number; v: Promise<Season> }>();

/** The two seasons a league's numbers come from, fetched and weighted. */
function loadSeason(league: SimLeague, date: string): Promise<Season> {
  const current = seasonFor(league, date);
  const key = `${league}:${current}`;
  const hit = seasonCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.v;
  const v = (async (): Promise<Season> => {
    const prior = current - 1;
    const [cur, old, stCur, stOld] = await Promise.all([
      playerStats(league, current, true).catch(() => new Map<string, StatLine>()),
      playerStats(league, prior, false),
      standings(league, current, true).catch(() => new Map<string, StandingRow>()),
      standings(league, prior, false).catch(() => new Map<string, StandingRow>()),
    ]);
    const gps = [...stCur.values()].map((r) => r.gp);
    const gpNow = gps.length ? gps.reduce((a, b) => a + b, 0) / gps.length : 0;
    const w = cur.size === 0 ? 1 : Math.max(0.2, Math.min(1, 1 - gpNow / HALF[league]));
    const now = seasonLabel(league, current);
    const games = `${Math.round(gpNow)} game${Math.round(gpNow) === 1 ? "" : "s"}`;
    const then = seasonLabel(league, prior);
    const basis =
      gpNow < 0.5 || cur.size === 0
        ? `${then} season stats — ${now} has not produced numbers yet`
        : w <= 0.2
          ? `${now} stats (${games} a team), with ${then} carried at 20% weight`
          : `${now} stats (${games} a team) blended with ${then} at ${Math.round(w * 100)}% weight`;
    return { league, current, prior, w, gpNow, cur, old, stCur, stOld, basis };
  })();
  seasonCache.set(key, { at: Date.now(), v });
  v.catch(() => seasonCache.delete(key));
  return v;
}

/** Derived per-season totals that cannot be pooled from averages. */
function derive(league: SimLeague, s: Record<string, number>): Record<string, number> {
  if (league !== "nfl") return s;
  const punts = s["punting.punts"] ?? 0;
  return { ...s, "punting.netYards": punts * (s["punting.netAvgPuntYards"] ?? 0) };
}

/** This season's counts plus `w` × last season's, for one player. */
function pooled(se: Season, id: string): Record<string, number> {
  const a = se.cur.get(id);
  const b = se.old.get(id);
  const out: Record<string, number> = {};
  if (a) for (const [k, v] of Object.entries(derive(se.league, a.s))) out[k] = v;
  if (b)
    for (const [k, v] of Object.entries(derive(se.league, b.s))) out[k] = (out[k] ?? 0) + se.w * v;
  return out;
}

/** Every player id either season knows about. */
function allIds(se: Season): Set<string> {
  return new Set([...se.cur.keys(), ...se.old.keys()]);
}

const g = (s: Record<string, number>, k: string) => s[k] ?? 0;
const reg = (count: number, n: number, league: number, k: number) =>
  n + k > 0 ? (count + k * league) / (n + k) : league;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function teamRates(se: Season, teamId: string, lgPpg: number) {
  const a = se.stCur.get(teamId);
  const b = se.stOld.get(teamId);
  const gp = (a?.gp ?? 0) + se.w * (b?.gp ?? 0);
  if (gp <= 0) return { pf: lgPpg, pa: lgPpg, record: a?.record ?? "0-0" };
  return {
    pf: ((a?.pf ?? 0) + se.w * (b?.pf ?? 0)) / gp,
    pa: ((a?.pa ?? 0) + se.w * (b?.pa ?? 0)) / gp,
    record: a && a.gp > 0 ? a.record : b ? `${b.record} last season` : "0-0",
  };
}

function leaguePpg(se: Season): number {
  let pf = 0;
  let gp = 0;
  for (const r of se.stCur.values()) {
    pf += r.pf;
    gp += r.gp;
  }
  for (const r of se.stOld.values()) {
    pf += se.w * r.pf;
    gp += se.w * r.gp;
  }
  return gp > 0 ? pf / gp : 0;
}

function availability(e: RosterEntry): Availability {
  if (e.group === "injuredReserveOrOut" || e.group === "suspended") return "out";
  const s = e.injury ?? "";
  if (!s) return "active";
  if (/questionable|day-to-day|probable/i.test(s)) return "questionable";
  if (
    /out|doubtful|injured|reserve|suspen|-il|^il|bereavement|paternity|personal|restricted/i.test(s)
  )
    return "out";
  return "questionable";
}

function teamInfo(meta: TeamMeta, rates: { pf: number; pa: number; record: string }): TeamInfo {
  return {
    id: meta.id,
    abbr: meta.abbr,
    name: meta.name,
    location: meta.location,
    color: meta.color,
    altColor: meta.altColor,
    logo: meta.logo,
    record: rates.record,
    pf: rates.pf,
    pa: rates.pa,
  };
}

function base(e: RosterEntry, sample: number) {
  return {
    id: e.id,
    name: e.name,
    short: e.short,
    pos: e.pos,
    jersey: e.jersey,
    status: availability(e),
    injury: e.injury ?? undefined,
    sample: Math.round(sample * 10) / 10,
  };
}

// ------------------------------------------------------------------ NBA

/** Offensive rebounds are not split out in ESPN's league feed, so total
 *  rebounds are divided by position at the league's typical shares. */
function nbaOrebShare(pos: string): number {
  if (pos.includes("C")) return 0.34;
  if (pos.startsWith("F") || pos === "PF" || pos === "SF") return 0.25;
  return 0.16;
}

function nbaEnv(se: Season): NbaEnv & {
  reb: number;
  tov: number;
  fg2a: number;
  fg3a: number;
  fta: number;
  oreb: number;
  dreb: number;
} {
  const t = {
    min: 0,
    pts: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    reb: 0,
    oreb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    tov: 0,
    pf: 0,
  };
  for (const id of allIds(se)) {
    const s = pooled(se, id);
    const pos = se.cur.get(id)?.pos ?? se.old.get(id)?.pos ?? "";
    t.min += g(s, "general.minutes");
    t.pts += g(s, "offensive.points");
    t.fgm += g(s, "offensive.fieldGoalsMade");
    t.fga += g(s, "offensive.fieldGoalsAttempted");
    t.tpm += g(s, "offensive.threePointFieldGoalsMade");
    t.tpa += g(s, "offensive.threePointFieldGoalsAttempted");
    t.ftm += g(s, "offensive.freeThrowsMade");
    t.fta += g(s, "offensive.freeThrowsAttempted");
    t.reb += g(s, "general.rebounds");
    t.oreb += g(s, "general.rebounds") * nbaOrebShare(pos);
    t.ast += g(s, "offensive.assists");
    t.stl += g(s, "defensive.steals");
    t.blk += g(s, "defensive.blocks");
    t.tov += g(s, "offensive.turnovers");
    t.pf += g(s, "general.fouls");
  }
  const games = Math.max(1, t.min / 240);
  const m = Math.max(1, t.min);
  return {
    ppg: t.pts / games,
    pace: (t.fga + 0.44 * t.fta - t.oreb + t.tov) / games,
    fg2p: (t.fgm - t.tpm) / Math.max(1, t.fga - t.tpa),
    fg3p: t.tpm / Math.max(1, t.tpa),
    ftp: t.ftm / Math.max(1, t.fta),
    stl: t.stl / m,
    blk: t.blk / m,
    ast: t.ast / m,
    pf: t.pf / m,
    reb: t.reb / m,
    tov: t.tov / m,
    fg2a: (t.fga - t.tpa) / m,
    fg3a: t.tpa / m,
    fta: t.fta / m,
    oreb: t.oreb / m,
    dreb: (t.reb - t.oreb) / m,
  };
}

function nbaPlayer(se: Season, e: RosterEntry, env: ReturnType<typeof nbaEnv>): NbaPlayer {
  const s = pooled(se, e.id);
  const G = g(s, "general.gamesPlayed");
  const M = g(s, "general.minutes");
  const K = 250; // pseudo-minutes at the league rate
  const r = (count: number, lg: number) => reg(count, M, lg, K);
  const fga = g(s, "offensive.fieldGoalsAttempted");
  const tpa = g(s, "offensive.threePointFieldGoalsAttempted");
  const fgm = g(s, "offensive.fieldGoalsMade");
  const tpm = g(s, "offensive.threePointFieldGoalsMade");
  const reb = g(s, "general.rebounds");
  const share = nbaOrebShare(e.pos);
  // Unknowns (rookies, call-ups) shoot a touch below the league: the players
  // who arrive without numbers are, on average, not its better shooters.
  const unknown = M < 1;
  const disc = unknown ? 0.97 : 1;
  return {
    ...base(e, G),
    mpg: unknown ? 8 : M / Math.max(1, G),
    fg2a: r(fga - tpa, env.fg2a),
    fg3a: r(tpa, env.fg3a),
    fta: r(g(s, "offensive.freeThrowsAttempted"), env.fta),
    oreb: r(reb * share, env.oreb),
    dreb: r(reb * (1 - share), env.dreb),
    ast: r(g(s, "offensive.assists"), env.ast),
    stl: r(g(s, "defensive.steals"), env.stl),
    blk: r(g(s, "defensive.blocks"), env.blk),
    tov: r(g(s, "offensive.turnovers"), env.tov),
    pf: r(g(s, "general.fouls"), env.pf),
    fg2p: disc * reg(fgm - tpm, fga - tpa, env.fg2p, 150),
    fg3p: disc * reg(tpm, tpa, env.fg3p, 250),
    ftp: reg(g(s, "offensive.freeThrowsMade"), g(s, "offensive.freeThrowsAttempted"), env.ftp, 60),
  };
}

// ------------------------------------------------------------------ NHL

function nhlEnv(se: Season) {
  const t = {
    toiF: 0,
    toiD: 0,
    gF: 0,
    gD: 0,
    sogF: 0,
    sogD: 0,
    aF: 0,
    aD: 0,
    pimF: 0,
    pimD: 0,
    sa: 0,
    sv: 0,
    fo: 0,
  };
  for (const id of allIds(se)) {
    const s = pooled(se, id);
    const pos = se.cur.get(id)?.pos ?? se.old.get(id)?.pos ?? "";
    if (pos === "G") {
      t.sa += g(s, "defensive.shotsAgainst");
      t.sv += g(s, "defensive.saves");
      continue;
    }
    const d = pos === "D";
    const toi = g(s, "general.timeOnIce");
    if (d) {
      t.toiD += toi;
      t.gD += g(s, "offensive.goals");
      t.sogD += g(s, "offensive.shotsTotal");
      t.aD += g(s, "offensive.assists");
      t.pimD += g(s, "penalties.penaltyMinutes");
    } else {
      t.toiF += toi;
      t.gF += g(s, "offensive.goals");
      t.sogF += g(s, "offensive.shotsTotal");
      t.aF += g(s, "offensive.assists");
      t.pimF += g(s, "penalties.penaltyMinutes");
    }
    t.fo += g(s, "offensive.faceoffsWon") + g(s, "offensive.faceoffsLost");
  }
  const hF = Math.max(1, t.toiF / 3600);
  const hD = Math.max(1, t.toiD / 3600);
  const teamGames = Math.max(1, (t.toiF + t.toiD) / (3600 * 5));
  const env: NhlEnv = {
    gpg: leaguePpg(se) || (t.gF + t.gD) / teamGames,
    sogPerGame: (t.sogF + t.sogD) / teamGames,
    svPct: t.sa > 0 ? t.sv / t.sa : 0.9,
    shPct: (t.gF + t.gD) / Math.max(1, t.sogF + t.sogD),
  };
  return {
    env,
    F: { sog60: t.sogF / hF, sh: t.gF / Math.max(1, t.sogF), a60: t.aF / hF, pim60: t.pimF / hF },
    D: { sog60: t.sogD / hD, sh: t.gD / Math.max(1, t.sogD), a60: t.aD / hD, pim60: t.pimD / hD },
    fo60: t.fo / hF,
  };
}

function nhlSkater(se: Season, e: RosterEntry, lg: ReturnType<typeof nhlEnv>): NhlSkater {
  const s = pooled(se, e.id);
  const d = e.pos === "D";
  const P = d ? lg.D : lg.F;
  const G = g(s, "general.games");
  const toi = g(s, "general.timeOnIce");
  const hours = toi / 3600;
  const KH = 3; // pseudo-hours at the positional rate
  const r60 = (count: number, lgRate: number) => reg(count, hours, lgRate, KH);
  const sog = g(s, "offensive.shotsTotal");
  const fow = g(s, "offensive.faceoffsWon");
  const fol = g(s, "offensive.faceoffsLost");
  const unknown = toi < 60;
  return {
    ...base(e, G),
    kind: d ? "D" : "F",
    toi: unknown ? (d ? 960 : 660) : toi / Math.max(1, G),
    sog60: r60(sog, P.sog60 * (unknown ? 0.9 : 1)),
    a60: r60(g(s, "offensive.assists"), P.a60 * (unknown ? 0.9 : 1)),
    pim60: r60(g(s, "penalties.penaltyMinutes"), P.pim60),
    ppPts: (g(s, "offensive.powerPlayGoals") + g(s, "offensive.powerPlayAssists")) / Math.max(4, G),
    shPct: reg(g(s, "offensive.goals"), sog, P.sh, 70),
    fo60: (fow + fol) / Math.max(KH, hours),
    foPct: reg(fow, fow + fol, 0.5, 60),
  };
}

function nhlGoalie(se: Season, e: RosterEntry, env: NhlEnv): NhlGoalie {
  const s = pooled(se, e.id);
  const starts = g(s, "general.wins") + g(s, "general.losses") + g(s, "defensive.overtimeLosses");
  return {
    ...base(e, g(s, "general.games")),
    kind: "G",
    // Save percentage needs the better part of a thousand shots before it
    // says much about the goalie rather than the season he had.
    svPct: reg(g(s, "defensive.saves"), g(s, "defensive.shotsAgainst"), env.svPct - 0.002, 800),
    starts,
  };
}

// ------------------------------------------------------------------ MLB

function mlbPa(s: Record<string, number>) {
  const ab = g(s, "batting.atBats");
  const h = g(s, "batting.hits");
  const d2 = g(s, "batting.doubles");
  const d3 = g(s, "batting.triples");
  const hr = g(s, "batting.homeRuns");
  const bb = g(s, "batting.walks");
  const so = g(s, "batting.strikeouts");
  // HBP, sac flies and bunts are not in the feed; ~3% of at-bats covers them.
  const pa = ab + bb + 0.03 * ab;
  return {
    pa,
    ab,
    h,
    b1: h - d2 - d3 - hr,
    b2: d2,
    b3: d3,
    hr,
    bb: bb + 0.012 * ab,
    so,
    sb: g(s, "batting.stolenBases"),
  };
}

/** "162.1" innings → 162⅓. */
function innings(ip: number): number {
  const whole = Math.floor(ip + 1e-9);
  const frac = Math.round((ip - whole) * 10);
  return whole + frac / 3;
}

function mlbPitch(s: Record<string, number>) {
  const ip = innings(g(s, "pitching.innings"));
  const outs = ip * 3;
  const h = g(s, "pitching.hits");
  const bb = g(s, "pitching.walks");
  const bf = outs + h + bb + 0.02 * (outs + h + bb);
  return {
    ip,
    bf,
    h,
    hr: g(s, "pitching.homeRuns"),
    bb: bb + 0.01 * bf,
    so: g(s, "pitching.strikeouts"),
    er: g(s, "pitching.earnedRuns"),
    gp: g(s, "pitching.gamesPlayed"),
    gs: g(s, "pitching.gamesStarted"),
    sv: g(s, "pitching.saves"),
    hld: g(s, "pitching.holds"),
  };
}

function mlbEnv(se: Season) {
  const t = { pa: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, so: 0, sb: 0, onFirst: 0, bfS: 0, gs: 0 };
  // The pitching side of the same league, from the pitchers' own lines. In
  // principle identical to the batting side; in practice batters faced has to
  // be estimated from innings, hits and walks, and comparing each pitcher with
  // the league as measured the same way cancels that estimate's bias.
  const q = { bf: 0, h: 0, hr: 0, bb: 0, so: 0 };
  for (const id of allIds(se)) {
    const s = pooled(se, id);
    const b = mlbPa(s);
    t.pa += b.pa;
    t.b1 += b.b1;
    t.b2 += b.b2;
    t.b3 += b.b3;
    t.hr += b.hr;
    t.bb += b.bb;
    t.so += b.so;
    t.sb += b.sb;
    t.onFirst += b.b1 + b.bb;
    const p = mlbPitch(s);
    q.bf += p.bf;
    q.h += p.h - p.hr;
    q.hr += p.hr;
    q.bb += p.bb;
    q.so += p.so;
    if (p.gs >= 3 && p.gs / Math.max(1, p.gp) >= 0.6) {
      t.bfS += p.bf;
      t.gs += p.gp;
    }
  }
  const pa = Math.max(1, t.pa);
  const rates: PaRates = {
    bb: t.bb / pa,
    so: t.so / pa,
    hr: t.hr / pa,
    b3: t.b3 / pa,
    b2: t.b2 / pa,
    b1: t.b1 / pa,
  };
  const bf = Math.max(1, q.bf);
  const hitsB = rates.b1 + rates.b2 + rates.b3;
  const hitsP = q.h / bf;
  const pRates: PaRates = {
    bb: q.bb / bf,
    so: q.so / bf,
    hr: q.hr / bf,
    b3: (hitsP * rates.b3) / hitsB,
    b2: (hitsP * rates.b2) / hitsB,
    b1: (hitsP * rates.b1) / hitsB,
  };
  return {
    env: { rpg: leaguePpg(se) || 4.4, rates, pRates } as MlbEnv,
    sbAttempt: t.sb / 0.77 / Math.max(1, t.onFirst) / 1.3,
    bfPerStart: t.gs > 0 ? t.bfS / t.gs : 22,
  };
}

function mlbBatter(se: Season, e: RosterEntry, lg: ReturnType<typeof mlbEnv>): MlbBatter {
  const s = pooled(se, e.id);
  const b = mlbPa(s);
  const L = lg.env.rates;
  const unknown = b.pa < 1;
  const disc = unknown ? 0.92 : 1;
  // Each outcome regresses by how quickly it stabilises: strikeout rate means
  // something after ~100 plate appearances, walk rate after ~150, power after
  // ~250, but singles — mostly balls-in-play luck — need a season or two.
  const rates: PaRates = {
    bb: reg(b.bb, b.pa, L.bb * disc, 150),
    so: reg(b.so, b.pa, L.so / disc, 100),
    hr: reg(b.hr, b.pa, L.hr * disc, 250),
    b3: reg(b.b3, b.pa, L.b3, 500),
    b2: reg(b.b2, b.pa, L.b2 * disc, 500),
    b1: reg(b.b1, b.pa, L.b1 * disc, 600),
  };
  const obp = rates.bb + rates.b1 + rates.b2 + rates.b3 + rates.hr;
  const slg = (rates.b1 + 2 * rates.b2 + 3 * rates.b3 + 4 * rates.hr) / Math.max(0.5, 1 - rates.bb);
  return {
    ...base(e, g(s, "batting.gamesPlayed")),
    kind: "B",
    pa: b.pa,
    rates,
    sbAttempt: reg(b.sb / 0.77 / 1.3, b.b1 + b.bb, lg.sbAttempt, 40),
    obp,
    ops: obp + slg,
  };
}

function mlbPitcher(se: Season, e: RosterEntry, lg: ReturnType<typeof mlbEnv>): MlbPitcher {
  const s = pooled(se, e.id);
  const p = mlbPitch(s);
  const L = lg.env.pRates;
  const hitsLg = L.b1 + L.b2 + L.b3;
  // Pitchers own their strikeouts and walks; home runs and hits on balls in
  // play are mostly the defence and luck, so those regress hard. The 1B/2B/3B
  // split of the hits he does allow is the league's.
  const hits = reg(p.h - p.hr, p.bf, hitsLg * (p.bf < 1 ? 1.05 : 1), 700);
  const starter = p.gs >= 3 && p.gs / Math.max(1, p.gp) >= 0.5;
  const perStart = starter ? p.bf / Math.max(1, p.gp) : 6;
  return {
    ...base(e, p.gp),
    kind: "P",
    bf: p.bf,
    rates: {
      bb: reg(p.bb, p.bf, L.bb, 200),
      so: reg(p.so, p.bf, L.so * (p.bf < 1 ? 0.92 : 1), 150),
      hr: reg(p.hr, p.bf, L.hr, 450),
      b3: (hits * L.b3) / hitsLg,
      b2: (hits * L.b2) / hitsLg,
      b1: (hits * L.b1) / hitsLg,
    },
    starts: p.gs,
    bfPerStart: starter ? (perStart * p.gs + 4 * lg.bfPerStart) / (p.gs + 4) : perStart,
    saves: p.sv,
    holds: p.hld,
    era: p.ip > 0 ? (p.er * 9) / p.ip : 4.5,
    ip: Math.round(p.ip * 10) / 10,
  };
}

/** Run index by home club, 100 = neutral. Same three-year public numbers as
 *  the venue table the MLB model uses, keyed by ESPN abbreviation. */
const PARK: Record<string, number> = {
  COL: 112,
  BOS: 106,
  CIN: 105,
  TEX: 104,
  NYY: 103,
  CHC: 102,
  PHI: 102,
  ARI: 102,
  ATL: 101,
  TOR: 101,
  KC: 101,
  CHW: 101,
  HOU: 100,
  WSH: 100,
  MIN: 100,
  MIL: 100,
  ATH: 100,
  OAK: 100,
  MIA: 99,
  NYM: 99,
  CLE: 99,
  BAL: 99,
  DET: 98,
  PIT: 98,
  LAA: 98,
  STL: 97,
  LAD: 97,
  TB: 96,
  SF: 95,
  SEA: 95,
  SD: 95,
};

// ------------------------------------------------------------------ NFL

type NflLg = {
  env: NflEnv;
  rec: Record<"WR" | "TE" | "RB", { catch: number; ypr: number; td: number }>;
  rush: Record<"RB" | "QB" | "X", { ypc: number; td: number }>;
  fgBucket: number[];
  xp: number;
  net: number;
  fumble: number;
  share: number;
};

const FG_BUCKETS = ["1_19", "20_29", "30_39", "40_49", "50"];

function recGroup(pos: string): "WR" | "TE" | "RB" {
  if (pos === "TE") return "TE";
  if (pos === "RB" || pos === "FB" || pos === "HB") return "RB";
  return "WR";
}
function rushGroup(pos: string): "RB" | "QB" | "X" {
  if (pos === "QB") return "QB";
  if (pos === "RB" || pos === "FB" || pos === "HB") return "RB";
  return "X";
}

function nflEnv(se: Season): NflLg {
  const t = {
    att: 0,
    cmp: 0,
    pyd: 0,
    ptd: 0,
    int: 0,
    sk: 0,
    car: 0,
    ryd: 0,
    xpm: 0,
    xpa: 0,
    punts: 0,
    net: 0,
    fum: 0,
    touch: 0,
    tgt: 0,
  };
  const rec = { WR: [0, 0, 0, 0], TE: [0, 0, 0, 0], RB: [0, 0, 0, 0] }; // tgt, rec, yds, td
  const rush = { RB: [0, 0, 0], QB: [0, 0, 0], X: [0, 0, 0] }; // car, yds, td
  const fgM = [0, 0, 0, 0, 0];
  const fgA = [0, 0, 0, 0, 0];
  for (const id of allIds(se)) {
    const s = pooled(se, id);
    const pos = se.cur.get(id)?.pos ?? se.old.get(id)?.pos ?? "";
    t.att += g(s, "passing.passingAttempts");
    t.cmp += g(s, "passing.completions");
    t.pyd += g(s, "passing.passingYards");
    t.ptd += g(s, "passing.passingTouchdowns");
    t.int += g(s, "passing.interceptions");
    t.sk += g(s, "passing.sacks");
    const car = g(s, "rushing.rushingAttempts");
    t.car += car;
    t.ryd += g(s, "rushing.rushingYards");
    const rg = rush[rushGroup(pos)];
    rg[0] += car;
    rg[1] += g(s, "rushing.rushingYards");
    rg[2] += g(s, "rushing.rushingTouchdowns");
    const tgt = g(s, "receiving.receivingTargets");
    t.tgt += tgt;
    const r = rec[recGroup(pos)];
    r[0] += tgt;
    r[1] += g(s, "receiving.receptions");
    r[2] += g(s, "receiving.receivingYards");
    r[3] += g(s, "receiving.receivingTouchdowns");
    t.fum += g(s, "rushing.rushingFumblesLost") + g(s, "receiving.receivingFumblesLost");
    t.touch += car + g(s, "receiving.receptions");
    FG_BUCKETS.forEach((b, i) => {
      fgM[i] += g(s, `kicking.fieldGoalsMade${b}`);
      fgA[i] += g(s, `kicking.fieldGoalAttempts${b}`);
    });
    t.xpm += g(s, "kicking.extraPointsMade");
    t.xpa += g(s, "kicking.extraPointAttempts");
    t.punts += g(s, "punting.punts");
    t.net += g(s, "punting.netYards");
  }
  const recRates = (a: number[]) => ({
    catch: a[1] / Math.max(1, a[0]),
    ypr: a[2] / Math.max(1, a[1]),
    td: a[3] / Math.max(1, a[0]),
  });
  const rushRates = (a: number[]) => ({
    ypc: a[1] / Math.max(1, a[0]),
    td: a[2] / Math.max(1, a[0]),
  });
  return {
    env: {
      ppg: leaguePpg(se) || 22,
      cmpPct: t.cmp / Math.max(1, t.att),
      ypc: t.pyd / Math.max(1, t.cmp),
      ypcRush: t.ryd / Math.max(1, t.car),
      intRate: t.int / Math.max(1, t.att),
      sackRate: t.sk / Math.max(1, t.att + t.sk),
      passTd: t.ptd / Math.max(1, t.att),
    },
    rec: { WR: recRates(rec.WR), TE: recRates(rec.TE), RB: recRates(rec.RB) },
    rush: { RB: rushRates(rush.RB), QB: rushRates(rush.QB), X: rushRates(rush.X) },
    fgBucket: fgA.map((a, i) => (a > 0 ? fgM[i] / a : 0.8)),
    xp: t.xpm / Math.max(1, t.xpa),
    net: t.punts > 0 ? t.net / t.punts : 41,
    fumble: t.fum / Math.max(1, t.touch),
    share: t.tgt / Math.max(1, t.tgt + t.car),
  };
}

const DEF_FLOOR: Record<string, { tkl: number; sk: number; int: number }> = {
  LB: { tkl: 3.5, sk: 0.12, int: 0.03 },
  ILB: { tkl: 4.5, sk: 0.1, int: 0.03 },
  OLB: { tkl: 3, sk: 0.3, int: 0.02 },
  DE: { tkl: 2, sk: 0.3, int: 0.005 },
  DT: { tkl: 1.8, sk: 0.15, int: 0.005 },
  NT: { tkl: 1.5, sk: 0.08, int: 0.003 },
  DL: { tkl: 2, sk: 0.25, int: 0.005 },
  EDGE: { tkl: 2.2, sk: 0.35, int: 0.005 },
  CB: { tkl: 2.5, sk: 0.02, int: 0.06 },
  S: { tkl: 3.5, sk: 0.04, int: 0.05 },
  SS: { tkl: 3.8, sk: 0.05, int: 0.04 },
  FS: { tkl: 3.2, sk: 0.03, int: 0.06 },
  DB: { tkl: 2.8, sk: 0.03, int: 0.05 },
};

function nflPlayer(se: Season, e: RosterEntry, lg: NflLg): NflPlayer {
  const s = pooled(se, e.id);
  const G = Math.max(0, g(s, "general.gamesPlayed"));
  const per = Math.max(1, G);
  const E = lg.env;
  const att = g(s, "passing.passingAttempts");
  const cmp = g(s, "passing.completions");
  const sk = g(s, "passing.sacks");
  const car = g(s, "rushing.rushingAttempts");
  const tgt = g(s, "receiving.receivingTargets");
  const recs = g(s, "receiving.receptions");
  const rg = lg.rush[rushGroup(e.pos)];
  const cg = lg.rec[recGroup(e.pos)];
  // Backups and unknowns regress to a below-average passer, not an average
  // one: the quarterbacks without many attempts are mostly the ones teams
  // chose not to play.
  const fgA = FG_BUCKETS.reduce((acc, b) => acc + g(s, `kicking.fieldGoalAttempts${b}`), 0);
  const fgExp = FG_BUCKETS.reduce(
    (acc, b, i) => acc + g(s, `kicking.fieldGoalAttempts${b}`) * lg.fgBucket[i],
    0,
  );
  const fgM = g(s, "kicking.fieldGoalsMade");
  const punts = g(s, "punting.punts");
  const floor = DEF_FLOOR[e.pos] ?? { tkl: 0.3, sk: 0, int: 0 };
  const unit: NflPlayer["unit"] =
    e.group === "defense" || floor.tkl > 1 ? "def" : e.group === "specialTeam" ? "st" : "off";
  return {
    ...base(e, G),
    unit,
    passAtt: att / per,
    cmpPct: reg(cmp, att, E.cmpPct - 0.03, 180),
    ypc: reg(g(s, "passing.passingYards"), cmp, E.ypc - 0.5, 90),
    passTd: reg(g(s, "passing.passingTouchdowns"), att, E.passTd * 0.85, 250),
    intRate: reg(g(s, "passing.interceptions"), att, E.intRate * 1.15, 300),
    sackRate: reg(sk, att + sk, E.sackRate * 1.05, 180),
    carries: car / per,
    ypc_r: reg(g(s, "rushing.rushingYards"), car, rg.ypc * 0.96, 70),
    rushTd: reg(g(s, "rushing.rushingTouchdowns"), car, rg.td, 90),
    fumble: reg(
      g(s, "rushing.rushingFumblesLost") + g(s, "receiving.receivingFumblesLost"),
      car + recs,
      lg.fumble,
      150,
    ),
    targets: tgt / per,
    catchRate: reg(recs, tgt, cg.catch - 0.02, 45),
    ypr: reg(g(s, "receiving.receivingYards"), recs, cg.ypr * 0.95, 30),
    recTd: reg(g(s, "receiving.receivingTouchdowns"), tgt, cg.td, 70),
    fgSkill: fgA > 0 || e.pos === "PK" || e.pos === "K" ? (fgM + 12) / (fgExp + 12) : 0.9,
    xpPct: reg(g(s, "kicking.extraPointsMade"), g(s, "kicking.extraPointAttempts"), lg.xp, 40),
    longFg: g(s, "kicking.longFieldGoalMade"),
    puntNet: reg(g(s, "punting.netYards"), punts, lg.net - 1, 30),
    tackles: (g(s, "defensive.totalTackles") + 2 * floor.tkl) / (G + 2),
    sacks: (g(s, "defensive.sacks") + 2 * floor.sk) / (G + 2),
    ints: (g(s, "defensiveinterceptions.interceptions") + 2 * floor.int) / (G + 2),
  };
}

// ------------------------------------------------------------ assembly

async function teamMeta(league: SimLeague, id: string): Promise<TeamMeta> {
  const all = await fetchTeams(league);
  const m = all.find((t) => t.id === id);
  if (!m) throw new Error(`Unknown ${league} team ${id}`);
  return m;
}

export type MatchupRequest = {
  league: SimLeague;
  homeId: string;
  awayId: string;
  date: string;
  gameId?: string | null;
};

/**
 * Build everything one game needs. When a game id is given the scoreboard
 * supplies the venue, the posted line, the postseason flag and the probable
 * starters; for a made-up matchup those are left for the user to set.
 */
export async function buildMatchup(req: MatchupRequest): Promise<SimMatchup> {
  const { league, homeId, awayId, date } = req;
  const se = await loadSeason(league, date);
  const [homeMeta, awayMeta, homeRoster, awayRoster, board] = await Promise.all([
    teamMeta(league, homeId),
    teamMeta(league, awayId),
    fetchRoster(league, homeId),
    fetchRoster(league, awayId),
    req.gameId ? scoreboard(league, date).catch(() => []) : Promise.resolve([] as ScoreboardGame[]),
  ]);
  const game = req.gameId ? board.find((x) => x.id === req.gameId) : undefined;
  const ctx: MatchupContext = {
    gameId: game?.id ?? null,
    date,
    venue: game?.venue ?? `${homeMeta.location}`,
    neutral: game?.neutral ?? false,
    playoff: game?.playoff ?? false,
    line: game?.line ?? null,
    basis: se.basis,
  };

  if (league === "nba") {
    const env = nbaEnv(se);
    const mk = (meta: TeamMeta, ros: RosterEntry[]): NbaTeam => ({
      ...teamInfo(meta, teamRates(se, meta.id, env.ppg)),
      players: ros.map((e) => nbaPlayer(se, e, env)).sort((a, b) => b.mpg - a.mpg),
    });
    const { ppg, pace, fg2p, fg3p, ftp, stl, blk, ast, pf } = env;
    return {
      league,
      home: mk(homeMeta, homeRoster),
      away: mk(awayMeta, awayRoster),
      env: { ppg, pace, fg2p, fg3p, ftp, stl, blk, ast, pf },
      ctx,
    };
  }

  if (league === "nhl") {
    const lg = nhlEnv(se);
    const mk = (meta: TeamMeta, ros: RosterEntry[], probable?: string): NhlTeam => {
      const rates = teamRates(se, meta.id, lg.env.gpg);
      const goalies = ros
        .filter((e) => e.pos === "G")
        .map((e) => nhlGoalie(se, e, lg.env))
        .sort((a, b) => b.starts - a.starts);
      const active = goalies.filter((x) => x.status !== "out");
      const pool = active.length ? active : goalies;
      const starts = pool.reduce((a, x) => a + Math.max(1, x.starts), 0);
      const teamSv = starts
        ? pool.reduce((a, x) => a + x.svPct * Math.max(1, x.starts), 0) / starts
        : lg.env.svPct;
      // Goals allowed = shots allowed × (1 − save%). Dividing the goalies out
      // of the goals leaves the skaters' share: how many shots get through.
      const shotsAllowed = rates.pa / Math.max(0.03, 1 - teamSv);
      const raw = shotsAllowed / Math.max(1, lg.env.sogPerGame);
      return {
        ...teamInfo(meta, rates),
        skaters: ros
          .filter((e) => e.pos !== "G")
          .map((e) => nhlSkater(se, e, lg))
          .sort((a, b) => b.toi - a.toi),
        goalies,
        probable,
        shotSuppression: clamp(1 + 0.65 * (raw - 1), 0.85, 1.15),
      };
    };
    return {
      league,
      home: mk(homeMeta, homeRoster, game?.probable.home),
      away: mk(awayMeta, awayRoster, game?.probable.away),
      env: lg.env,
      ctx,
    };
  }

  if (league === "mlb") {
    const lg = mlbEnv(se);
    const isPitcher = (e: RosterEntry) => e.pos === "SP" || e.pos === "RP" || e.pos === "P";
    const mk = (meta: TeamMeta, ros: RosterEntry[], probable?: string): MlbTeam => {
      const batters: MlbBatter[] = [];
      const pitchers: MlbPitcher[] = [];
      for (const e of ros) {
        const s = pooled(se, e.id);
        const pitched = mlbPitch(s).bf;
        const batted = mlbPa(s).pa;
        if (isPitcher(e) || pitched > 60) pitchers.push(mlbPitcher(se, e, lg));
        if (!isPitcher(e) || batted > 60) batters.push(mlbBatter(se, e, lg));
      }
      batters.sort((a, b) => b.pa - a.pa);
      pitchers.sort((a, b) => b.starts - a.starts || b.ip - a.ip);
      return {
        ...teamInfo(meta, teamRates(se, meta.id, lg.env.rpg)),
        batters,
        pitchers,
        probable,
      };
    };
    ctx.park = PARK[homeMeta.abbr] ?? 100;
    return {
      league,
      home: mk(homeMeta, homeRoster, game?.probable.home),
      away: mk(awayMeta, awayRoster, game?.probable.away),
      env: lg.env,
      ctx,
    };
  }

  const lg = nflEnv(se);
  const mk = (meta: TeamMeta, ros: RosterEntry[]): NflTeam => {
    const players = ros.filter((e) => e.group !== "practiceSquad").map((e) => nflPlayer(se, e, lg));
    // How pass-heavy this roster plays: its targets against its carries,
    // relative to the league's, mapped onto the league's ~58% pass rate.
    let tg = 0;
    let cr = 0;
    for (const p of players) {
      tg += p.targets * Math.max(1, p.sample);
      cr += p.carries * Math.max(1, p.sample);
    }
    const share = tg + cr > 0 ? tg / (tg + cr) : lg.share;
    return {
      ...teamInfo(meta, teamRates(se, meta.id, lg.env.ppg)),
      players,
      passRate: clamp(0.585 + 0.8 * (share - lg.share), 0.48, 0.68),
    };
  };
  return {
    league,
    home: mk(homeMeta, homeRoster),
    away: mk(awayMeta, awayRoster),
    env: lg.env,
    ctx,
  };
}

// ------------------------------------------------------------- the slate

export type SlateTeam = { id: string; abbr: string; name: string; logo: string; color: string };

export type SlateEntry = {
  id: string;
  date: string;
  state: ScoreboardGame["state"];
  status: string;
  venue: string;
  neutral: boolean;
  playoff: boolean;
  home: SlateTeam;
  away: SlateTeam;
  homeScore: number | null;
  awayScore: number | null;
  line: ScoreboardGame["line"];
  probableName: ScoreboardGame["probableName"];
};

export async function buildSlate(league: SimLeague, date: string): Promise<SlateEntry[]> {
  const [board, all] = await Promise.all([scoreboard(league, date), fetchTeams(league)]);
  const byId = new Map(all.map((t) => [t.id, t]));
  const pick = (id: string): SlateTeam => {
    const t = byId.get(id);
    return {
      id,
      abbr: t?.abbr ?? "?",
      name: t?.name ?? "?",
      logo: t?.logo ?? "",
      color: t?.color ?? "#64748b",
    };
  };
  return board
    .filter((x) => byId.has(x.homeId) && byId.has(x.awayId))
    .map((x) => ({
      id: x.id,
      date: x.date,
      state: x.state,
      status: x.status,
      venue: x.venue,
      neutral: x.neutral,
      playoff: x.playoff,
      home: pick(x.homeId),
      away: pick(x.awayId),
      homeScore: x.homeScore,
      awayScore: x.awayScore,
      line: x.line,
      probableName: x.probableName,
    }));
}

export async function listTeams(league: SimLeague): Promise<SlateTeam[]> {
  const all = await fetchTeams(league);
  return all.map((t) => ({
    id: t.id,
    abbr: t.abbr,
    name: t.displayName,
    logo: t.logo,
    color: t.color,
  }));
}
