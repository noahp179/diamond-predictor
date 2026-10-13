/**
 * ucl.server.ts — the Champions League's live data: ratings, the day's slate,
 * squads for the simulator, and the replayed history the Track Record reads.
 *
 * The ratings are one Elo over every club in Europe (see ucl-model.ts). Rather
 * than replay thirteen years of thirty competitions on every cold start, the
 * research pipeline ships a snapshot of every club's rating as of a cut-off
 * (ucl-ratings.json), and this module continues the replay from there over the
 * results ESPN has posted since — month by month, for every competition the
 * research read. Re-running research/ucl/ship_ucl.py moves the cut-off forward
 * and shortens that read; it never changes the answer.
 *
 * ESPN refuses date-range scoreboard queries (400) as of autumn 2026, so this
 * reads `dates=YYYYMM`, one month per call.
 */

import history from "./ucl-history.json";
import scorersFile from "./ucl-scorers.json";
import snapshotFile from "./ucl-ratings.json";
import {
  byKickoff,
  priceMatch,
  priceRates,
  replayInto,
  stateFromSnapshot,
  UCL_COMPS,
  type MatchPrice,
  type RatingState,
  type Snapshot,
  type UclResult,
} from "./ucl-model";
import type { Scorer } from "./sim/soccer";

const API = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const SNAPSHOT = snapshotFile as unknown as Snapshot & { ucl: Record<string, string> };

// ------------------------------------------------------------------ fetch

type EspnCompetitor = {
  homeAway: "home" | "away";
  score?: string;
  team: {
    id: string;
    abbreviation?: string;
    displayName?: string;
    shortDisplayName?: string;
    logo?: string;
  };
  records?: { type?: string; summary?: string }[];
};

type EspnOdds = {
  provider?: { name?: string };
  moneyline?: Record<string, { open?: { odds?: string }; close?: { odds?: string } }>;
  drawOdds?: { moneyLine?: number };
};

export type EspnSoccerEvent = {
  id: string;
  date: string;
  status: { type: { name?: string; state?: string; shortDetail?: string; completed?: boolean } };
  competitions: {
    status?: EspnSoccerEvent["status"];
    neutralSite?: boolean;
    venue?: { fullName?: string };
    competitors: EspnCompetitor[];
    odds?: (EspnOdds | null)[];
    details?: {
      scoringPlay?: boolean;
      shootout?: boolean;
      clock?: { displayValue?: string };
      team?: { id?: string };
    }[];
  }[];
};

async function fetchEvents(comp: string, dates: string): Promise<EspnSoccerEvent[]> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(`${API}/${comp}/scoreboard?dates=${dates}&limit=1000`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return ((await res.json()) as { events?: EspnSoccerEvent[] }).events ?? [];
      last = String(res.status);
    } catch (err) {
      last = String(err);
    }
  }
  throw new Error(`ESPN ${comp} ${dates}: ${last}`);
}

/** Months from the snapshot's cut-off through `until`, as YYYYMM. */
function monthsSince(cutoff: string, until: string): string[] {
  const out: string[] = [];
  let y = Number(cutoff.slice(0, 4));
  let m = Number(cutoff.slice(5, 7));
  const ey = Number(until.slice(0, 4));
  const em = Number(until.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const monthCache = new Map<string, { at: number; events: EspnSoccerEvent[] }>();
const CURRENT_TTL = 10 * 60 * 1000;

async function monthEvents(comp: string, yyyymm: string, current: string) {
  const key = `${comp}:${yyyymm}`;
  const hit = monthCache.get(key);
  // A finished month never changes; the current one gets a short TTL.
  if (hit && (yyyymm < current || Date.now() - hit.at < CURRENT_TTL)) return hit.events;
  const events = await fetchEvents(comp, yyyymm);
  monthCache.set(key, { at: Date.now(), events });
  return events;
}

type LiveResult = UclResult & {
  /** 90-minute result — what 1X2 settles on, and what the history scores. */
  r90: "H" | "D" | "A";
};

/** Same rule as research/ucl/fetch_ucl.py: completed, with a numeric score. */
function resultOf(comp: string, e: EspnSoccerEvent): LiveResult | null {
  const c = e.competitions?.[0];
  const h = c?.competitors?.find((x) => x.homeAway === "home");
  const a = c?.competitors?.find((x) => x.homeAway === "away");
  const type = c?.status?.type ?? e.status?.type;
  if (!h || !a || !type?.completed) return null;
  if (["STATUS_ABANDONED", "STATUS_CANCELED", "STATUS_POSTPONED"].includes(type.name ?? ""))
    return null;
  if (!/^\d+$/.test(h.score ?? "") || !/^\d+$/.test(a.score ?? "")) return null;
  const hg = Number(h.score);
  const ag = Number(a.score);
  const s90 = result90(e, h.team.id, hg, ag);
  return {
    id: e.id,
    comp,
    date: e.date,
    home: h.team.id,
    away: a.team.id,
    hg,
    ag,
    neutral: Boolean(c.neutralSite),
    r90: s90.hg > s90.ag ? "H" : s90.hg === s90.ag ? "D" : "A",
  };
}

type Live = {
  at: number;
  results: LiveResult[];
  names: Map<string, string>;
  /** Competitions ESPN failed to answer for; their results are missing. */
  missing: string[];
};

let liveCache: Live | null = null;
let liveInflight: Promise<Live> | null = null;

/**
 * Every completed match in every competition since the snapshot's cut-off.
 * Thirty competitions × the months since the cut-off; six at a time so ESPN
 * does not throttle the burst.
 */
async function liveResults(): Promise<Live> {
  if (liveCache && Date.now() - liveCache.at < CURRENT_TTL) return liveCache;
  if (liveInflight) return liveInflight;
  liveInflight = (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const current = today.slice(0, 7).replace("-", "");
    const months = monthsSince(SNAPSHOT.cutoff, today);
    const jobs = UCL_COMPS.flatMap((comp) => months.map((mo) => ({ comp, mo })));
    const byId = new Map<string, LiveResult>();
    const names = new Map<string, string>();
    const missing = new Set<string>();
    for (let i = 0; i < jobs.length; i += 6) {
      const batch = jobs.slice(i, i + 6);
      const got = await Promise.all(
        batch.map(({ comp, mo }) =>
          monthEvents(comp, mo, current).catch((err) => {
            console.error(`[ucl] ${comp} ${mo}:`, err);
            missing.add(comp);
            return [] as EspnSoccerEvent[];
          }),
        ),
      );
      got.forEach((events, j) => {
        for (const e of events) {
          for (const c of e.competitions?.[0]?.competitors ?? []) {
            if (c.team.displayName) names.set(c.team.id, c.team.displayName);
          }
          if (e.date < SNAPSHOT.cutoff) continue;
          const r = resultOf(batch[j].comp, e);
          // Later competitions overwrite earlier ones on a shared id, exactly as
          // the research's dict did.
          if (r) byId.set(r.id, r);
        }
      });
    }
    const results = [...byId.values()].sort(byKickoff);
    liveCache = { at: Date.now(), results, names, missing: [...missing].sort() };
    return liveCache;
  })().finally(() => {
    liveInflight = null;
  });
  return liveInflight;
}

/** The snapshot plus every result before `before` (an ISO date or instant). */
async function ratingsBefore(
  before: string,
  observer?: (m: UclResult, rh: number, ra: number) => void,
): Promise<{ state: RatingState; live: Live }> {
  const live = await liveResults();
  const state = stateFromSnapshot(SNAPSHOT);
  replayInto(
    state,
    live.results.filter((r) => r.date < before),
    undefined,
    observer,
  );
  return { state, live };
}

/**
 * Finished matches in one competition on one date, by ESPN event id, settled on
 * the 90-minute result — what the tracking settler needs and nothing more. One
 * call, against the full rating replay a slate costs.
 */
export async function soccerDayResults(
  comp: string,
  date: string,
): Promise<Map<string, { result: "a" | "draw" | "b"; score: string }>> {
  const events = await fetchEvents(comp, date.replace(/-/g, ""));
  const out = new Map<string, { result: "a" | "draw" | "b"; score: string }>();
  for (const e of events) {
    const r = resultOf(comp, e);
    if (!r) continue;
    out.set(r.id, {
      result: r.r90 === "H" ? "a" : r.r90 === "D" ? "draw" : "b",
      score: `${r.hg}-${r.ag}`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ slate

export type UclTeam = { id: string; abbr: string; name: string; logo?: string; record?: string };

export type UclMatch = {
  id: string;
  date: string;
  status: string;
  completed: boolean;
  venue: string;
  home: UclTeam;
  away: UclTeam;
  homeGoals: number | null;
  awayGoals: number | null;
  probs: { home: number; draw: number; away: number } | null;
  ratingGap: number | null;
  result: "H" | "D" | "A" | null;
  homeRating: number | null;
  awayRating: number | null;
  neutral: boolean;
  price: MatchPrice | null;
  /** ESPN's posted 1X2 with the margin taken out, when there is one. */
  market: { home: number; draw: number; away: number; overround: number; provider: string } | null;
};

export type UclSlate = {
  date: string;
  season: number;
  matches: UclMatch[];
  table: { team: UclTeam; rating: number; played: number }[];
  /** Where the ratings came from — snapshot cut-off and live results since. */
  ratings: { cutoff: string; liveResults: number; missing: string[] };
};

function americanToProb(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null || s === "") return null;
  const v = Number(String(s).replace("+", ""));
  if (!Number.isFinite(v) || v === 0) return null;
  return v > 0 ? 100 / (v + 100) : -v / (-v + 100);
}

function marketOf(e: EspnSoccerEvent): UclMatch["market"] {
  const o = e.competitions?.[0]?.odds?.[0];
  if (!o?.moneyline) return null;
  const side = (k: string) => {
    const s = o.moneyline?.[k];
    return americanToProb(s?.close?.odds ?? s?.open?.odds);
  };
  const h = side("home");
  const a = side("away");
  const d =
    o.drawOdds?.moneyLine !== undefined ? americanToProb(o.drawOdds.moneyLine) : side("draw");
  if (h === null || a === null || d === null) return null;
  const s = h + d + a;
  return {
    home: h / s,
    draw: d / s,
    away: a / s,
    overround: s - 1,
    provider: o.provider?.name ?? "",
  };
}

/** 90-minute score from the goal log, for matches that went to extra time.
 *  Without a log, an extra-time match was a 90-minute draw at an unknown score. */
function result90(e: EspnSoccerEvent, homeId: string, hg: number, ag: number) {
  const name = e.competitions?.[0]?.status?.type?.name ?? e.status?.type?.name ?? "";
  if (!["STATUS_FINAL_AET", "STATUS_FINAL_PEN", "STATUS_FINAL_AGT"].includes(name))
    return { hg, ag };
  const log = (e.competitions?.[0]?.details ?? []).filter((d) => d.scoringPlay && !d.shootout);
  if (log.length === 0) return { hg: 0, ag: 0 };
  let h = 0;
  let a = 0;
  for (const d of log) {
    if (!d.scoringPlay || d.shootout) continue;
    const minute = Number((d.clock?.displayValue ?? "").match(/^(\d+)/)?.[1] ?? 999);
    if (minute > 90) continue;
    if (d.team?.id === homeId) h += 1;
    else a += 1;
  }
  return { hg: h, ag: a };
}

function teamOf(c: EspnCompetitor): UclTeam {
  return {
    id: c.team.id,
    abbr: c.team.abbreviation ?? c.team.shortDisplayName ?? "?",
    name: c.team.shortDisplayName ?? c.team.displayName ?? "?",
    logo: c.team.logo,
    record: c.records?.find((r) => r.type === "total")?.summary ?? c.records?.[0]?.summary,
  };
}

type HistoryRow = [
  string, // id
  string, // date
  string, // home
  string, // away
  number, // pHome
  number, // pDraw
  number, // pAway
  number, // xgHome
  number, // xgAway
  number | null, // hg (90')
  number | null, // ag (90')
  "H" | "D" | "A",
];
const HISTORY = history as unknown as { cutoff: string; rows: HistoryRow[] };
const HISTORY_BY_ID = new Map(HISTORY.rows.map((r) => [r[0], r]));

export async function uclSlate(date: string): Promise<UclSlate> {
  const [dayEvents, { state, live }] = await Promise.all([
    fetchEvents("uefa.champions", date.replace(/-/g, "")),
    ratingsBefore(date),
  ]);
  const beforeCutoff = date < SNAPSHOT.cutoff;
  const matches: UclMatch[] = [];
  for (const e of dayEvents) {
    const comp = e.competitions?.[0];
    const h = comp?.competitors?.find((c) => c.homeAway === "home");
    const a = comp?.competitors?.find((c) => c.homeAway === "away");
    if (!h || !a) continue;
    const completed = Boolean(e.status?.type?.completed);
    const rawH = Number(h.score);
    const rawA = Number(a.score);
    const scored = completed && Number.isFinite(rawH) && Number.isFinite(rawA);
    const s90 = scored ? result90(e, h.team.id, rawH, rawA) : null;
    const neutral = Boolean(comp.neutralSite);

    // Ratings for a date before the snapshot's cut-off cannot be rebuilt from
    // the snapshot; those matches are priced from the shipped walk-forward
    // history instead, which is exactly what the model said that morning.
    let price: MatchPrice | null = null;
    let rh: number | null = null;
    let ra: number | null = null;
    if (beforeCutoff) {
      const row = HISTORY_BY_ID.get(e.id);
      // The stored 1X2 came from that season's own refitted mapping; the
      // scorelines are redrawn from its goal rates with the shipped one.
      if (row) price = { ...priceRates(row[7], row[8]), home: row[4], draw: row[5], away: row[6] };
    } else {
      rh = state.rating.get(h.team.id) ?? null;
      ra = state.rating.get(a.team.id) ?? null;
      if (rh !== null && ra !== null) price = priceMatch(rh, ra, neutral);
    }

    matches.push({
      id: e.id,
      date: e.date,
      status: e.status?.type?.shortDetail ?? e.status?.type?.name ?? "Scheduled",
      completed,
      venue: comp.venue?.fullName ?? "",
      home: teamOf(h),
      away: teamOf(a),
      homeGoals: scored ? rawH : null,
      awayGoals: scored ? rawA : null,
      probs: price ? { home: price.home, draw: price.draw, away: price.away } : null,
      ratingGap: rh !== null && ra !== null ? rh - ra : null,
      result: s90 ? (s90.hg > s90.ag ? "H" : s90.hg === s90.ag ? "D" : "A") : null,
      homeRating: rh,
      awayRating: ra,
      neutral,
      price,
      market: marketOf(e),
    });
  }
  matches.sort((x, y) => x.date.localeCompare(y.date));

  const played = new Map<string, number>();
  for (const r of live.results) {
    if (r.comp !== "uefa.champions" || r.date >= date) continue;
    played.set(r.home, (played.get(r.home) ?? 0) + 1);
    played.set(r.away, (played.get(r.away) ?? 0) + 1);
  }
  const table = Object.entries(SNAPSHOT.ucl)
    .map(([id, name]) => ({
      team: { id, abbr: name.slice(0, 3).toUpperCase(), name: live.names.get(id) ?? name },
      rating: state.rating.get(id) ?? NaN,
      played: played.get(id) ?? 0,
    }))
    .filter((r) => Number.isFinite(r.rating))
    .sort((x, y) => y.rating - x.rating);

  const y = Number(date.slice(0, 4));
  const season = Number(date.slice(5, 7)) >= 7 ? y : y - 1;
  return {
    date,
    season,
    matches,
    table,
    ratings: {
      cutoff: SNAPSHOT.cutoff,
      liveResults: live.results.filter((r) => r.date < date).length,
      missing: live.missing,
    },
  };
}

// ---------------------------------------------------------------- history

export type UclHistoric = {
  eventId: string;
  date: string;
  homeName: string;
  awayName: string;
  probs: { home: number; draw: number; away: number };
  xg: { home: number; away: number };
  result: "a" | "draw" | "b";
  finalScore: string;
  /** "backtest" rows were priced by a mapping refitted each season on earlier
   *  seasons; "shipped" rows by the frozen model the site runs. */
  source: "backtest" | "shipped";
};

/**
 * Every Champions League match priced as the model would have priced it that
 * morning: the shipped walk-forward rows up to the cut-off, then the live
 * replay — whose observer fires before each match is folded in — after it.
 */
export async function uclHistoryRows(upTo: string, since = "2017-07-01"): Promise<UclHistoric[]> {
  const out: UclHistoric[] = [];
  const outcome = (r: "H" | "D" | "A") =>
    (r === "H" ? "a" : r === "D" ? "draw" : "b") as UclHistoric["result"];
  for (const r of HISTORY.rows) {
    if (r[1] < since || r[1] >= upTo) continue;
    out.push({
      eventId: r[0],
      date: r[1],
      homeName: r[2],
      awayName: r[3],
      probs: { home: r[4], draw: r[5], away: r[6] },
      xg: { home: r[7], away: r[8] },
      result: outcome(r[11]),
      finalScore: r[9] === null ? "" : `${r[9]}-${r[10]}`,
      source: r[1] >= "2026-07-01" ? "shipped" : "backtest",
    });
  }
  const pre = new Map<string, [number, number]>();
  const { live } = await ratingsBefore(upTo, (m, rh, ra) => {
    if (m.comp === "uefa.champions") pre.set(m.id, [rh, ra]);
  });
  for (const r of live.results) {
    const rr = pre.get(r.id);
    if (!rr || r.date < since || r.date >= upTo) continue;
    // Qualifiers were filed under the main code before 2020; a July or August
    // match is a qualifier, which the model does not price.
    const mon = Number(r.date.slice(5, 7));
    if (mon === 7 || mon === 8) continue;
    const p = priceMatch(rr[0], rr[1], r.neutral);
    out.push({
      eventId: r.id,
      date: r.date.slice(0, 10),
      homeName: live.names.get(r.home) ?? r.home,
      awayName: live.names.get(r.away) ?? r.away,
      probs: { home: p.home, draw: p.draw, away: p.away },
      xg: { home: p.xgHome, away: p.xgAway },
      result: outcome(r.r90),
      finalScore: `${r.hg}-${r.ag}`,
      source: "shipped",
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ----------------------------------------------------------------- squads

type ScorerFile = {
  cutoff: string;
  clubs: Record<string, { teamGoals: number; players: Record<string, [string, number]> }>;
};
const SCORERS = scorersFile as unknown as ScorerFile;

/** Share of a team's goals a player with no goal record gets, by position.
 *  Same constants as research/ucl/sim_ucl.py. */
const POS_PRIOR: Record<string, number> = { F: 0.1, M: 0.035, D: 0.012, G: 0 };
const OWN_GOAL_SHARE = 0.028;
const SHRINK = 6;

type RosterPlayer = { id: string; name: string; pos: string; out: boolean };
const rosterCache = new Map<string, { at: number; players: RosterPlayer[] }>();

async function roster(teamId: string): Promise<RosterPlayer[]> {
  const hit = rosterCache.get(teamId);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.players;
  const res = await fetch(`${API}/uefa.champions/teams/${teamId}/roster`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ESPN roster ${teamId}: ${res.status}`);
  const json = (await res.json()) as {
    athletes?: {
      id: string;
      displayName?: string;
      position?: { abbreviation?: string };
      injuries?: { status?: string }[];
    }[];
  };
  const players = (json.athletes ?? []).map((a) => ({
    id: String(a.id),
    name: a.displayName ?? "?",
    pos: a.position?.abbreviation ?? "",
    out: (a.injuries ?? []).some((i) =>
      ["out", "injured"].includes((i.status ?? "").toLowerCase()),
    ),
  }));
  rosterCache.set(teamId, { at: Date.now(), players });
  return players;
}

/**
 * Who scores a club's goals, as shares of them.
 *
 * Recency-weighted goals in every competition over the 400 days before the
 * cut-off (half-life 180 days), shrunk toward a position prior with six
 * weighted team goals — so a striker with a long record keeps his share and a
 * new signing starts near his position's average. The live ESPN roster drops
 * players who have left and zeroes the injured. Shares are per TEAM goal, so a
 * rotation player's already reflects the matches he sits out.
 */
export async function uclSquad(
  teamId: string,
): Promise<{ scorers: Scorer[]; asOf: string; rosterLive: boolean }> {
  const club = SCORERS.clubs[teamId] ?? { teamGoals: 0, players: {} };
  let players: RosterPlayer[] = [];
  let rosterLive = true;
  try {
    players = await roster(teamId);
  } catch (err) {
    console.error(`[ucl] roster ${teamId}:`, err);
    rosterLive = false;
  }
  if (players.length === 0) {
    rosterLive = false;
    players = Object.entries(club.players).map(([id, [name]]) => ({
      id,
      name,
      pos: "",
      out: false,
    }));
  }
  const raw = players.map((p) => {
    const goals = club.players[p.id]?.[1] ?? 0;
    const prior = POS_PRIOR[p.pos.slice(0, 1)] ?? 0.02;
    const share = p.out ? 0 : (goals + SHRINK * prior) / (club.teamGoals + SHRINK);
    return { id: p.id, name: p.name, pos: p.pos, share };
  });
  const total = raw.reduce((s, p) => s + p.share, 0) || 1;
  const scorers = raw
    .map((p) => ({ ...p, share: (p.share / total) * (1 - OWN_GOAL_SHARE) }))
    .filter((p) => p.share > 0)
    .sort((a, b) => b.share - a.share);
  return { scorers, asOf: SCORERS.cutoff, rosterLive };
}

/** The clubs a custom matchup can be built from, with their live ratings. */
export async function uclClubs(date: string) {
  const { state, live } = await ratingsBefore(date);
  return Object.entries(SNAPSHOT.ucl)
    .map(([id, name]) => ({
      id,
      name: live.names.get(id) ?? name,
      rating: state.rating.get(id) ?? null,
    }))
    .filter((c): c is { id: string; name: string; rating: number } => c.rating !== null)
    .sort((a, b) => b.rating - a.rating);
}
