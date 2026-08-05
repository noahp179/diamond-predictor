/**
 * mlb-props.server.ts — live MLB player-prop projections for a slate.
 *
 * Eleven binary markets (batters: 1+ hits, 2+ hits, 2+ total bases, 1+ HR,
 * 1+ RBI, 1+ run, 1+ SB; starters: 5+/6+/7+ strikeouts, 16+ outs). Each is its
 * own logistic model over season-to-date, trailing-30-day and prior-season
 * rates plus the matchup (opposing starter, park, team context), trained in
 * research/mlb-props and frozen in mlb-props-model.json.
 *
 * Everything is rebuilt live from MLB StatsAPI the same way the trainer built
 * it, so the numbers the app computes are the numbers that were backtested:
 *
 *   schedule?hydrate=probablePitcher,lineups  → slate, starters, batting order
 *   people?hydrate=stats(gameLog)             → game-by-game logs (batched)
 *   stats?stats=season&season=Y-1             → prior-season rates
 *   teams/stats?stats=season                  → team offense / runs allowed
 *
 * Game logs are the same rows the model trained on, so season-to-date and
 * 30-day windows are computed here exactly as they were in features.py — and
 * they only ever contain games that already finished, so nothing leaks.
 */
import model from "./mlb-props-model.json";
import { PARK_FACTORS } from "./park-factors";

const API = "https://statsapi.mlb.com/api/v1";
const C = model.constants;

// League priors for shrinkage — must match research/mlb-props/features.py.
const LG = {
  h_pa: 0.216,
  tb_pa: 0.35,
  hr_pa: 0.032,
  rbi_pa: 0.104,
  r_pa: 0.108,
  bb_pa: 0.085,
  k_pa: 0.223,
  sb_pa: 0.013,
  p_k_bf: 0.223,
  p_h_bf: 0.216,
  p_bb_bf: 0.085,
  p_hr_bf: 0.032,
};
const BATTER_PRIORS: Record<string, number> = {
  h1: 0.62,
  h2: 0.23,
  tb2: 0.36,
  hr1: 0.12,
  rbi1: 0.33,
  r1: 0.35,
  sb1: 0.05,
};
const PITCHER_PRIORS: Record<string, number> = {
  k5: 0.5,
  k6: 0.35,
  k7: 0.22,
  outs16: 0.45,
};

const shrunk = (num: number, den: number, prior: number, k: number) =>
  (num + k * prior) / (den + k);
const parkOf = (venue: string) => (PARK_FACTORS[venue] ?? 100) / 100;

// ------------------------------------------------------------------ fetching
type Cached<T> = { at: number; v: T };
const cache = new Map<string, Cached<unknown>>();

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
}

async function getJson(url: string, ms = 20000): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`StatsAPI ${res.status}: ${url}`);
  return res.json();
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const outsOf = (ip: unknown) => {
  const [w, f] = String(ip ?? "0").split(".");
  return n(w) * 3 + n(f);
};
const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

// ------------------------------------------------------------------- slate
type SlateTeam = { id: number; abbr: string; name: string };
type SlateGame = {
  gamePk: number;
  date: string;
  venue: string;
  startsAt: string;
  home: SlateTeam;
  away: SlateTeam;
  homeSp: { id: number; name: string } | null;
  awaySp: { id: number; name: string } | null;
  lineups: { home: number[]; away: number[] }; // player ids in batting order
};

function teamOf(t: any): SlateTeam {
  return { id: n(t?.id), abbr: t?.abbreviation ?? t?.teamName ?? "", name: t?.name ?? "" };
}

async function fetchSlate(date: string): Promise<SlateGame[]> {
  return cached(`slate:${date}`, 5 * 60_000, async () => {
    const d = await getJson(
      `${API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher,lineups,venue,team`,
    );
    const out: SlateGame[] = [];
    for (const day of d?.dates ?? []) {
      for (const g of day?.games ?? []) {
        const sp = (side: "home" | "away") => {
          const p = g?.teams?.[side]?.probablePitcher;
          return p?.id ? { id: n(p.id), name: p.fullName ?? "" } : null;
        };
        out.push({
          gamePk: n(g.gamePk),
          date: String(g.gameDate ?? "").slice(0, 10),
          startsAt: String(g.gameDate ?? ""),
          venue: g?.venue?.name ?? "",
          home: teamOf(g?.teams?.home?.team),
          away: teamOf(g?.teams?.away?.team),
          homeSp: sp("home"),
          awaySp: sp("away"),
          lineups: {
            home: (g?.lineups?.homePlayers ?? []).map((p: any) => n(p.id)),
            away: (g?.lineups?.awayPlayers ?? []).map((p: any) => n(p.id)),
          },
        });
      }
    }
    return out;
  });
}

/** Batting order from a team's most recent completed game — the fallback for
 *  slates whose lineup cards are not posted yet (they land ~2h before first
 *  pitch). Returns player ids in slot order. */
async function fetchRecentOrder(teamId: number, date: string): Promise<number[]> {
  return cached(`order:${teamId}:${date}`, 60 * 60_000, async () => {
    const start = new Date(`${date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    const from = start.toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    try {
      const sched = await getJson(
        `${API}/schedule?sportId=1&teamId=${teamId}&startDate=${from}&endDate=${to}&gameType=R`,
      );
      const games = (sched?.dates ?? [])
        .flatMap((d: any) => d?.games ?? [])
        .filter((g: any) => ["F", "O"].includes(g?.status?.codedGameState))
        .sort((a: any, b: any) => String(a.gameDate).localeCompare(String(b.gameDate)));
      const last = games[games.length - 1];
      if (!last) return [];
      const box = await getJson(`${API}/game/${last.gamePk}/boxscore`);
      for (const side of ["home", "away"] as const) {
        const t = box?.teams?.[side];
        if (n(t?.team?.id) !== teamId) continue;
        const starters: { id: number; slot: number }[] = [];
        for (const p of Object.values<any>(t?.players ?? {})) {
          const order = n(p?.battingOrder);
          if (order && order % 100 === 0)
            starters.push({ id: n(p?.person?.id), slot: order / 100 });
        }
        return starters.sort((a, b) => a.slot - b.slot).map((s) => s.id);
      }
    } catch (err) {
      console.error(`[mlb-props order] team ${teamId}:`, err);
    }
    return [];
  });
}

// ---------------------------------------------------------------- game logs
type BatLog = {
  date: string;
  pa: number;
  ab: number;
  h: number;
  tb: number;
  hr: number;
  rbi: number;
  r: number;
  sb: number;
  bb: number;
  k: number;
};
type PitLog = {
  date: string;
  bf: number;
  k: number;
  outs: number;
  h: number;
  bb: number;
  hr: number;
  gs: number;
};

const BAT_FIELDS =
  "people,id,fullName,stats,splits,date,stat,hits,totalBases,homeRuns,rbi,runs," +
  "stolenBases,plateAppearances,atBats,baseOnBalls,strikeOuts";
const PIT_FIELDS =
  "people,id,fullName,stats,splits,date,stat,gamesStarted,battersFaced,strikeOuts," +
  "hits,baseOnBalls,homeRuns,inningsPitched";

const CHUNK = 40;

async function fetchLogs<T>(
  ids: number[],
  season: number,
  group: "hitting" | "pitching",
  date: string,
  parse: (split: any) => T,
): Promise<Map<number, { name: string; logs: T[] }>> {
  const out = new Map<number, { name: string; logs: T[] }>();
  const uniq = [...new Set(ids)].filter(Boolean);
  const fields = group === "hitting" ? BAT_FIELDS : PIT_FIELDS;
  const chunks: number[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));

  await Promise.all(
    chunks.map(async (chunk) => {
      const key = `logs:${group}:${season}:${date}:${chunk[0]}:${chunk.length}`;
      try {
        const d = await cached(key, 30 * 60_000, () =>
          getJson(
            `${API}/people?personIds=${chunk.join(",")}` +
              `&hydrate=stats(group=[${group}],type=[gameLog],season=${season},gameType=R)` +
              `&fields=${fields}`,
            30000,
          ),
        );
        for (const p of d?.people ?? []) {
          const splits = (p?.stats ?? []).flatMap((s: any) => s?.splits ?? []);
          out.set(n(p.id), { name: p.fullName ?? "", logs: splits.map(parse) });
        }
      } catch (err) {
        console.error(`[mlb-props logs ${group}]`, err);
      }
    }),
  );
  return out;
}

const parseBat = (s: any): BatLog => ({
  date: String(s?.date ?? ""),
  pa: n(s?.stat?.plateAppearances),
  ab: n(s?.stat?.atBats),
  h: n(s?.stat?.hits),
  tb: n(s?.stat?.totalBases),
  hr: n(s?.stat?.homeRuns),
  rbi: n(s?.stat?.rbi),
  r: n(s?.stat?.runs),
  sb: n(s?.stat?.stolenBases),
  bb: n(s?.stat?.baseOnBalls),
  k: n(s?.stat?.strikeOuts),
});
const parsePit = (s: any): PitLog => ({
  date: String(s?.date ?? ""),
  bf: n(s?.stat?.battersFaced),
  k: n(s?.stat?.strikeOuts),
  outs: outsOf(s?.stat?.inningsPitched),
  h: n(s?.stat?.hits),
  bb: n(s?.stat?.baseOnBalls),
  hr: n(s?.stat?.homeRuns),
  gs: n(s?.stat?.gamesStarted),
});

// ------------------------------------------------------- prior season + teams
type PriorBat = { pa: number; h: number; tb: number; hr: number };
type PriorPit = { bf: number; k: number; gs: number };

async function fetchPriorSeason(season: number) {
  return cached(`prior:${season}`, 24 * 60 * 60_000, async () => {
    const bat = new Map<number, PriorBat>();
    const pit = new Map<number, PriorPit>();
    const q = (group: string) =>
      `${API}/stats?stats=season&group=${group}&season=${season}&sportId=1&gameType=R&limit=3000&playerPool=All`;
    try {
      const [h, p] = await Promise.all([getJson(q("hitting")), getJson(q("pitching"))]);
      for (const s of h?.stats?.[0]?.splits ?? []) {
        bat.set(n(s?.player?.id), {
          pa: n(s?.stat?.plateAppearances),
          h: n(s?.stat?.hits),
          tb: n(s?.stat?.totalBases),
          hr: n(s?.stat?.homeRuns),
        });
      }
      for (const s of p?.stats?.[0]?.splits ?? []) {
        pit.set(n(s?.player?.id), {
          bf: n(s?.stat?.battersFaced),
          k: n(s?.stat?.strikeOuts),
          gs: n(s?.stat?.gamesStarted),
        });
      }
    } catch (err) {
      console.error("[mlb-props prior season]", err);
    }
    return { bat, pit };
  });
}

type TeamCtx = { g: number; runs: number; runsAllowed: number; pa: number; k: number; h: number };

async function fetchTeamContext(season: number, date: string) {
  return cached(`teams:${season}:${date}`, 60 * 60_000, async () => {
    const m = new Map<number, TeamCtx>();
    const get = (id: number) =>
      m.get(id) ?? (m.set(id, { g: 0, runs: 0, runsAllowed: 0, pa: 0, k: 0, h: 0 }), m.get(id)!);
    try {
      const [h, p] = await Promise.all([
        getJson(
          `${API}/teams/stats?stats=season&group=hitting&season=${season}&sportId=1&gameType=R`,
        ),
        getJson(
          `${API}/teams/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`,
        ),
      ]);
      for (const s of h?.stats?.[0]?.splits ?? []) {
        const t = get(n(s?.team?.id));
        t.g = n(s?.stat?.gamesPlayed);
        t.runs = n(s?.stat?.runs);
        t.pa = n(s?.stat?.plateAppearances);
        t.k = n(s?.stat?.strikeOuts);
        t.h = n(s?.stat?.hits);
      }
      for (const s of p?.stats?.[0]?.splits ?? []) {
        const t = get(n(s?.team?.id));
        t.runsAllowed = n(s?.stat?.runs);
        if (!t.g) t.g = n(s?.stat?.gamesPlayed);
      }
    } catch (err) {
      console.error("[mlb-props team stats]", err);
    }
    return m;
  });
}

// ------------------------------------------------------------------ features
type Totals = Record<string, number>;

function sumLogs<T extends { date: string }>(
  logs: T[],
  before: string,
  fields: (keyof T)[],
  windowDays?: number,
): { tot: Totals; g: number } {
  const cutoff = windowDays != null ? dayNum(before) - windowDays : -Infinity;
  const tot: Totals = {};
  for (const f of fields) tot[String(f)] = 0;
  let g = 0;
  for (const l of logs) {
    if (!l.date || l.date >= before) continue;
    if (dayNum(l.date) < cutoff) continue;
    for (const f of fields) tot[String(f)] += n(l[f]);
    g += 1;
  }
  return { tot, g };
}

const BAT_FIELDS_SUM = ["pa", "ab", "h", "tb", "hr", "rbi", "r", "sb", "bb", "k"] as const;
const PIT_FIELDS_SUM = ["bf", "k", "outs", "h", "bb", "hr", "gs"] as const;

const batHit = (l: BatLog, market: string) =>
  market === "h1"
    ? l.h >= 1
      ? 1
      : 0
    : market === "h2"
      ? l.h >= 2
        ? 1
        : 0
      : market === "tb2"
        ? l.tb >= 2
          ? 1
          : 0
        : market === "hr1"
          ? l.hr >= 1
            ? 1
            : 0
          : market === "rbi1"
            ? l.rbi >= 1
              ? 1
              : 0
            : market === "r1"
              ? l.r >= 1
                ? 1
                : 0
              : l.sb >= 1
                ? 1
                : 0;

const pitHit = (l: PitLog, market: string) =>
  !l.gs
    ? 0
    : market === "k5"
      ? l.k >= 5
        ? 1
        : 0
      : market === "k6"
        ? l.k >= 6
          ? 1
          : 0
        : market === "k7"
          ? l.k >= 7
            ? 1
            : 0
          : l.outs >= 16
            ? 1
            : 0;

function countHits<T extends { date: string }>(
  logs: T[],
  before: string,
  hit: (l: T) => number,
  windowDays?: number,
): number {
  const cutoff = windowDays != null ? dayNum(before) - windowDays : -Infinity;
  let c = 0;
  for (const l of logs) {
    if (!l.date || l.date >= before) continue;
    if (dayNum(l.date) < cutoff) continue;
    c += hit(l);
  }
  return c;
}

type SpAgg = { bf: number; k: number; h: number; bb: number; hr: number; gs: number } | null;

/** The generic batter block, in BATTER_FEATURES order. */
function batterFeatures(
  logs: BatLog[],
  date: string,
  prior: PriorBat | undefined,
  slot: number,
  isHome: boolean,
  park: number,
  team: TeamCtx | undefined,
  opp: TeamCtx | undefined,
  sp: SpAgg,
): number[] | null {
  const s = sumLogs(logs, date, [...BAT_FIELDS_SUM]);
  const w = sumLogs(logs, date, [...BAT_FIELDS_SUM], C.WINDOW_DAYS);
  if (s.g < 1 || !team?.g || !opp?.g) return null;
  const pa = s.tot.pa;
  const spKnown = sp && sp.bf >= 1;
  return [
    shrunk(s.tot.h, pa, LG.h_pa, C.K_PA),
    shrunk(s.tot.tb, pa, LG.tb_pa, C.K_PA),
    shrunk(s.tot.hr, pa, LG.hr_pa, C.K_PA),
    shrunk(s.tot.rbi, pa, LG.rbi_pa, C.K_PA),
    shrunk(s.tot.r, pa, LG.r_pa, C.K_PA),
    shrunk(s.tot.bb, pa, LG.bb_pa, C.K_PA),
    shrunk(s.tot.k, pa, LG.k_pa, C.K_PA),
    shrunk(s.tot.sb, pa, LG.sb_pa, C.K_PA),
    shrunk(s.tot.tb - s.tot.h, s.tot.ab, 0.145, C.K_PA),
    shrunk(w.tot.h, w.tot.pa, LG.h_pa, 80),
    shrunk(w.tot.tb, w.tot.pa, LG.tb_pa, 80),
    shrunk(w.tot.hr, w.tot.pa, LG.hr_pa, 80),
    w.g ? w.tot.pa / w.g : 3.9,
    Math.min(w.g, 30),
    prior ? shrunk(prior.h, prior.pa, LG.h_pa, C.K_PA) : LG.h_pa,
    prior ? shrunk(prior.tb, prior.pa, LG.tb_pa, C.K_PA) : LG.tb_pa,
    prior ? shrunk(prior.hr, prior.pa, LG.hr_pa, C.K_PA) : LG.hr_pa,
    prior ? Math.min(prior.pa, 700) : 0,
    prior ? 1 : 0,
    slot,
    pa / s.g,
    Math.min(s.g, 162),
    isHome ? 1 : 0,
    park,
    team.runs / team.g,
    opp.runsAllowed / opp.g,
    spKnown ? shrunk(sp!.k, sp!.bf, LG.p_k_bf, C.K_BF) : LG.p_k_bf,
    spKnown ? shrunk(sp!.h, sp!.bf, LG.p_h_bf, C.K_BF) : LG.p_h_bf,
    spKnown ? shrunk(sp!.hr, sp!.bf, LG.p_hr_bf, C.K_BF) : LG.p_hr_bf,
    spKnown ? shrunk(sp!.bb, sp!.bf, LG.p_bb_bf, C.K_BF) : LG.p_bb_bf,
    spKnown && sp!.gs ? sp!.bf / sp!.gs : 21,
    spKnown ? 1 : 0,
  ];
}

/** The generic starting-pitcher block, in PITCHER_FEATURES order. */
function pitcherFeatures(
  logs: PitLog[],
  date: string,
  prior: PriorPit | undefined,
  isHome: boolean,
  park: number,
  team: TeamCtx | undefined,
  opp: TeamCtx | undefined,
): number[] | null {
  const s = sumLogs(logs, date, [...PIT_FIELDS_SUM]);
  const w = sumLogs(logs, date, [...PIT_FIELDS_SUM], C.WINDOW_DAYS);
  if (s.tot.gs < 1 || !team?.g || !opp?.g) return null;
  const bf = s.tot.bf;
  const gs = s.tot.gs;
  const lastStart = logs
    .filter((l) => l.gs > 0 && l.date && l.date < date)
    .reduce((mx, l) => Math.max(mx, dayNum(l.date)), -Infinity);
  const rest = Number.isFinite(lastStart) ? Math.min(dayNum(date) - lastStart, 12) : 5;
  return [
    shrunk(s.tot.k, bf, LG.p_k_bf, C.K_BF),
    shrunk(s.tot.h, bf, LG.p_h_bf, C.K_BF),
    shrunk(s.tot.bb, bf, LG.p_bb_bf, C.K_BF),
    shrunk(s.tot.hr, bf, LG.p_hr_bf, C.K_BF),
    bf / gs,
    s.tot.outs / gs,
    s.tot.k / gs,
    shrunk(w.tot.k, w.tot.bf, LG.p_k_bf, 120),
    w.g ? w.tot.bf / w.g : 21,
    w.g ? w.tot.k / w.g : 5,
    Math.min(w.g, 8),
    prior && prior.bf ? shrunk(prior.k, prior.bf, LG.p_k_bf, C.K_BF) : LG.p_k_bf,
    prior && prior.gs ? prior.bf / prior.gs : 21,
    prior && prior.bf ? 1 : 0,
    Math.min(gs, 34),
    rest,
    isHome ? 1 : 0,
    park,
    shrunk(opp.k, opp.pa, LG.k_pa, 400),
    shrunk(opp.h, opp.pa, LG.h_pa, 400),
    opp.runs / opp.g,
    team.runs / team.g,
  ];
}

// ----------------------------------------------------------------- inference
type MarketModel = (typeof model.markets)[keyof typeof model.markets];

function infer(m: MarketModel, x: number[]): number {
  let z = m.intercept;
  for (let i = 0; i < m.coef.length; i++) z += m.coef[i] * ((x[i] - m.mean[i]) / m.std[i]);
  const raw = 1 / (1 + Math.exp(-z));
  const lg = Math.log(raw / (1 - raw));
  return 1 / (1 + Math.exp(-(m.plattA * lg + m.plattB)));
}

/** Parity check against the trainer: every market ships three reference
 *  vectors with the probability scikit-learn produced for them. Returns the
 *  worst absolute disagreement across all of them (should be ~1e-12). */
export function modelParityError(): number {
  let worst = 0;
  for (const m of Object.values(model.markets)) {
    for (const t of m.selftest) worst = Math.max(worst, Math.abs(infer(m, t.x) - t.p));
  }
  return worst;
}

function tierFor(m: MarketModel, p: number) {
  for (const t of m.tiers ?? []) if (p >= t.minProb) return t;
  return null;
}

// -------------------------------------------------------------------- public
export type PropPick = {
  playerId: number;
  player: string;
  team: string;
  teamId: number;
  kind: "batter" | "pitcher";
  market: string;
  label: string;
  prob: number; // calibrated P(prop hits)
  base: number; // league base rate for this market
  edge: number; // prob - base, i.e. how far above a random starter
  tier: string | null; // backtested tier this pick lands in
  tierHitRate: number | null; // that tier's measured hit rate (held-out 2026)
  slot?: number; // batting order, when known
  opponent: string;
};
export type PropGame = {
  gameId: number;
  date: string;
  startsAt: string;
  home: string;
  away: string;
  matchup: string;
  venue: string;
  park: number;
  lineupsPosted: boolean;
  picks: PropPick[];
};
export type PropsSlate = {
  season: number;
  games: PropGame[];
  markets: { key: string; label: string; kind: string; base: number; auc: number }[];
};

const BATTER_MARKETS = Object.entries(model.markets).filter(([, m]) => m.kind === "batter");
const PITCHER_MARKETS = Object.entries(model.markets).filter(([, m]) => m.kind === "pitcher");
/** Batter picks kept per market per game (the ones a card can show). */
const PER_MARKET = 3;

export async function propsSlate(date: string): Promise<PropsSlate> {
  const season = Number(date.slice(0, 4));
  const markets = Object.entries(model.markets).map(([key, m]) => ({
    key,
    label: m.label,
    kind: m.kind,
    base: m.base,
    auc: m.metrics.auc,
  }));

  const slate = await fetchSlate(date);
  if (slate.length === 0) return { season, games: [], markets };

  // Batting orders: posted lineup when we have it, else the team's last one.
  const orders = new Map<string, number[]>(); // `${gamePk}:${side}` -> ids
  await Promise.all(
    slate.flatMap((g) =>
      (["home", "away"] as const).map(async (side) => {
        const posted = g.lineups[side];
        const ids = posted.length >= 9 ? posted : await fetchRecentOrder(g[side].id, date);
        orders.set(`${g.gamePk}:${side}`, ids.slice(0, 9));
      }),
    ),
  );

  const batterIds = [...orders.values()].flat();
  const pitcherIds = slate.flatMap((g) => [g.homeSp?.id, g.awaySp?.id].filter(Boolean) as number[]);

  const [batLogs, pitLogs, prior, teams] = await Promise.all([
    fetchLogs<BatLog>(batterIds, season, "hitting", date, parseBat),
    fetchLogs<PitLog>(pitcherIds, season, "pitching", date, parsePit),
    fetchPriorSeason(season - 1),
    fetchTeamContext(season, date),
  ]);

  const spAgg = (id: number | undefined): SpAgg => {
    if (!id) return null;
    const logs = pitLogs.get(id)?.logs ?? [];
    const s = sumLogs(logs, date, [...PIT_FIELDS_SUM]);
    return s.g
      ? { bf: s.tot.bf, k: s.tot.k, h: s.tot.h, bb: s.tot.bb, hr: s.tot.hr, gs: s.tot.gs }
      : null;
  };

  const games: PropGame[] = [];
  for (const g of slate) {
    const park = parkOf(g.venue);
    const picks: PropPick[] = [];

    for (const side of ["home", "away"] as const) {
      const isHome = side === "home";
      const me = g[side];
      const other = isHome ? g.away : g.home;
      const oppSp = spAgg(isHome ? g.awaySp?.id : g.homeSp?.id);
      const ids = orders.get(`${g.gamePk}:${side}`) ?? [];
      const byMarket = new Map<string, PropPick[]>();

      ids.forEach((pid, idx) => {
        const rec = batLogs.get(pid);
        if (!rec) return;
        const base = batterFeatures(
          rec.logs,
          date,
          prior.bat.get(pid),
          idx + 1,
          isHome,
          park,
          teams.get(me.id),
          teams.get(other.id),
          oppSp,
        );
        if (!base) return;
        const win = sumLogs(rec.logs, date, [...BAT_FIELDS_SUM], C.WINDOW_DAYS);
        const all = sumLogs(rec.logs, date, [...BAT_FIELDS_SUM]);
        for (const [key, m] of BATTER_MARKETS) {
          const own = shrunk(
            countHits(rec.logs, date, (l) => batHit(l, key)),
            all.g,
            BATTER_PRIORS[key],
            C.K_G,
          );
          const ownW = shrunk(
            countHits(rec.logs, date, (l) => batHit(l, key), C.WINDOW_DAYS),
            win.g,
            BATTER_PRIORS[key],
            12,
          );
          const prob = infer(m, [...base, own, ownW]);
          const t = tierFor(m, prob);
          const list = byMarket.get(key) ?? [];
          list.push({
            playerId: pid,
            player: rec.name,
            team: me.abbr,
            teamId: me.id,
            kind: "batter",
            market: key,
            label: m.label,
            prob,
            base: m.base,
            edge: prob - m.base,
            tier: t?.label ?? null,
            tierHitRate: t?.hitRate ?? null,
            slot: idx + 1,
            opponent: other.abbr,
          });
          byMarket.set(key, list);
        }
      });

      for (const [, list] of byMarket) {
        list.sort((a, b) => b.prob - a.prob);
        picks.push(...list.slice(0, PER_MARKET));
      }

      // the team's own starting pitcher
      const sp = isHome ? g.homeSp : g.awaySp;
      const rec = sp ? pitLogs.get(sp.id) : undefined;
      if (sp && rec) {
        const base = pitcherFeatures(
          rec.logs,
          date,
          prior.pit.get(sp.id),
          isHome,
          park,
          teams.get(me.id),
          teams.get(other.id),
        );
        if (base) {
          const win = sumLogs(rec.logs, date, [...PIT_FIELDS_SUM], C.WINDOW_DAYS);
          const all = sumLogs(rec.logs, date, [...PIT_FIELDS_SUM]);
          for (const [key, m] of PITCHER_MARKETS) {
            const own = shrunk(
              countHits(rec.logs, date, (l) => pitHit(l, key)),
              all.tot.gs,
              PITCHER_PRIORS[key],
              12,
            );
            const ownW = shrunk(
              countHits(rec.logs, date, (l) => pitHit(l, key), C.WINDOW_DAYS),
              win.g,
              PITCHER_PRIORS[key],
              5,
            );
            const prob = infer(m, [...base, own, ownW]);
            const t = tierFor(m, prob);
            picks.push({
              playerId: sp.id,
              player: rec.name || sp.name,
              team: me.abbr,
              teamId: me.id,
              kind: "pitcher",
              market: key,
              label: m.label,
              prob,
              base: m.base,
              edge: prob - m.base,
              tier: t?.label ?? null,
              tierHitRate: t?.hitRate ?? null,
              opponent: other.abbr,
            });
          }
        }
      }
    }

    picks.sort((a, b) => b.edge - a.edge);
    games.push({
      gameId: g.gamePk,
      date: g.date,
      startsAt: g.startsAt,
      home: g.home.abbr,
      away: g.away.abbr,
      matchup: `${g.away.abbr} @ ${g.home.abbr}`,
      venue: g.venue,
      park,
      lineupsPosted: g.lineups.home.length >= 9 && g.lineups.away.length >= 9,
      picks,
    });
  }

  return { season, games, markets };
}
