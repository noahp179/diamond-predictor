/**
 * tennis.server.ts — live draws and match probabilities for the ATP and WTA.
 *
 * Structurally the hardest of the four sports, for one reason: there are no
 * teams. A tennis rating belongs to a player who may not have played for six
 * weeks, and there is no roster endpoint to read current form from. So the
 * tour has to be REPLAYED — every completed singles match in the rating window,
 * oldest first — to know anything at all about who is playing today.
 *
 * That replay is exactly the walk in research/tennis/bakeoff_tennis.py, and the
 * twenty features it produces are the twenty the shipped logistic was fitted on.
 * The model file carries the feature ORDER, so the two cannot drift silently.
 *
 * WHAT THE MODEL DELIBERATELY DOES NOT USE
 * ----------------------------------------
 * Head-to-head. A pre-registered ablation found that including it makes the
 * model worse on both tours — most pairs have met once or twice, so the
 * "record" is a coin flip dressed as evidence, and whatever is real in it is
 * already in both players' ratings. Standalone it scores worse than always
 * predicting the base rate. It is computed for DISPLAY, because people want to
 * see it, and it is kept out of the prediction.
 *
 * Ratings are cached at module scope: completed seasons never change, and the
 * running season carries a short TTL.
 */

import matchModels from "./tennis-match-model.json";
import { pickOf, scoreOutcome, type ScoredCall } from "./ledger-stats";
import { surfaceOf, tourOf, type Surface, type TourSlug } from "./tennis-tours";

type MatchModel = {
  tour: string;
  name: string;
  algorithm: string;
  features: string[];
  mean: number[];
  std: number[];
  coef: number[];
  intercept: number;
  plattA: number;
  plattB: number;
  elo: { init: number; k: number; kFast: number; kSlow: number; surfaces: string[] };
  backtest: {
    logloss: number;
    brier: number;
    acc: number;
    auc: number;
    ece: number;
    n: number;
    seasons: number[];
    trainedThrough: number;
    bakeoffRank: number | null;
    bakeoffOf: number | null;
    loglossBehindBest: number | null;
    droppedFeatures: string[];
    frozenLogloss: number;
    frozenAcc: number;
    refitGain: number;
  };
  priors: { matches: number; players: number; surfaces: Record<string, number> };
};

const MODELS = matchModels as unknown as Record<string, MatchModel>;

export function tennisModelFor(slug: TourSlug): MatchModel {
  return MODELS[slug];
}

// ------------------------------------------------------------------- types

export type TennisPlayer = {
  id: string;
  name: string;
  country: string;
  seed: number | null;
};

export type TennisMatch = {
  id: string;
  date: string;
  tournament: string;
  tournamentId: string;
  venue: string;
  surface: Surface;
  round: string;
  completed: boolean;
  a: TennisPlayer;
  b: TennisPlayer;
  /** Probability player `a` wins. Null when neither player has any history. */
  probA: number | null;
  /** Elo gap (a − b) the probability leans on, for display. */
  eloGap: number | null;
  /** Head-to-head as known BEFORE this match. Shown, never used to predict. */
  h2h: { a: number; b: number } | null;
  scoreline: string;
  winner: "a" | "b" | null;
};

export type TennisSlate = {
  tour: TourSlug;
  date: string;
  matches: TennisMatch[];
  /** Elo table over players active in the rating window. */
  table: { id: string; name: string; country: string; rating: number; played: number }[];
  tournaments: { id: string; name: string; surface: Surface }[];
};

// ------------------------------------------------------------------- fetch

const API = "https://site.api.espn.com/apis/site/v2/sports/tennis";

type Competitor = {
  id?: string;
  winner?: boolean;
  curatedRank?: { current?: number };
  linescores?: { value?: number; tiebreak?: number }[];
  athlete?: { displayName?: string; flag?: { alt?: string } };
};

type Competition = {
  id?: string;
  date?: string;
  status?: { type?: { completed?: boolean; shortDetail?: string } };
  round?: { displayName?: string };
  competitors?: Competitor[];
  notes?: { text?: string }[];
};

type Event = {
  id?: string;
  name?: string;
  date?: string;
  venue?: { displayName?: string };
  groupings?: { grouping?: { slug?: string }; competitions?: Competition[] }[];
};

async function fetchJson<T>(url: string, ms = 20000): Promise<T | null> {
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

async function pool<T>(jobs: (() => Promise<T>)[], width = 10): Promise<T[]> {
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

const ymd = (d: string) => d.replace(/-/g, "");

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------- the rating window

/**
 * How far back to replay. Ratings need history; two years is enough for a
 * player's Elo to settle and short enough that a full replay stays cheap,
 * since one call returns an entire tournament rather than a day.
 */
const WINDOW_DAYS = 730;
/** Days between discovery probes. Tournaments run at least a week. */
const PROBE_STEP = 5;

type Raw = {
  matchId: string;
  date: string;
  tournamentId: string;
  tournament: string;
  venue: string;
  surface: Surface;
  round: string;
  roundId: number;
  completed: boolean;
  drawSize: number;
  bestOf: number;
  players: { id: string; name: string; country: string; seed: number | null; won: boolean }[];
  games: [number, number];
  scoreline: string;
};

function parseEvent(ev: Event, grouping: string): Raw[] {
  const name = ev.name ?? "";
  const venue = ev.venue?.displayName ?? "";
  const surface = surfaceOf(name);
  const out: Raw[] = [];

  for (const g of ev.groupings ?? []) {
    if (g.grouping?.slug !== grouping) continue;
    const comps = g.competitions ?? [];
    for (const c of comps) {
      const cs = c.competitors ?? [];
      if (cs.length !== 2 || !cs[0]?.id || !cs[1]?.id || cs[0].id === cs[1].id) continue;
      const completed = Boolean(c.status?.type?.completed);
      const gamesOf = (x: Competitor) =>
        (x.linescores ?? []).reduce((s, ls) => s + (Number(ls.value) || 0), 0);
      out.push({
        matchId: String(c.id),
        date: (c.date ?? "").slice(0, 10),
        tournamentId: String(ev.id ?? ""),
        tournament: name,
        venue,
        surface,
        round: c.round?.displayName ?? "",
        roundId: Number((c.round as { id?: string })?.id) || 0,
        completed,
        drawSize: comps.length,
        // The feed's format field says best-of-5 on every match; recovered from
        // the scoreline instead, as in the research.
        bestOf: (cs[0].linescores?.length ?? 0) >= 4 ? 5 : 3,
        players: cs.map((x) => ({
          id: String(x.id),
          name: x.athlete?.displayName ?? "?",
          country: x.athlete?.flag?.alt ?? "",
          seed: x.curatedRank?.current ?? null,
          won: Boolean(x.winner),
        })),
        games: [gamesOf(cs[0]), gamesOf(cs[1])],
        scoreline: (c.notes ?? []).map((n) => n.text ?? "").join(" "),
      });
    }
  }
  return out;
}

type Window = { at: number; upTo: string; raw: Raw[] };
const windowCache = new Map<string, Window>();
const WINDOW_TTL = 60 * 60 * 1000;

/** Every completed match in the rating window, plus the day's draw. */
async function loadWindow(slug: TourSlug, date: string): Promise<Raw[]> {
  const key = `${slug}:${date}`;
  const hit = windowCache.get(key);
  if (hit && Date.now() - hit.at < WINDOW_TTL) return hit.raw;

  const tour = tourOf(slug);
  const start = addDays(date, -WINDOW_DAYS);
  const probes: string[] = [];
  for (let d = start; d <= date; d = addDays(d, PROBE_STEP)) probes.push(d);

  // Discovery: which tournaments exist, and one date inside each. Both feeds
  // carry both draws and neither is complete alone, so both are probed.
  const found = new Map<string, string>();
  const discovered = await pool(
    probes.flatMap((d) => [
      () => fetchJson<{ events?: Event[] }>(`${API}/atp/scoreboard?dates=${ymd(d)}`),
      () => fetchJson<{ events?: Event[] }>(`${API}/wta/scoreboard?dates=${ymd(d)}`),
    ]),
    12,
  );
  probes.forEach((d, i) => {
    for (const res of [discovered[i * 2], discovered[i * 2 + 1]]) {
      for (const ev of res?.events ?? []) if (ev.id) found.set(String(ev.id), d);
    }
  });

  // One call per tournament returns its whole draw.
  const pulled = await pool(
    [...found.values()].map(
      (d) => () =>
        fetchJson<{ events?: Event[] }>(`${API}/${tour.espn}/scoreboard?dates=${ymd(d)}`),
    ),
    10,
  );
  const byId = new Map<string, Raw>();
  for (const res of pulled) {
    for (const ev of res?.events ?? []) {
      for (const m of parseEvent(ev, tour.grouping)) {
        if (m.date) byId.set(m.matchId, m);
      }
    }
  }
  const raw = [...byId.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.matchId.localeCompare(b.matchId),
  );
  windowCache.set(key, { at: Date.now(), upTo: date, raw });
  return raw;
}

// -------------------------------------------------------------- the replay

const SURFACES: Surface[] = ["hard", "clay", "grass", "unknown"];

type PlayerState = {
  elo: number;
  eloFast: number;
  eloSlow: number;
  eloGames: number;
  surf: Record<string, number>;
  gR: number;
  gRD: number;
  bt: number;
  n: number;
  w: number;
  nSurf: Record<string, number>;
  wSurf: Record<string, number>;
  gw: number;
  gp: number;
  last: number[];
  streak: number;
  lastDate: string | null;
  event: Record<string, number>;
  name: string;
  country: string;
};

function newPlayer(init: number): PlayerState {
  return {
    elo: init,
    eloFast: init,
    eloSlow: init,
    eloGames: init,
    surf: Object.fromEntries(SURFACES.map((s) => [s, init])),
    gR: init,
    gRD: 350,
    bt: 0,
    n: 0,
    w: 0,
    nSurf: Object.fromEntries(SURFACES.map((s) => [s, 0])),
    wSurf: Object.fromEntries(SURFACES.map((s) => [s, 0])),
    gw: 0,
    gp: 0,
    last: [],
    streak: 0,
    lastDate: null,
    event: {},
    name: "",
    country: "",
  };
}

const LOG10 = Math.log(10);

/** Replay every completed match strictly before `upTo`. Mirrors walk(). */
function replay(
  model: MatchModel,
  raw: Raw[],
  upTo: string,
  /**
   * Called for each match immediately BEFORE its result is folded into the
   * ratings, with the probability the model would have priced it at. The
   * ordering is what makes a replay a replay: run the observer after the
   * update and every prediction is made by a model that already saw the answer.
   */
  onMatch?: (m: Raw, ctx: { probA: number | null }) => void,
) {
  const init = model.elo.init;
  const P = new Map<string, PlayerState>();
  const h2h = new Map<string, [number, number]>();
  const get = (id: string) => {
    let p = P.get(id);
    if (!p) {
      p = newPlayer(init);
      P.set(id, p);
    }
    return p;
  };

  for (const m of raw) {
    if (!m.completed || m.date >= upTo) continue;
    const [x, yPl] = m.players;
    const a = get(x.id);
    const b = get(yPl.id);
    a.name = x.name || a.name;
    a.country = x.country || a.country;
    b.name = yPl.name || b.name;
    b.country = yPl.country || b.country;
    const ya = x.won ? 1 : 0;
    const surf = SURFACES.includes(m.surface) ? m.surface : "unknown";
    const [ga, gb] = m.games;
    const total = Math.max(ga + gb, 1);

    if (onMatch) {
      // Same "is this player known" test the slate uses: two debutants have no
      // ratings to price a match with, so there is nothing to be right about.
      const known = a.n > 0 || b.n > 0;
      onMatch(m, {
        probA: known ? scoreModel(model, featuresFor(a, b, surf, x.seed, yPl.seed, m)) : null,
      });
    }

    for (const [k, key] of [
      [model.elo.k, "elo"],
      [model.elo.kFast, "eloFast"],
      [model.elo.kSlow, "eloSlow"],
    ] as const) {
      const ea = 1 / (1 + 10 ** ((b[key] - a[key]) / 400));
      const d = (k as number) * (ya - ea);
      a[key] += d;
      b[key] -= d;
    }
    const eg = 1 / (1 + 10 ** ((b.eloGames - a.eloGames) / 400));
    const dg = model.elo.k * (0.5 + Math.abs(ga - gb) / total) * (ya - eg);
    a.eloGames += dg;
    b.eloGames -= dg;

    const es = 1 / (1 + 10 ** ((b.surf[surf] - a.surf[surf]) / 400));
    const ds = model.elo.k * (ya - es);
    a.surf[surf] += ds;
    b.surf[surf] -= ds;

    const q = LOG10 / 400;
    for (const [p, o, res] of [
      [a, b, ya],
      [b, a, 1 - ya],
    ] as const) {
      const gg = 1 / Math.sqrt(1 + (3 * q * q * o.gRD ** 2) / Math.PI ** 2);
      const e = 1 / (1 + 10 ** ((-gg * (p.gR - o.gR)) / 400));
      const dsq = 1 / (q * q * gg * gg * e * (1 - e));
      const denom = 1 / p.gRD ** 2 + 1 / dsq;
      p.gR += (q / denom) * gg * (res - e);
      p.gRD = Math.max(Math.sqrt(1 / denom), 30);
    }

    const pa = 1 / (1 + Math.exp(-(a.bt - b.bt)));
    a.bt += 0.05 * (ya - pa);
    b.bt -= 0.05 * (ya - pa);

    for (const [p, res, gwon] of [
      [a, ya, ga],
      [b, 1 - ya, gb],
    ] as const) {
      p.n += 1;
      p.w += res;
      p.nSurf[surf] += 1;
      p.wSurf[surf] += res;
      p.gw += gwon;
      p.gp += total;
      p.last.push(res);
      if (p.last.length > 20) p.last.shift();
      p.streak = res ? p.streak + 1 : 0;
      p.lastDate = m.date;
      p.event[m.tournamentId] = (p.event[m.tournamentId] ?? 0) + 1;
    }

    const kk = `${x.id}|${yPl.id}`;
    const rec = h2h.get(kk) ?? [0, 0];
    rec[ya ? 0 : 1] += 1;
    h2h.set(kk, rec);
  }
  return { P, h2h, get };
}

const K_FORM = 6;
const K_GAMES = 20;

function featuresFor(
  a: PlayerState,
  b: PlayerState,
  surf: Surface,
  seedA: number | null,
  seedB: number | null,
  m: Raw,
): Record<string, number> {
  const wr = (p: PlayerState) => (p.w + K_FORM * 0.5) / (p.n + K_FORM);
  const swr = (p: PlayerState) => (p.wSurf[surf] + K_FORM * 0.5) / (p.nSurf[surf] + K_FORM);
  const form = (p: PlayerState) => {
    const d = p.last.slice(-10);
    return d.length ? d.reduce((s, v) => s + v, 0) / d.length : 0.5;
  };
  const gwr = (p: PlayerState) => (p.gw + K_GAMES * 0.5) / (p.gp + K_GAMES);
  const rest = (p: PlayerState) => {
    if (!p.lastDate) return 30;
    const days = Math.round(
      (Date.parse(`${m.date}T00:00:00Z`) - Date.parse(`${p.lastDate}T00:00:00Z`)) / 86400000,
    );
    return Math.min(days, 60);
  };
  const sGap = a.surf[surf] - b.surf[surf];
  return {
    elo: a.elo - b.elo,
    elo_fast: a.eloFast - b.eloFast,
    elo_slow: a.eloSlow - b.eloSlow,
    elo_games: a.eloGames - b.eloGames,
    elo_surface: sGap,
    elo_blend: 0.5 * sGap + 0.5 * (a.elo - b.elo),
    glicko: a.gR - b.gR,
    bradley_terry: a.bt - b.bt,
    // An unseeded player is worse than any seed; 40 stands in for "unseeded".
    seed_diff: (seedB ?? 40) - (seedA ?? 40),
    winrate: wr(a) - wr(b),
    surface_winrate: swr(a) - swr(b),
    form_last10: form(a) - form(b),
    games_won_ratio: gwr(a) - gwr(b),
    streak: Math.min(a.streak, 10) - Math.min(b.streak, 10),
    fatigue: (a.event[m.tournamentId] ?? 0) - (b.event[m.tournamentId] ?? 0),
    rest_days: rest(a) - rest(b),
    experience: Math.log1p(a.n) - Math.log1p(b.n),
    bestOf: m.bestOf,
    drawSize: m.drawSize,
    roundId: m.roundId,
  };
}

function scoreModel(model: MatchModel, f: Record<string, number>): number {
  let z = model.intercept;
  for (let i = 0; i < model.features.length; i += 1) {
    const v = f[model.features[i]] ?? 0;
    z += ((v - model.mean[i]) / (model.std[i] || 1)) * model.coef[i];
  }
  const raw = 1 / (1 + Math.exp(-z));
  const c = Math.min(Math.max(raw, 1e-9), 1 - 1e-9);
  const lg = Math.log(c / (1 - c));
  return 1 / (1 + Math.exp(-(model.plattA * lg + model.plattB)));
}

// --------------------------------------------------------------- the slate

export async function tennisSlate(slug: TourSlug, date: string): Promise<TennisSlate> {
  const model = tennisModelFor(slug);
  const raw = await loadWindow(slug, date);
  const { P, h2h, get } = replay(model, raw, date);

  const today = raw.filter((m) => m.date === date);
  const matches: TennisMatch[] = today.map((m) => {
    const [x, y] = m.players;
    const a = get(x.id);
    const b = get(y.id);
    const surf = SURFACES.includes(m.surface) ? m.surface : "unknown";
    const known = a.n > 0 || b.n > 0;
    const f = featuresFor(a, b, surf, x.seed, y.seed, m);
    const rec = h2h.get(`${x.id}|${y.id}`) ?? h2h.get(`${y.id}|${x.id}`);
    const h2hPair = rec
      ? h2h.has(`${x.id}|${y.id}`)
        ? { a: rec[0], b: rec[1] }
        : { a: rec[1], b: rec[0] }
      : null;

    return {
      id: m.matchId,
      date: m.date,
      tournament: m.tournament,
      tournamentId: m.tournamentId,
      venue: m.venue,
      surface: m.surface,
      round: m.round,
      completed: m.completed,
      a: { id: x.id, name: x.name, country: x.country, seed: x.seed },
      b: { id: y.id, name: y.name, country: y.country, seed: y.seed },
      probA: known ? scoreModel(model, f) : null,
      eloGap: known ? a.elo - b.elo : null,
      h2h: h2hPair && h2hPair.a + h2hPair.b > 0 ? h2hPair : null,
      scoreline: m.scoreline,
      winner: m.completed ? (x.won ? "a" : "b") : null,
    };
  });

  const table = [...P.entries()]
    .filter(([, p]) => p.n >= 5 && p.name)
    .map(([id, p]) => ({
      id,
      name: p.name,
      country: p.country,
      rating: p.elo,
      played: p.n,
    }))
    .sort((x, y) => y.rating - x.rating)
    .slice(0, 40);

  const tournaments = [
    ...new Map(
      today.map((m) => [
        m.tournamentId,
        { id: m.tournamentId, name: m.tournament, surface: m.surface },
      ]),
    ).values(),
  ];

  return { tour: slug, date, matches, table, tournaments };
}

// ------------------------------------------------------------ the replay log

/**
 * How far back the scored replay reaches.
 *
 * The rating window is already two years, so this costs nothing extra to fetch
 * — it is the same cached window the slate uses. A year of scored matches is
 * several thousand calls on either tour, which is a real sample.
 */
const HISTORY_DAYS = 365;
const HISTORY_TTL = 60 * 60 * 1000;
const historyCache = new Map<string, { at: number; calls: ScoredCall[] }>();

/**
 * Score the model over recent completed matches.
 *
 * This is a backtest, not the forward ledger, and the Track Record page labels
 * it as one. It exists because the live ledger starts empty and fills at the
 * rate the tour plays — for months there is nothing to draw — and because a
 * page that shows nothing teaches a reader nothing about whether the model
 * works. It is the same thing the NFL and NBA Track Record pages have always
 * shown.
 *
 * No leakage: `replay` calls the observer before folding each match in, so
 * every probability here was computable the morning of that match.
 */
export async function tennisHistory(
  slug: TourSlug,
  upTo: string,
  days = HISTORY_DAYS,
): Promise<ScoredCall[]> {
  const key = `${slug}:${upTo}:${days}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.calls;

  const model = tennisModelFor(slug);
  const raw = await loadWindow(slug, upTo);
  const since = addDays(upTo, -days);

  const calls: ScoredCall[] = [];
  replay(model, raw, upTo, (m, { probA }) => {
    if (probA == null || m.date < since) return;
    const probs = { a: probA, draw: null, b: 1 - probA };
    // The window orients every match by the feed's competitor order, and
    // `players[0].won` is the truth for that orientation.
    const result: "a" | "b" = m.players[0].won ? "a" : "b";
    const { pick, pickProb } = pickOf(probs);
    const { brier, logLoss, rps } = scoreOutcome(probs, result);
    calls.push({ date: m.date, pickProb, correct: pick === result, brier, logLoss, rps });
  });

  historyCache.set(key, { at: Date.now(), calls });
  return calls;
}
