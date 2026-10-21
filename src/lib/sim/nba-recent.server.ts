/**
 * nba-recent.server.ts — a team's recent box scores from ESPN, in the shape
 * nba-extras.ts reads: who played how many minutes, who started, who was out,
 * and the counting stats the season feed doesn't split (offensive rebounds).
 *
 * One schedule call and up to NBA_RECENT_GAMES game summaries per team. A
 * finished game's box score never changes, so summaries are cached for the
 * life of the instance.
 */
import { ESPN_PATH, getJson } from "./espn-stats.server";
import { type NbaBoxGame, type NbaBoxPlayer, type NbaShot, NBA_RECENT_GAMES } from "./nba-extras";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const COACH = /coach|decision/i;

/** Game times are UTC; an evening game belongs to the US calendar day. */
export function nbaUsDay(iso: string): string {
  return new Date(new Date(iso).getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

type Schedule = {
  events?: {
    id: string;
    date: string;
    competitions?: {
      status?: { type?: { completed?: boolean } };
      competitors?: { homeAway: string; team: { id: string; abbreviation: string } }[];
    }[];
  }[];
};

type Play = {
  shootingPlay?: boolean;
  scoringPlay?: boolean;
  pointsAttempted?: number;
  text?: string;
  team?: { id?: string };
  coordinate?: { x?: number; y?: number };
  participants?: { athlete?: { id?: string } }[];
};

type Summary = {
  plays?: Play[];
  boxscore?: {
    players?: {
      team: { id: string };
      statistics?: {
        labels?: string[];
        names?: string[];
        athletes?: {
          athlete?: { id?: string };
          starter?: boolean;
          didNotPlay?: boolean;
          reason?: string;
          stats?: string[];
        }[];
      }[];
    }[];
  };
};

const boxCache = new Map<string, Promise<Summary>>();

function summary(id: string): Promise<Summary> {
  let p = boxCache.get(id);
  if (!p) {
    p = getJson<Summary>(`${SITE}/${ESPN_PATH.nba}/summary?event=${id}`, 20000);
    boxCache.set(id, p);
    p.catch(() => boxCache.delete(id));
  }
  return p;
}

const num = (x: string | undefined) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
};
const madeAtt = (x: string | undefined) => {
  const [a, b] = String(x ?? "").split("-");
  return [num(a), num(b)];
};

function players(d: Summary, teamId: string): NbaBoxPlayer[] {
  const out: NbaBoxPlayer[] = [];
  for (const t of d.boxscore?.players ?? []) {
    if (String(t.team.id) !== teamId) continue;
    for (const g of t.statistics ?? []) {
      const labels = g.labels ?? g.names ?? [];
      for (const a of g.athletes ?? []) {
        const id = a.athlete?.id;
        if (!id) continue;
        const st = a.stats ?? [];
        const s = Object.fromEntries(labels.map((l, i) => [l, st[i]]));
        const dnp = Boolean(a.didNotPlay) || !st.length;
        const [, fga] = madeAtt(s.FG);
        const [, tpa] = madeAtt(s["3PT"]);
        const [, fta] = madeAtt(s.FT);
        out.push({
          id,
          min: dnp ? 0 : num(s.MIN),
          starter: Boolean(a.starter),
          out: dnp && Boolean(a.reason) && !COACH.test(String(a.reason)),
          oreb: num(s.OREB),
          dreb: num(s.DREB),
          fga,
          tpa,
          fta,
          ast: num(s.AST),
          tov: num(s.TO),
          stl: num(s.STL),
          blk: num(s.BLK),
        });
      }
    }
  }
  return out;
}

const FOOT = /(\d+)-foot/;

/** A shot's zone, as research/player-props/fetch_nba_extra.py reads it: the
 *  play text's distance, else the court coordinate (rim at x=25, y=0). */
export function nbaZone(p: Play): NbaShot[1] {
  const three = p.pointsAttempted === 3;
  const x = p.coordinate?.x;
  const y = p.coordinate?.y;
  const onCourt = typeof x === "number" && typeof y === "number" && Math.abs(x) < 100;
  if (three) return onCourt && y! >= 0 && y! <= 9 ? "corner3" : "ab3";
  const m = FOOT.exec(p.text ?? "");
  const dist = m ? Number(m[1]) : onCourt ? Math.hypot(x! - 25, y!) : 0;
  return dist < 4 ? "rim" : dist < 10 ? "paint" : "mid";
}

function shots(d: Summary, teamId: string): { own: NbaShot[]; opp: NbaShot[] } {
  const own: NbaShot[] = [];
  const opp: NbaShot[] = [];
  for (const p of d.plays ?? []) {
    if (!p.shootingPlay || (p.pointsAttempted !== 2 && p.pointsAttempted !== 3)) continue;
    const ids = (p.participants ?? []).map((q) => q.athlete?.id ?? "");
    if (!ids[0]) continue;
    const made = p.scoringPlay ? 1 : 0;
    const ast = made && ids.length > 1 && /assist/i.test(p.text ?? "") ? 1 : 0;
    const shot: NbaShot = [ids[0], nbaZone(p), made, ast];
    (String(p.team?.id ?? "") === teamId ? own : opp).push(shot);
  }
  return { own, opp };
}

/** A team's finished games before `date` (YYYY-MM-DD), oldest first. */
export async function nbaRecentGames(
  teamId: string,
  date: string,
  k = NBA_RECENT_GAMES,
  season?: number,
): Promise<NbaBoxGame[]> {
  const yr = season ? `&season=${season}` : "";
  const [reg, post] = await Promise.all(
    [2, 3].map((t) =>
      getJson<Schedule>(
        `${SITE}/${ESPN_PATH.nba}/teams/${teamId}/schedule?seasontype=${t}${yr}`,
        20000,
      ).catch(() => ({}) as Schedule),
    ),
  );
  const done = [...(reg.events ?? []), ...(post.events ?? [])]
    .filter((e) => e.competitions?.[0]?.status?.type?.completed && nbaUsDay(e.date) < date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-k);
  const games = await Promise.all(
    done.map(async (e): Promise<NbaBoxGame | null> => {
      const d = await summary(e.id).catch(() => null);
      if (!d) return null;
      const home = e.competitions?.[0]?.competitors?.find((c) => c.homeAway === "home");
      const sh = shots(d, teamId);
      return {
        day: nbaUsDay(e.date),
        venue: home?.team.abbreviation ?? "",
        players: players(d, teamId),
        shots: sh.own,
        against: sh.opp,
      };
    }),
  );
  return games.filter((g): g is NbaBoxGame => g !== null);
}
