/**
 * nfl-espn.server.ts — the one ESPN box-score layer the NFL models share.
 *
 * Both the touchdown board and the prop board need the same things: a team's
 * recent games, the box scores in them, who is on the roster, who is hurt, and
 * what the market made of the game. They used to need them separately, which
 * meant two caches, two request budgets, and the same 285 KB box score fetched
 * twice on a Sunday. One module, one cache, one budget.
 *
 * Everything here is public ESPN and read-only; nothing touches Supabase.
 *
 *   teams/{id}/schedule  → the games a team has completed
 *   summary?event=…      → box score, pre-game total and spread, injury report
 *   teams/{id}/roster    → who is actually on the team right now
 */
import { etDateOf } from "./date";

const NFL = "football/nfl";
const SITE = `https://site.api.espn.com/apis/site/v2/sports/${NFL}`;
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

type Cached<T> = { at: number; v: T };
const summaryCache = new Map<number, Cached<GameBox | null>>();
const scheduleCache = new Map<string, Cached<TeamGame[]>>();
const rosterCache = new Map<string, Cached<Set<string> | null>>();
const contextCache = new Map<number, Cached<GameContext>>();
const SUMMARY_TTL = 24 * 60 * 60 * 1000; // finals are immutable
const SCHEDULE_TTL = 6 * 60 * 60 * 1000;
const ROSTER_TTL = 12 * 60 * 60 * 1000;
const CONTEXT_TTL = 15 * 60 * 1000; // lines move and injury reports update

// A full Sunday slate asks for a box score per team per completed game — a few
// hundred requests. Fired all at once ESPN throttles them and the board comes
// back half-empty, which is indistinguishable from "the model has no picks".
// Bound the in-flight requests instead; the whole slate still resolves in a
// couple of seconds and every request actually lands.
const MAX_INFLIGHT = 8;
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

// ----------------------------------------------------------------- box score

/** One player's line in one game. Rushing, receiving and passing, because the
 *  prop board prices all three and the touchdown board prices the first two. */
export type BoxPlayer = {
  id: string;
  name: string;
  car: number;
  ry: number;
  rtd: number;
  tgt: number;
  rec: number;
  cy: number;
  ctd: number;
  patt: number;
  cmp: number;
  py: number;
  ptd: number;
  intc: number;
};

export type BoxTeam = {
  abbr: string;
  isHome: boolean;
  players: BoxPlayer[];
  /** Team offensive totals, used for usage shares and pace. */
  car: number;
  ry: number;
  tgt: number;
  rec: number;
  cy: number;
  patt: number;
  py: number;
  rushTd: number;
  recTd: number;
};

export type GameBox = { date: string; teams: BoxTeam[] };

/** Only the corners of ESPN's summary payload this module reads. */
type EspnAthleteLine = { athlete?: { id?: string; displayName?: string }; stats?: string[] };
type EspnStatCategory = { name?: string; keys?: string[]; athletes?: EspnAthleteLine[] };
type EspnTeamBox = { team?: { abbreviation?: string }; statistics?: EspnStatCategory[] };
type EspnSummary = {
  header?: {
    competitions?: {
      date?: string;
      competitors?: { homeAway?: string; team?: { abbreviation?: string } }[];
    }[];
  };
  boxscore?: { players?: EspnTeamBox[] };
};

const num = (v: unknown) => {
  const n = Number(String(v ?? "").split("/")[0]);
  return Number.isFinite(n) ? n : 0;
};

function emptyPlayer(id: string, name: string): BoxPlayer {
  return {
    id,
    name,
    car: 0,
    ry: 0,
    rtd: 0,
    tgt: 0,
    rec: 0,
    cy: 0,
    ctd: 0,
    patt: 0,
    cmp: 0,
    py: 0,
    ptd: 0,
    intc: 0,
  };
}

function parseSummary(raw: unknown): GameBox | null {
  const d = raw as EspnSummary;
  const comp = d?.header?.competitions?.[0];
  const box = d?.boxscore?.players;
  if (!comp || !Array.isArray(box)) return null;
  const homeAbbr = comp.competitors?.find((c) => c.homeAway === "home")?.team?.abbreviation;
  const teams: BoxTeam[] = [];
  for (const tb of box) {
    const abbr = tb?.team?.abbreviation;
    if (!abbr) continue;
    const byId = new Map<string, BoxPlayer>();
    for (const cat of tb.statistics ?? []) {
      const keys = cat.keys ?? [];
      if (!["rushing", "receiving", "passing"].includes(cat.name ?? "")) continue;
      for (const a of cat.athletes ?? []) {
        const id = a?.athlete?.id;
        if (!id) continue;
        const p = byId.get(id) ?? emptyPlayer(id, a.athlete?.displayName ?? "");
        const s = Object.fromEntries(keys.map((k, i) => [k, a.stats?.[i]]));
        if (cat.name === "rushing") {
          p.car = num(s.rushingAttempts);
          p.ry = num(s.rushingYards);
          p.rtd = num(s.rushingTouchdowns);
        } else if (cat.name === "receiving") {
          p.tgt = num(s.receivingTargets);
          p.rec = num(s.receptions);
          p.cy = num(s.receivingYards);
          p.ctd = num(s.receivingTouchdowns);
        } else {
          const ca = String(s["completions/passingAttempts"] ?? "0/0").split("/");
          p.cmp = num(ca[0]);
          p.patt = num(ca[1]);
          p.py = num(s.passingYards);
          p.ptd = num(s.passingTouchdowns);
          p.intc = num(s.interceptions);
        }
        byId.set(id, p);
      }
    }
    const players = [...byId.values()];
    const sum = (f: (p: BoxPlayer) => number) => players.reduce((s, p) => s + f(p), 0);
    teams.push({
      abbr,
      isHome: abbr === homeAbbr,
      players,
      car: sum((p) => p.car),
      ry: sum((p) => p.ry),
      tgt: sum((p) => p.tgt),
      rec: sum((p) => p.rec),
      cy: sum((p) => p.cy),
      patt: sum((p) => p.patt),
      py: sum((p) => p.py),
      rushTd: sum((p) => p.rtd),
      recTd: sum((p) => p.ctd),
    });
  }
  // The league day, not the UTC day: a Sunday-night game is stamped 00:20Z
  // Monday, and filing it under Monday hides it from Monday night's features.
  return { date: etDateOf(String(comp.date ?? "")), teams };
}

export async function fetchSummary(eventId: number): Promise<GameBox | null> {
  const c = summaryCache.get(eventId);
  if (c && Date.now() - c.at < SUMMARY_TTL) return c.v;
  let v: GameBox | null = null;
  try {
    v = parseSummary(await getJson(`${SITE}/summary?event=${eventId}`));
  } catch (err) {
    console.error(`[nfl-espn summary] ${eventId}:`, err);
  }
  summaryCache.set(eventId, { at: Date.now(), v });
  return v;
}

// ------------------------------------------------------------------ schedule

/** One completed regular-season game, on the league day it was played. */
export type TeamGame = { id: number; date: string };

/** A team's completed regular-season games in `season`, oldest first. Carrying
 *  the date here means the window can be trimmed before any box score is
 *  fetched, instead of pulling all 17 and throwing most away. */
export async function fetchTeamGameLog(teamId: string, season: number): Promise<TeamGame[]> {
  const key = `${teamId}:${season}`;
  const c = scheduleCache.get(key);
  if (c && Date.now() - c.at < SCHEDULE_TTL) return c.v;
  let games: TeamGame[] = [];
  try {
    const d = (await getJson(`${SITE}/teams/${teamId}/schedule?season=${season}&seasontype=2`)) as {
      events?: {
        id?: string;
        date?: string;
        competitions?: { status?: { type?: { completed?: boolean } } }[];
      }[];
    };
    games = (d.events ?? [])
      .filter((e) => e?.competitions?.[0]?.status?.type?.completed)
      .map((e) => ({ id: Number(e.id), date: etDateOf(String(e?.date ?? "")) }))
      .filter((g) => Number.isFinite(g.id))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.error(`[nfl-espn schedule] ${teamId} ${season}:`, err);
  }
  scheduleCache.set(key, { at: Date.now(), v: games });
  return games;
}

/**
 * A team's last `count` completed games before `date`, oldest last, crossing
 * back into previous seasons when this one is too young to fill the window.
 *
 * The crossing is the point. "Season to date" is empty in Week 1 — the hole
 * that left the touchdown board blank on opening night — while "this team's
 * last eight games" is always defined. `carried` says how many came from an
 * earlier season so the caller can be honest about it.
 */
export async function trailingTeamGames(
  teamId: string,
  season: number,
  beforeDate: string,
  count: number,
): Promise<{ games: TeamGame[]; carried: number }> {
  const current = (await fetchTeamGameLog(teamId, season)).filter((g) => g.date < beforeDate);
  if (current.length >= count) {
    return { games: current.slice(-count), carried: 0 };
  }
  let games = current;
  let carried = 0;
  for (let back = 1; back <= 2 && games.length < count; back++) {
    const prior = await fetchTeamGameLog(teamId, season - back);
    const need = count - games.length;
    const tail = prior.slice(-need);
    carried += tail.length;
    games = [...tail, ...games];
    if (tail.length < need) break; // nothing older to find
  }
  return { games, carried };
}

// -------------------------------------------------------------------- roster

/** Athlete ids on a team's active roster right now — offense, defense and
 *  special teams only, so injured-reserve, suspended and practice-squad players
 *  are left out. Returns null when ESPN doesn't answer, which means "don't
 *  filter" rather than "nobody is available". */
export async function fetchActiveRoster(teamId: string): Promise<Set<string> | null> {
  const c = rosterCache.get(teamId);
  if (c && Date.now() - c.at < ROSTER_TTL) return c.v;
  let ids: Set<string> | null = null;
  try {
    const d = (await getJson(`${SITE}/teams/${teamId}/roster`)) as {
      athletes?: { position?: string; items?: { id?: string }[] }[];
    };
    const ACTIVE = new Set(["offense", "defense", "specialTeam"]);
    const found = new Set<string>();
    for (const group of d.athletes ?? []) {
      if (!ACTIVE.has(String(group?.position))) continue;
      for (const a of group.items ?? []) if (a?.id) found.add(String(a.id));
    }
    if (found.size > 0) ids = found;
  } catch (err) {
    console.error(`[nfl-espn roster] ${teamId}:`, err);
  }
  rosterCache.set(teamId, { at: Date.now(), v: ids });
  return ids;
}

// ------------------------------------------------------- game-day context
//
// The game summary carries the pre-game line AND that week's injury report, so
// one fetch answers both. They are cached together on a short TTL because both
// move: a line drifts, and a Friday "questionable" becomes a Sunday "out".

/** What a player's listed status means for a projection. */
export type Availability = "out" | "questionable" | "active";

export type PlayerStatus = {
  id: string;
  name: string;
  /** ESPN's own words — "Out", "Injured Reserve", "Questionable". */
  label: string;
  availability: Availability;
};

export type GameContext = {
  /** Pre-game total and home spread, or null when no line is posted. */
  odds: { total: number; homeSpread: number } | null;
  /** Athlete id → listed status, for both teams. */
  status: Map<string, PlayerStatus>;
};

/**
 * Which listed statuses mean a player will not be on the field.
 *
 * "Doubtful" is here on purpose. It is a listed probability of playing of
 * roughly a quarter, and a prop on a player who is three-to-one against taking
 * a snap is not a pick worth printing next to one that is 70% to hit.
 */
function availabilityOf(label: string): Availability {
  const s = label.toLowerCase();
  if (/out|doubtful|injured reserve|\bir\b|suspend|pup|non.?football|inactive/.test(s)) {
    return "out";
  }
  if (/questionable|probable|limited|day.?to.?day/.test(s)) return "questionable";
  return "active";
}

/** In-play books quote a different game — a 24-7 fourth quarter reads -910
 *  live against +180 pre-game — and only the pre-game number describes the
 *  matchup a projection is about. */
function isLiveBook(name: string | undefined): boolean {
  return /\blive\b|\bin[- ]?play\b/i.test(name ?? "");
}

/** Pre-game total and home spread from the core odds feed.
 *
 *  The summary's `pickcenter` is the first choice, but its coverage is patchy
 *  once a game is no longer current — whole seasons of it are missing — and a
 *  board that silently falls back to a default total is quietly pricing a
 *  different game. The core feed still has them. */
async function coreOdds(eventId: number): Promise<{ total: number; homeSpread: number } | null> {
  try {
    const d = (await getJson(`${CORE}/events/${eventId}/competitions/${eventId}/odds`)) as {
      items?: { provider?: { name?: string }; overUnder?: number; spread?: number }[];
    };
    for (const it of d.items ?? []) {
      if (isLiveBook(it.provider?.name)) continue;
      if (typeof it.overUnder === "number" && typeof it.spread === "number") {
        return { total: it.overUnder, homeSpread: it.spread };
      }
    }
  } catch (err) {
    console.error(`[nfl-espn core odds] ${eventId}:`, err);
  }
  return null;
}

export async function fetchGameContext(eventId: number): Promise<GameContext> {
  const c = contextCache.get(eventId);
  if (c && Date.now() - c.at < CONTEXT_TTL) return c.v;
  const v: GameContext = { odds: null, status: new Map() };
  try {
    const d = (await getJson(`${SITE}/summary?event=${eventId}`)) as {
      pickcenter?: { overUnder?: number; spread?: number }[];
      injuries?: {
        injuries?: { status?: string; athlete?: { id?: string; displayName?: string } }[];
      }[];
    };
    // pickcenter carries the pre-game number for both upcoming and finished
    // games; the core odds feed empties out once a game is old.
    for (const it of d.pickcenter ?? []) {
      if (typeof it.overUnder === "number" && typeof it.spread === "number") {
        v.odds = { total: it.overUnder, homeSpread: it.spread };
        break;
      }
    }
    for (const team of d.injuries ?? []) {
      for (const i of team.injuries ?? []) {
        const id = i.athlete?.id;
        if (!id) continue;
        const label = i.status ?? "";
        v.status.set(String(id), {
          id: String(id),
          name: i.athlete?.displayName ?? "",
          label,
          availability: availabilityOf(label),
        });
      }
    }
  } catch (err) {
    console.error(`[nfl-espn context] ${eventId}:`, err);
  }
  if (!v.odds) v.odds = await coreOdds(eventId);
  contextCache.set(eventId, { at: Date.now(), v });
  return v;
}
