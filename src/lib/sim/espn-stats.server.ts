/**
 * espn-stats.server.ts — the raw ESPN reads the simulator is built on.
 *
 * Five public endpoints, all read-only, all cached at module scope:
 *
 *   statistics/byathlete   every player's season totals, league-wide, one call
 *   standings              every team's record and points for/against
 *   teams                  names, colours, logos
 *   teams/{id}/roster      who is on the team today, and who is hurt
 *   scoreboard             the day's games, the posted line, probable starters
 *
 * The byathlete feed is the heavy one: 4–8 MB a page, one to three pages per
 * league-season. It is the only way to get a player's numbers from last season
 * when he has since changed teams — the team-scoped feeds file him under the
 * old club — so it is fetched whole, reduced to plain numbers straight away,
 * and cached for hours. Concurrent requests for the same season share one
 * fetch rather than each starting their own.
 */

import { etDateOf } from "../date";
import type { SimLeague } from "./types";

export const ESPN_PATH: Record<SimLeague, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
};

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports";
const STANDINGS = "https://site.api.espn.com/apis/v2/sports";

const HOUR = 60 * 60 * 1000;

// ------------------------------------------------------------ plumbing

/** At most this many ESPN requests in flight from this process. The roster
 *  calls for a full slate would otherwise all fire at once, and ESPN answers a
 *  burst like that by dropping some of it. */
const MAX_INFLIGHT = 6;
let inflight = 0;
const queue: (() => void)[] = [];

function limited<T>(run: () => Promise<T>): Promise<T> {
  const go = () => {
    inflight++;
    return run().finally(() => {
      inflight--;
      queue.shift()?.();
    });
  };
  if (inflight < MAX_INFLIGHT) return go();
  return new Promise<T>((resolve, reject) => queue.push(() => void go().then(resolve, reject)));
}

async function getJson<T>(url: string, ms = 20000): Promise<T> {
  return limited(async () => {
    // ESPN's stats hosts answer the occasional request with a 503 or a reset
    // connection and serve the identical request a second later, so a failure
    // is retried twice, backing off, before it is believed.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt * attempt));
      try {
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(ms),
        });
        if (res.status === 404) throw Object.assign(new Error(`ESPN 404: ${url}`), { final: true });
        if (!res.ok) throw new Error(`ESPN ${res.status}: ${url}`);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        if ((err as { final?: boolean }).final) break;
      }
    }
    throw lastErr;
  });
}

type Entry<T> = { at: number; ttl: number; value: Promise<T> };
const cache = new Map<string, Entry<unknown>>();

/** Memoise a fetch for `ttl` ms. A failed fetch is evicted at once so the
 *  next request retries instead of serving the failure for hours. */
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), ttl, value });
  value.catch(() => cache.delete(key));
  return value;
}

/** "2,146" → 2146, "25:41" → 1541 (seconds), "162.1" innings stay numeric,
 *  "-" → NaN. */
function num(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const s = raw.replace(/,/g, "").trim();
  if (s === "" || s === "-" || s === "--") return NaN;
  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  return Number(s);
}

// ---------------------------------------------------------- seasons

/**
 * The ESPN season year a date sits in. Basketball and hockey use the year the
 * season ENDS (2025-26 is 2026); football and baseball use the year it starts.
 * In each league's dead months this returns the season about to begin, which
 * has no stats yet — the prior-season weighting copes with that.
 */
export function seasonFor(league: SimLeague, date: string): number {
  const [y, m] = date.split("-").map(Number);
  if (league === "nba" || league === "nhl") return m >= 8 ? y + 1 : y;
  return m >= 3 ? y : y - 1;
}

export function seasonLabel(league: SimLeague, season: number): string {
  if (league === "nba" || league === "nhl")
    return `${season - 1}-${String(season % 100).padStart(2, "0")}`;
  return String(season);
}

// ------------------------------------------------------- player stats

/** One player's season totals, keyed "category.statName". */
export type StatLine = {
  id: string;
  name: string;
  teamId: string;
  pos: string;
  s: Record<string, number>;
};

type ByAthleteResponse = {
  pagination?: { pages?: number };
  categories?: { name: string; names: string[] }[];
  athletes?: {
    athlete: {
      id: string;
      displayName?: string;
      teamId?: string;
      position?: { abbreviation?: string };
    };
    categories: { name: string; totals?: string[]; values?: (number | string)[] }[];
  }[];
};

function reducePage(json: ByAthleteResponse, into: Map<string, StatLine>) {
  const names = new Map((json.categories ?? []).map((c) => [c.name, c.names]));
  for (const row of json.athletes ?? []) {
    const a = row.athlete;
    const prev = into.get(a.id);
    const s: Record<string, number> = prev?.s ?? {};
    for (const cat of row.categories) {
      const keys = names.get(cat.name);
      const vals = cat.totals ?? cat.values;
      if (!keys || !vals) continue;
      for (let i = 0; i < keys.length; i++) {
        const v = num(vals[i]);
        if (Number.isFinite(v)) s[`${cat.name}.${keys[i]}`] = v;
      }
    }
    into.set(a.id, {
      id: a.id,
      name: a.displayName ?? prev?.name ?? "?",
      teamId: a.teamId ?? prev?.teamId ?? "",
      pos: a.position?.abbreviation ?? prev?.pos ?? "",
      s,
    });
  }
}

const PAGE = 1000;

async function loadByAthlete(
  league: SimLeague,
  season: number,
  category?: string,
): Promise<Map<string, StatLine>> {
  const base =
    `${WEB}/${ESPN_PATH[league]}/statistics/byathlete?region=us&lang=en&contentorigin=espn` +
    `&isqualified=false&season=${season}&seasontype=2&limit=${PAGE}` +
    (category ? `&category=${category}` : "");
  const out = new Map<string, StatLine>();
  const first = await getJson<ByAthleteResponse>(`${base}&page=1`, 30000);
  reducePage(first, out);
  const pages = first.pagination?.pages ?? 1;
  // One page at a time: each is several megabytes of JSON, and parsing three of
  // them at once is the difference between a comfortable and a cramped
  // serverless instance. The time cost is paid once per cache period.
  for (let p = 2; p <= Math.min(pages, 6); p++) {
    reducePage(await getJson<ByAthleteResponse>(`${base}&page=${p}`, 30000), out);
  }
  return out;
}

/**
 * Season totals for every player in the league. Baseball is two lists —
 * ESPN's feed only returns the players who have stats in the category asked
 * for — so batters and pitchers are fetched separately and merged by id (a
 * two-way player ends up with both halves).
 */
export function playerStats(
  league: SimLeague,
  season: number,
  current: boolean,
): Promise<Map<string, StatLine>> {
  const ttl = current ? 3 * HOUR : 24 * HOUR;
  return cached(`stats:${league}:${season}`, ttl, async () => {
    if (league !== "mlb") return loadByAthlete(league, season);
    const [bat, pit] = await Promise.all([
      loadByAthlete(league, season, "batting"),
      loadByAthlete(league, season, "pitching"),
    ]);
    for (const [id, line] of pit) {
      const b = bat.get(id);
      if (!b) bat.set(id, line);
      else for (const [k, v] of Object.entries(line.s)) if (k.startsWith("pitching.")) b.s[k] = v;
    }
    return bat;
  });
}

// ---------------------------------------------------------- standings

export type StandingRow = {
  teamId: string;
  gp: number;
  pf: number;
  pa: number;
  record: string;
};

type StandingsNode = {
  standings?: {
    entries: {
      team: { id: string };
      stats: { name: string; value?: number; displayValue?: string }[];
    }[];
  };
  children?: StandingsNode[];
};

export function standings(
  league: SimLeague,
  season: number,
  current: boolean,
): Promise<Map<string, StandingRow>> {
  return cached(`standings:${league}:${season}`, current ? HOUR : 24 * HOUR, async () => {
    const json = await getJson<StandingsNode>(
      `${STANDINGS}/${ESPN_PATH[league]}/standings?season=${season}&seasontype=2`,
    );
    const out = new Map<string, StandingRow>();
    const walk = (n: StandingsNode) => {
      for (const e of n.standings?.entries ?? []) {
        const st = new Map(e.stats.map((s) => [s.name, s]));
        const v = (k: string) => st.get(k)?.value ?? 0;
        const w = v("wins");
        const l = v("losses");
        const t = v("ties");
        const otl = league === "nhl" ? v("otLosses") : 0;
        const gp = v("gamesPlayed") || w + l + t + otl;
        const overall = st.get("overall")?.displayValue?.split(",")[0];
        const record =
          overall ?? (league === "nhl" ? `${w}-${l}-${otl}` : t ? `${w}-${l}-${t}` : `${w}-${l}`);
        out.set(e.team.id, {
          teamId: e.team.id,
          gp,
          pf: v("pointsFor"),
          pa: v("pointsAgainst"),
          record,
        });
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(json);
    return out;
  });
}

// --------------------------------------------------------------- teams

export type TeamMeta = {
  id: string;
  abbr: string;
  name: string;
  location: string;
  displayName: string;
  color: string;
  altColor: string;
  logo: string;
};

export function teams(league: SimLeague): Promise<TeamMeta[]> {
  return cached(`teams:${league}`, 24 * HOUR, async () => {
    type R = {
      sports?: {
        leagues?: {
          teams?: {
            team: {
              id: string;
              abbreviation?: string;
              shortDisplayName?: string;
              displayName?: string;
              location?: string;
              name?: string;
              color?: string;
              alternateColor?: string;
              logos?: { href: string }[];
              isActive?: boolean;
            };
          }[];
        }[];
      }[];
    };
    const json = await getJson<R>(`${SITE}/${ESPN_PATH[league]}/teams?limit=100`);
    return (json.sports?.[0]?.leagues?.[0]?.teams ?? [])
      .map(({ team: t }) => ({
        id: t.id,
        abbr: t.abbreviation ?? "?",
        name: t.shortDisplayName ?? t.name ?? "?",
        location: t.location ?? "",
        displayName: t.displayName ?? t.shortDisplayName ?? "?",
        color: t.color ? `#${t.color}` : "#64748b",
        altColor: t.alternateColor ? `#${t.alternateColor}` : "#94a3b8",
        logo: t.logos?.[0]?.href ?? "",
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  });
}

// -------------------------------------------------------------- rosters

export type RosterEntry = {
  id: string;
  name: string;
  short: string;
  pos: string;
  jersey: string;
  /** The injury report's status word ("Out", "Questionable", "15-Day-IL"). */
  injury: string | null;
  /** NFL roster group: offense, defense, specialTeam, injuredReserveOrOut… */
  group: string | null;
};

type RosterAthlete = {
  id: string;
  displayName?: string;
  shortName?: string;
  jersey?: string;
  position?: { abbreviation?: string };
  injuries?: { status?: string }[];
};

export function roster(league: SimLeague, teamId: string): Promise<RosterEntry[]> {
  return cached(`roster:${league}:${teamId}`, 3 * HOUR, async () => {
    type R = { athletes?: (RosterAthlete | { position?: string; items: RosterAthlete[] })[] };
    const json = await getJson<R>(`${SITE}/${ESPN_PATH[league]}/teams/${teamId}/roster`);
    const out: RosterEntry[] = [];
    const push = (a: RosterAthlete, group: string | null) =>
      out.push({
        id: a.id,
        name: a.displayName ?? "?",
        short: a.shortName ?? a.displayName ?? "?",
        pos: a.position?.abbreviation ?? "",
        jersey: a.jersey ?? "",
        injury: a.injuries?.[0]?.status ?? null,
        group,
      });
    for (const item of json.athletes ?? []) {
      if ("items" in item) for (const a of item.items) push(a, item.position ?? null);
      else push(item, null);
    }
    return out;
  });
}

// ------------------------------------------------------------ scoreboard

export type ScoreboardGame = {
  id: string;
  date: string;
  state: "pre" | "in" | "post";
  status: string;
  venue: string;
  neutral: boolean;
  playoff: boolean;
  homeId: string;
  awayId: string;
  homeScore: number | null;
  awayScore: number | null;
  line: {
    provider: string;
    spread: number | null;
    total: number | null;
    homeMl: number | null;
    awayMl: number | null;
  } | null;
  /** Probable starting pitcher / goalie by side, as ESPN athlete ids. */
  probable: { home?: string; away?: string };
  probableName: { home?: string; away?: string };
};

type ScoreboardResponse = {
  events?: {
    id: string;
    date: string;
    season?: { type?: number };
    status: { type: { state: string; shortDetail?: string; completed?: boolean } };
    competitions: {
      neutralSite?: boolean;
      venue?: { fullName?: string };
      competitors: {
        homeAway: "home" | "away";
        score?: string;
        team: { id: string };
        probables?: { athlete: { id: string; displayName?: string } }[];
      }[];
      odds?: {
        provider?: { name?: string };
        spread?: number;
        overUnder?: number;
        moneyline?: {
          home?: { close?: { odds?: string }; open?: { odds?: string } };
          away?: { close?: { odds?: string }; open?: { odds?: string } };
        };
      }[];
    }[];
  }[];
};

const ml = (s: string | undefined) => {
  const v = num(s);
  return Number.isFinite(v) && v !== 0 ? v : null;
};

/**
 * The first day within the next two weeks that has a game, from one ranged
 * scoreboard call — so an empty date can point at the next one instead of
 * leaving the reader to guess.
 */
export function nextGameDay(league: SimLeague, from: string): Promise<string | null> {
  const ymd = (d: string) => d.replace(/-/g, "");
  const [y, m, d] = from.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 14)).toISOString().slice(0, 10);
  return cached(`next:${league}:${ymd(from)}`, 60 * 60 * 1000, async () => {
    const json = await getJson<ScoreboardResponse>(
      `${SITE}/${ESPN_PATH[league]}/scoreboard?dates=${ymd(from)}-${ymd(end)}&limit=300`,
    );
    const days = (json.events ?? [])
      .filter((e) => e.status.type.state !== "post")
      .map((e) => etDateOf(e.date))
      .filter((day) => day >= from)
      .sort();
    return days[0] ?? null;
  });
}

export function scoreboard(league: SimLeague, date: string): Promise<ScoreboardGame[]> {
  const ymd = date.replace(/-/g, "");
  return cached(`scoreboard:${league}:${ymd}`, 10 * 60 * 1000, async () => {
    const json = await getJson<ScoreboardResponse>(
      `${SITE}/${ESPN_PATH[league]}/scoreboard?dates=${ymd}&limit=500`,
    );
    const out: ScoreboardGame[] = [];
    for (const ev of json.events ?? []) {
      const c = ev.competitions[0];
      const home = c?.competitors.find((x) => x.homeAway === "home");
      const away = c?.competitors.find((x) => x.homeAway === "away");
      if (!c || !home || !away) continue;
      const st = ev.status.type;
      const state: ScoreboardGame["state"] =
        st.state === "post" || st.completed ? "post" : st.state === "in" ? "in" : "pre";
      const score = (v?: string) => (state !== "pre" && v != null && v !== "" ? Number(v) : null);
      const o = c.odds?.[0];
      out.push({
        id: ev.id,
        date: ev.date,
        state,
        status: st.shortDetail ?? "",
        venue: c.venue?.fullName ?? "",
        neutral: c.neutralSite === true,
        playoff: ev.season?.type === 3,
        homeId: home.team.id,
        awayId: away.team.id,
        homeScore: score(home.score),
        awayScore: score(away.score),
        line: o
          ? {
              provider: o.provider?.name ?? "Consensus",
              spread: typeof o.spread === "number" ? o.spread : null,
              total: typeof o.overUnder === "number" ? o.overUnder : null,
              homeMl: ml(o.moneyline?.home?.close?.odds ?? o.moneyline?.home?.open?.odds),
              awayMl: ml(o.moneyline?.away?.close?.odds ?? o.moneyline?.away?.open?.odds),
            }
          : null,
        probable: {
          home: home.probables?.[0]?.athlete.id,
          away: away.probables?.[0]?.athlete.id,
        },
        probableName: {
          home: home.probables?.[0]?.athlete.displayName,
          away: away.probables?.[0]?.athlete.displayName,
        },
      });
    }
    return out;
  });
}
