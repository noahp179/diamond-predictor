#!/usr/bin/env -S npx tsx
/**
 * Backtest: old vs new pick-ranking algorithms on the settled games stored
 * in Supabase, with strictly point-in-time model inputs.
 *
 *   npx tsx scripts/backtest-odds-blend.ts [--out results.json]
 *
 * What it reconstructs for every settled game in the DB (no lookahead):
 *   - sim-elo-v2 probabilities: Elo replayed through the morning of the game;
 *     team batting/staff rates and starter lines from byDateRange stats ending
 *     the day before; starter identities from the prediction rows stored at
 *     prediction time (fallback: the schedule's probable pitchers).
 *   - The real DraftKings moneyline via ESPN's historical summary endpoint,
 *     devigged to a fair market probability (doubleheader-safe matching).
 *
 * What it evaluates:
 *   1. Probability quality (accuracy / Brier / log loss): sim-elo-v2 alone,
 *      market alone, and logit blends p = σ((1−w)·logit(model) + w·logit(market))
 *      over a grid of w, plus a walk-forward-fitted w (honest estimate).
 *   2. Daily pick strategies (top-1 and top-3 hit rates + flat-stake ROI):
 *        REC-OLD   top-k by model confidence  (current Recommended page)
 *        BO-OLD    top-k by |model − market| edge (current Best Odds page)
 *        BO-TAB1   top-k by market favorite probability (new tab 1)
 *        BO-TAB2   top-k by blended confidence (new tab 2)
 *
 * Read-only: never writes to Supabase.
 */

import {
  computeElo,
  eloWinProb,
  fetchSeasonResults,
  leagueRates,
  reshapeStaff,
  simulateMatchup,
  type BattingRates,
  type PitchingLine,
  type StarterInfo,
  type TeamRates,
} from "../src/lib/mlb-sim";
import { STATS_API, fetchWithTimeout, batchedAll } from "../src/lib/mlb-core";
import { devig, fetchMoneylineForEvent } from "../src/lib/mlb-odds.server";

try {
  process.loadEnvFile(".env");
} catch {
  /* env may already be set */
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY in .env");
  process.exit(1);
}

// ─── Supabase REST (anon, read-only) ─────────────────────────────────────────

async function sbSelect(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY!, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as any[];
}

// ─── Point-in-time team rates (byDateRange, mirrors fetchAllTeamRates) ───────

async function fetchAllTeamRatesAsOf(
  season: number,
  endDate: string,
): Promise<Map<number, TeamRates>> {
  const base = `${STATS_API}/teams/stats?sportIds=1&season=${season}&stats=byDateRange&startDate=${season}-03-01&endDate=${endDate}`;
  const [hitRes, pitRes] = await Promise.all([
    fetchWithTimeout(`${base}&group=hitting`, 30_000),
    fetchWithTimeout(`${base}&group=pitching`, 30_000),
  ]);
  const map = new Map<number, TeamRates>();
  const init = (id: number) => {
    let r = map.get(id);
    if (!r) {
      r = { batting: null, staff: null };
      map.set(id, r);
    }
    return r;
  };
  if (hitRes.ok) {
    const j: any = await hitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id;
      const st = s?.stat;
      if (!id || !st) continue;
      const pa = st.plateAppearances ?? 0;
      if (pa < 100) continue;
      const h = st.hits ?? 0;
      const d2 = st.doubles ?? 0;
      const d3 = st.triples ?? 0;
      const hr = st.homeRuns ?? 0;
      init(id).batting = {
        pa,
        bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / pa,
        so: (st.strikeOuts ?? 0) / pa,
        b1: (h - d2 - d3 - hr) / pa,
        b2: d2 / pa,
        b3: d3 / pa,
        hr: hr / pa,
      };
    }
  }
  if (pitRes.ok) {
    const j: any = await pitRes.json();
    for (const s of j?.stats?.[0]?.splits ?? []) {
      const id = s?.team?.id;
      const st = s?.stat;
      if (!id || !st) continue;
      const bf = st.battersFaced ?? 0;
      if (bf < 100) continue;
      const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
      init(id).staff = {
        so: (st.strikeOuts ?? 0) / bf,
        bb: ((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0)) / bf,
        hr: (st.homeRuns ?? 0) / bf,
        b1: hNonHr / bf, // total non-HR hit rate; reshaped by reshapeStaff
        b2: 0,
        b3: 0,
      };
    }
  }
  return map;
}

// ─── Point-in-time starter line (byDateRange, mirrors fetchStarterInfo) ──────

function pickSplit(splits: any[]): any | null {
  if (!splits || splits.length === 0) return null;
  const combined = splits.find((s) => (s.numTeams ?? 1) > 1);
  if (combined) return combined.stat;
  // duplicates for the same team appear; distinct teams need summing
  const byTeam = new Map<string, any>();
  for (const s of splits) byTeam.set(String(s?.team?.id ?? "?"), s.stat);
  const stats = Array.from(byTeam.values());
  if (stats.length === 1) return stats[0];
  const sum: any = {};
  const numeric = [
    "battersFaced",
    "strikeOuts",
    "baseOnBalls",
    "hitByPitch",
    "hits",
    "homeRuns",
    "gamesStarted",
  ];
  for (const k of numeric) sum[k] = stats.reduce((a, s) => a + (s[k] ?? 0), 0);
  let outs = 0;
  for (const s of stats) {
    const parts = String(s.inningsPitched ?? "0.0").split(".");
    outs += (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
  }
  sum.inningsPitched = `${Math.floor(outs / 3)}.${outs % 3}`;
  return sum;
}

async function fetchStarterInfoAsOf(
  personId: number,
  season: number,
  endDate: string,
  lg: BattingRates,
): Promise<StarterInfo | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=pitching&season=${season}&startDate=${season}-03-01&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json: any = await res.json();
    const st = pickSplit(json?.stats?.[0]?.splits ?? []);
    if (!st) return null;
    const bf = st.battersFaced ?? 0;
    const PRIOR_BF = 70;
    const reg = (count: number, lgRate: number) => (count + lgRate * PRIOR_BF) / (bf + PRIOR_BF);
    const lgHits = lg.b1 + lg.b2 + lg.b3;
    const hNonHr = Math.max(0, (st.hits ?? 0) - (st.homeRuns ?? 0));
    const hRate = reg(hNonHr, lgHits);
    const line: PitchingLine = {
      so: reg(st.strikeOuts ?? 0, lg.so),
      bb: reg((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0), lg.bb),
      hr: reg(st.homeRuns ?? 0, lg.hr),
      b1: lgHits > 0 ? hRate * (lg.b1 / lgHits) : lg.b1,
      b2: lgHits > 0 ? hRate * (lg.b2 / lgHits) : lg.b2,
      b3: lgHits > 0 ? hRate * (lg.b3 / lgHits) : lg.b3,
    };
    const starts = st.gamesStarted ?? 0;
    const ipStr: string = st.inningsPitched ?? "0.0";
    const parts = ipStr.split(".");
    const outs = (parseInt(parts[0], 10) || 0) * 3 + (parts[1] ? parseInt(parts[1], 10) : 0);
    const expectedOuts =
      starts > 0 ? Math.min(21, Math.max(9, (outs + 15.5 * 3) / (starts + 3))) : 15.5;
    return { line, expectedOuts };
  } catch {
    return null;
  }
}

// ─── ESPN historical odds (doubleheader-safe) ────────────────────────────────

interface EspnEventFull {
  id: string;
  date: string;
  homeName: string;
  awayName: string;
}

async function fetchEspnEventsFull(date: string): Promise<EspnEventFull[]> {
  const compact = date.replaceAll("-", "");
  try {
    const res = await fetchWithTimeout(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}`,
      15_000,
    );
    if (!res.ok) return [];
    const json: any = await res.json();
    const out: EspnEventFull[] = [];
    for (const e of json?.events ?? []) {
      const comp = e?.competitions?.[0];
      const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
      if (!home || !away) continue;
      out.push({
        id: e.id,
        date: e.date ?? "",
        homeName: home.team?.displayName ?? "",
        awayName: away.team?.displayName ?? "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ScoredGame {
  gameId: number;
  date: string;
  time: string;
  home: string;
  away: string;
  winner: "home" | "away";
  y: number; // 1 = home won
  pSim: number;
  pElo: number;
  pModel: number; // sim-elo-v2 ensemble
  pMarket: number | null; // devigged home implied prob
  mlHome: number | null;
  mlAway: number | null;
  pBaseline: number | null; // stored baseline-v0.4 home prob
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (p: number) => Math.min(0.99, Math.max(0.01, p));

function blend(pModel: number, pMarket: number, w: number): number {
  return sigmoid((1 - w) * logit(clamp01(pModel)) + w * logit(clamp01(pMarket)));
}

function metrics(pairs: Array<[number, number]>): {
  n: number;
  acc: number;
  brier: number;
  logLoss: number;
} {
  const eps = 1e-7;
  let acc = 0;
  let brier = 0;
  let ll = 0;
  for (const [p, y] of pairs) {
    acc += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    brier += (p - y) ** 2;
    const pc = Math.min(1 - eps, Math.max(eps, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
  }
  const n = pairs.length;
  return { n, acc: acc / n, brier: brier / n, logLoss: ll / n };
}

/** Profit of a 1-unit stake at American odds `ml` if the bet wins. */
function mlProfit(ml: number): number {
  return ml > 0 ? ml / 100 : 100 / -ml;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("Loading settled games + stored predictions from Supabase…");
  const [games, preds] = await Promise.all([
    sbSelect(
      "games?select=game_id,game_date,game_time,venue,home_team_id,home_team_name,away_team_id,away_team_name,home_score,away_score,winner&winner=not.is.null&order=game_date.asc",
    ),
    sbSelect(
      "predictions?select=game_id,model_version,home_win_prob,home_pitcher_id,away_pitcher_id",
    ),
  ]);
  console.log(`  ${games.length} settled games`);

  const pitcherByGame = new Map<number, { home: number | null; away: number | null }>();
  const baselineByGame = new Map<number, number>();
  for (const p of preds) {
    if (p.model_version === "baseline-v0.4") {
      baselineByGame.set(p.game_id, Number(p.home_win_prob));
    }
    const cur = pitcherByGame.get(p.game_id);
    // prefer baseline rows (they carry the morning probables), else any row with ids
    if (!cur || (p.model_version === "baseline-v0.4" && (p.home_pitcher_id || p.away_pitcher_id))) {
      pitcherByGame.set(p.game_id, {
        home: p.home_pitcher_id ?? cur?.home ?? null,
        away: p.away_pitcher_id ?? cur?.away ?? null,
      });
    }
  }

  const byDate = new Map<string, any[]>();
  for (const g of games) {
    const arr = byDate.get(g.game_date) ?? [];
    arr.push(g);
    byDate.set(g.game_date, arr);
  }
  const dates = Array.from(byDate.keys()).sort();
  const dh =
    games.length -
    new Set(games.map((g) => `${g.game_date}|${g.home_team_id}|${g.away_team_id}`)).size;
  console.log(
    `  ${dates.length} dates (${dates[0]} → ${dates[dates.length - 1]}), ${dh} doubleheader game(s)`,
  );

  console.log("Fetching prior-season results for multi-season Elo (2024, 2025)…");
  const season = parseInt(dates[0].slice(0, 4), 10);
  const [prev2, prev1] = await Promise.all([
    fetchSeasonResults(season - 2, `${season - 2}-12-01`),
    fetchSeasonResults(season - 1, `${season - 1}-12-01`),
  ]);
  console.log(`  ${prev2.length} + ${prev1.length} prior-season results`);

  const scored: ScoredGame[] = [];
  let oddsMissing = 0;

  for (const date of dates) {
    const dayGames = byDate.get(date)!;
    const dayBefore = new Date(new Date(date + "T00:00:00Z").getTime() - 86400000)
      .toISOString()
      .slice(0, 10);

    // 1. Point-in-time model inputs
    const [seasonResults, teamRates, espnEvents] = await Promise.all([
      fetchSeasonResults(season, date),
      fetchAllTeamRatesAsOf(season, dayBefore),
      fetchEspnEventsFull(date),
    ]);
    const elo = computeElo([prev2, prev1, seasonResults]);
    const lg = leagueRates(teamRates);

    // 2. Starter identities: stored prediction rows, fallback to the schedule's probables
    const needSchedule = dayGames.some((g) => {
      const p = pitcherByGame.get(g.game_id);
      return !p || p.home == null || p.away == null;
    });
    if (needSchedule) {
      try {
        const res = await fetchWithTimeout(
          `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher&startDate=${date}&endDate=${date}`,
          20_000,
        );
        if (res.ok) {
          const j: any = await res.json();
          for (const sg of j?.dates?.[0]?.games ?? []) {
            const cur = pitcherByGame.get(sg.gamePk) ?? { home: null, away: null };
            pitcherByGame.set(sg.gamePk, {
              home: cur.home ?? sg.teams?.home?.probablePitcher?.id ?? null,
              away: cur.away ?? sg.teams?.away?.probablePitcher?.id ?? null,
            });
          }
        }
      } catch {
        /* keep nulls; sim falls back to staff line */
      }
    }

    const pitcherIds = new Set<number>();
    for (const g of dayGames) {
      const p = pitcherByGame.get(g.game_id);
      if (p?.home) pitcherIds.add(p.home);
      if (p?.away) pitcherIds.add(p.away);
    }
    const starters = new Map<number, StarterInfo | null>();
    await batchedAll(
      Array.from(pitcherIds).map((id) => async () => {
        starters.set(id, await fetchStarterInfoAsOf(id, season, dayBefore, lg));
      }),
      8,
    );

    // 3. Odds: match ESPN events by name pair; zip chronologically for doubleheaders
    const evByPair = new Map<string, EspnEventFull[]>();
    for (const e of espnEvents) {
      const k = `${e.awayName}@${e.homeName}`;
      const arr = evByPair.get(k) ?? [];
      arr.push(e);
      evByPair.set(k, arr);
    }
    for (const arr of evByPair.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    const gByPair = new Map<string, any[]>();
    for (const g of dayGames) {
      const k = `${g.away_team_name}@${g.home_team_name}`;
      const arr = gByPair.get(k) ?? [];
      arr.push(g);
      gByPair.set(k, arr);
    }
    for (const arr of gByPair.values()) arr.sort((a, b) => (a.game_time < b.game_time ? -1 : 1));

    const oddsByGame = new Map<number, { mlHome: number; mlAway: number; pHome: number }>();
    const oddsTasks: Array<() => Promise<void>> = [];
    for (const [pair, arr] of gByPair) {
      const evs = evByPair.get(pair) ?? [];
      arr.forEach((g, i) => {
        const ev = evs[i];
        if (!ev) return;
        oddsTasks.push(async () => {
          const ml = await fetchMoneylineForEvent(ev.id);
          if (!ml) return;
          const { homeImpliedProb } = devig(ml.homeMoneyLine, ml.awayMoneyLine);
          oddsByGame.set(g.game_id, {
            mlHome: ml.homeMoneyLine,
            mlAway: ml.awayMoneyLine,
            pHome: homeImpliedProb,
          });
        });
      });
    }
    await batchedAll(oddsTasks, 8);

    // 4. Simulate each game with production code + per-game production seed
    for (const g of dayGames) {
      const rates = (id: number): TeamRates => teamRates.get(id) ?? { batting: null, staff: null };
      const hRates = rates(g.home_team_id);
      const aRates = rates(g.away_team_id);
      const pids = pitcherByGame.get(g.game_id);
      const pSim = simulateMatchup(
        {
          homeBatting: hRates.batting ?? lg,
          awayBatting: aRates.batting ?? lg,
          homeStarter: (pids?.home && starters.get(pids.home)) || null,
          awayStarter: (pids?.away && starters.get(pids.away)) || null,
          homeStaff: reshapeStaff(hRates.staff, lg),
          awayStaff: reshapeStaff(aRates.staff, lg),
          league: lg,
          venue: g.venue ?? null,
        },
        3000,
        1000 + g.game_id,
      );
      const pElo = eloWinProb(elo.get(g.home_team_id) ?? 1500, elo.get(g.away_team_id) ?? 1500);
      const pModel = sigmoid((logit(clamp01(pSim)) + logit(clamp01(pElo))) / 2);
      const odds = oddsByGame.get(g.game_id) ?? null;
      if (!odds) oddsMissing++;
      scored.push({
        gameId: g.game_id,
        date: g.game_date,
        time: g.game_time,
        home: g.home_team_name,
        away: g.away_team_name,
        winner: g.winner,
        y: g.winner === "home" ? 1 : 0,
        pSim,
        pElo,
        pModel,
        pMarket: odds?.pHome ?? null,
        mlHome: odds?.mlHome ?? null,
        mlAway: odds?.mlAway ?? null,
        pBaseline: baselineByGame.get(g.game_id) ?? null,
      });
    }
    const dayOdds = dayGames.filter((g) => oddsByGame.has(g.game_id)).length;
    console.log(
      `  ${date}: ${dayGames.length} games simulated, odds ${dayOdds}/${dayGames.length}`,
    );
  }

  console.log(
    `\nScored ${scored.length} games (${oddsMissing} without odds) in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
  );

  // ═══ 1. Probability quality ════════════════════════════════════════════════

  const withOdds = scored.filter((s) => s.pMarket != null);
  const pairsOf = (f: (s: ScoredGame) => number, set: ScoredGame[] = scored) =>
    set.map((s) => [f(s), s.y] as [number, number]);

  console.log("═══ Probability quality — all settled games ═══");
  const fmt = (name: string, m: { n: number; acc: number; brier: number; logLoss: number }) =>
    console.log(
      `${name.padEnd(26)} n=${String(m.n).padStart(3)}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`,
    );
  fmt("sim-elo-v2 (recomputed)", metrics(pairsOf((s) => s.pModel)));
  fmt("  · sim component", metrics(pairsOf((s) => s.pSim)));
  fmt("  · elo component", metrics(pairsOf((s) => s.pElo)));
  fmt("home-always-54", metrics(pairsOf(() => 0.54)));
  const baseSet = scored.filter((s) => s.pBaseline != null);
  fmt("stored baseline-v0.4", metrics(pairsOf((s) => s.pBaseline!, baseSet)));

  console.log(`\n═══ Games with market odds (n=${withOdds.length}) ═══`);
  fmt("sim-elo-v2", metrics(pairsOf((s) => s.pModel, withOdds)));
  fmt("market (devigged DK)", metrics(pairsOf((s) => s.pMarket!, withOdds)));
  console.log("\nBlend σ((1−w)·logit(model) + w·logit(market)) over w:");
  const wGrid: number[] = [];
  for (let w = 0; w <= 1.0001; w += 0.05) wGrid.push(Number(w.toFixed(2)));
  const gridRows: Array<{ w: number; brier: number; logLoss: number; acc: number }> = [];
  for (const w of wGrid) {
    const m = metrics(pairsOf((s) => blend(s.pModel, s.pMarket!, w), withOdds));
    gridRows.push({ w, ...m });
    console.log(
      `  w=${w.toFixed(2)}  acc=${(m.acc * 100).toFixed(1)}%  brier=${m.brier.toFixed(4)}  logloss=${m.logLoss.toFixed(4)}`,
    );
  }
  const bestW = gridRows.reduce((a, b) => (b.brier < a.brier ? b : a));
  console.log(`  → full-sample argmin: w=${bestW.w} (brier ${bestW.brier.toFixed(4)})`);

  // Split-half stability
  const half = Math.floor(dates.length / 2);
  const firstDates = new Set(dates.slice(0, half));
  const h1 = withOdds.filter((s) => firstDates.has(s.date));
  const h2 = withOdds.filter((s) => !firstDates.has(s.date));
  const argminW = (set: ScoredGame[]) =>
    wGrid.reduce(
      (best, w) => {
        const m = metrics(pairsOf((s) => blend(s.pModel, s.pMarket!, w), set));
        return m.brier < best.brier ? { w, brier: m.brier } : best;
      },
      { w: -1, brier: Infinity },
    );
  const a1 = argminW(h1);
  const a2 = argminW(h2);
  console.log(
    `  split-half: first ${half} days argmin w=${a1.w}, last ${dates.length - half} days argmin w=${a2.w}`,
  );

  // Walk-forward w (fit on all prior days, evaluate current day)
  const wfPairs: Array<[number, number]> = [];
  const wfWs: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    const prior = withOdds.filter((s) => s.date < dates[i]);
    const today = withOdds.filter((s) => s.date === dates[i]);
    if (today.length === 0) continue;
    const w = prior.length >= 30 ? argminW(prior).w : 0.5;
    wfWs.push(w);
    for (const s of today) wfPairs.push([blend(s.pModel, s.pMarket!, w), s.y]);
  }
  fmt("walk-forward blend", metrics(wfPairs));
  console.log(`  walk-forward w path: ${wfWs.map((w) => w.toFixed(2)).join(" ")}`);

  // Model-only calibration check: p' = σ(a·logit(p))
  let bestA = { a: 1, logLoss: Infinity };
  for (let a = 0.4; a <= 2.0001; a += 0.02) {
    const m = metrics(pairsOf((s) => sigmoid(a * logit(clamp01(s.pModel)))));
    if (m.logLoss < bestA.logLoss) bestA = { a: Number(a.toFixed(2)), logLoss: m.logLoss };
  }
  console.log(
    `\nModel calibration: best logit scale a=${bestA.a} (a<1 ⇒ overconfident, a>1 ⇒ underconfident)`,
  );

  // ═══ 2. Daily pick strategies ═══════════════════════════════════════════════

  const SHIP_W = 0.65; // shipped blend weight (see grid above)

  interface PickResult {
    date: string;
    game: string;
    conf: number;
    pickHome: boolean;
    won: boolean;
    profit: number | null;
  }
  type Strategy = {
    name: string;
    universe: (day: ScoredGame[]) => ScoredGame[];
    rank: (s: ScoredGame) => number; // higher = better
    side: (s: ScoredGame) => boolean; // true = pick home
  };

  const conf = (p: number) => Math.abs(p - 0.5) * 2;
  const pBlend = (s: ScoredGame) => blend(s.pModel, s.pMarket!, SHIP_W);

  const strategies: Strategy[] = [
    {
      name: "REC-OLD model confidence",
      universe: (d) => d,
      rank: (s) => conf(s.pModel),
      side: (s) => s.pModel >= 0.5,
    },
    {
      name: "BO-OLD |edge| vs market",
      universe: (d) => d.filter((s) => s.pMarket != null),
      rank: (s) => Math.abs(s.pModel - s.pMarket!),
      side: (s) => s.pModel - s.pMarket! >= 0,
    },
    {
      name: "BO-TAB1 market favorite",
      universe: (d) => d.filter((s) => s.pMarket != null),
      rank: (s) => conf(s.pMarket!),
      side: (s) => s.pMarket! >= 0.5,
    },
    {
      name: `BO-TAB2 blend w=${SHIP_W}`,
      universe: (d) => d.filter((s) => s.pMarket != null),
      rank: (s) => conf(pBlend(s)),
      side: (s) => pBlend(s) >= 0.5,
    },
  ];

  console.log(`\n═══ Daily pick strategies (top-K per day) ═══`);
  const strategyResults: Record<string, any> = {};
  for (const K of [1, 3]) {
    console.log(`\n— Top-${K} per day —`);
    for (const st of strategies) {
      const picks: PickResult[] = [];
      for (const date of dates) {
        const day = st.universe(scored.filter((s) => s.date === date));
        const top = [...day].sort((a, b) => st.rank(b) - st.rank(a)).slice(0, K);
        for (const s of top) {
          const pickHome = st.side(s);
          const won = (s.winner === "home") === pickHome;
          const ml = pickHome ? s.mlHome : s.mlAway;
          picks.push({
            date: s.date,
            game: `${s.away} @ ${s.home}`,
            conf: st.rank(s),
            pickHome,
            won,
            profit: ml != null ? (won ? mlProfit(ml) : -1) : null,
          });
        }
      }
      const n = picks.length;
      const hits = picks.filter((p) => p.won).length;
      const staked = picks.filter((p) => p.profit != null);
      const roi =
        staked.length > 0 ? staked.reduce((a, p) => a + p.profit!, 0) / staked.length : null;
      console.log(
        `${st.name.padEnd(28)} n=${String(n).padStart(2)}  hits=${String(hits).padStart(2)}  hit-rate=${((hits / n) * 100).toFixed(1)}%  flat-ROI=${roi != null ? (roi * 100).toFixed(1) + "%" : "  —"}`,
      );
      strategyResults[`${st.name}|top${K}`] = { n, hits, hitRate: hits / n, roi };
    }
  }

  // ═══ Save ═══════════════════════════════════════════════════════════════════

  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;
  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          window: { start: dates[0], end: dates[dates.length - 1] },
          nGames: scored.length,
          nWithOdds: withOdds.length,
          grid: gridRows,
          splitHalf: { firstHalfW: a1.w, secondHalfW: a2.w },
          walkForward: { metrics: metrics(wfPairs), wPath: wfWs },
          calibrationA: bestA,
          strategies: strategyResults,
          games: scored,
        },
        null,
        2,
      ),
    );
    console.log(`\nSaved full results to ${outPath}`);
  }
}

main().catch((err) => {
  console.error("💥 backtest failed:", err);
  process.exit(1);
});
