// mlb-core-v4.ts
// Model baseline-v0.4: extends v0.3 with 5 additional log-odds signals.
// All new features are sourced from the free public MLB Stats API.
// Coefficients are literature-informed priors (hand-tuned, not gradient-fitted).

import {
  STATS_API,
  fetchStandings,
  fetchPitcherEra,
  parkFactor,
  predict,
  type TeamSide,
  type PredictedGame,
  type StandingsRow,
} from "./mlb-core";

import {
  fetchTeamHitting,
  fetchTeamPitching,
  fetchRestDays,
  fetchLastNGames,
  fetchHeadToHead,
  offsetDate,
  type TeamHittingStats,
  type TeamPitchingStats,
  type RestInfo,
  type L5Record,
  type HeadToHeadRecord,
} from "./mlb-features";

export const MODEL_VERSION_V4 = "baseline-v0.4";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface V4Features {
  homeHitting: TeamHittingStats;
  awayHitting: TeamHittingStats;
  homePitching: TeamPitchingStats;
  awayPitching: TeamPitchingStats;
  homeRest: RestInfo;
  awayRest: RestInfo;
  homeL5: L5Record;
  awayL5: L5Record;
  h2h: HeadToHeadRecord;
}

export interface PredictInputsV4 {
  home: StandingsRow | undefined;
  away: StandingsRow | undefined;
  homeEra: number | null;
  awayEra: number | null;
  homeFip?: number | null;
  awayFip?: number | null;
  venue?: string | null;
  features: V4Features;
}

export interface PredictedGameV4 extends PredictedGame {
  v4WinProb: number;    // home win probability from v4 model
  v4Rationale: string[];
  features: V4Features;
}

// ─── Batching helper ──────────────────────────────────────────────────────────

/**
 * Run async tasks in sequential batches to avoid overwhelming the MLB API.
 * Processes `batchSize` tasks concurrently, waits for each batch to complete
 * before starting the next. Eliminates the burst-all-at-once pattern of v0.3.
 */
export async function batchedAll<T>(
  tasks: Array<() => Promise<T>>,
  batchSize = 8,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((t) => t());
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

// ─── V4 Predict ───────────────────────────────────────────────────────────────

/**
 * Full log-odds blend for v0.4.
 * Extends v0.3 (team strength + run diff + home field + ERA gap + park factor)
 * with 5 additional signals:
 *   • Team OPS gap          (batting quality beyond run %)
 *   • Team WHIP gap         (holistic staff quality incl. bullpen)
 *   • Rest day advantage    (fatigue/recovery signal, Cui et al.)
 *   • Last-5 form           (hot/cold streak, tighter window than L10)
 *   • Head-to-head record   (season series context, confidence-weighted)
 */
export function predictV4({
  home,
  away,
  homeEra,
  awayEra,
  homeFip,
  awayFip,
  venue,
  features,
}: PredictInputsV4): { home: number; away: number; rationale: string[] } {
  const rationale: string[] = [];
  const logit = (p: number) => Math.log(p / (1 - p));
  const clamp = (x: number, lo = 0.2, hi = 0.8) => Math.min(hi, Math.max(lo, x));

  // ── 1. Composite team strength (same blend as v0.3) ──────────────────────
  const strength = (s: StandingsRow | undefined, isHome: boolean): number => {
    if (!s) return 0.5;
    const split = isHome ? s.homePct : s.awayPct;
    return 0.4 * s.pythagPct + 0.3 * s.winPct + 0.2 * s.lastTenPct + 0.1 * split;
  };
  const hStr = clamp(strength(home, true));
  const aStr = clamp(strength(away, false));
  let lo = logit(hStr) - logit(aStr);
  rationale.push(
    `Team strength: ${(hStr * 100).toFixed(0)}% vs ${(aStr * 100).toFixed(0)}% (Pythag·W%·L10·split)`,
  );

  // ── 2. Run-differential per game (same as v0.3) ───────────────────────────
  if (home && away) {
    const hRdg = (home.runsScored - home.runsAllowed) / Math.max(1, home.wins + home.losses);
    const aRdg = (away.runsScored - away.runsAllowed) / Math.max(1, away.wins + away.losses);
    const diff = hRdg - aRdg;
    const adj = diff * 0.12;
    lo += adj;
    rationale.push(
      `Run-diff/game ${diff >= 0 ? "+" : ""}${diff.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`,
    );
  }

  // ── 3. Home-field edge (same as v0.3) ────────────────────────────────────
  lo += 0.18;
  rationale.push("Home-field edge: +0.18 logit");

  // ── 4. Starting pitcher ERA gap (same as v0.3 for maximum baseline accuracy) ───
  const eraTerm = (era: number | null) => (era == null ? null : 4.2 - era);
  const ht = eraTerm(homeEra);
  const at = eraTerm(awayEra);
  if (ht != null && at != null) {
    const adj = (ht - at) * 0.16;
    lo += adj;
    rationale.push(
      `Starter ERA ${homeEra!.toFixed(2)} vs ${awayEra!.toFixed(2)} → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`,
    );
  } else if (ht != null) {
    const adj = ht * 0.08;
    lo += adj;
    rationale.push(`Home starter ERA ${homeEra!.toFixed(2)} vs lg 4.20 → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`);
  } else if (at != null) {
    const adj = -at * 0.08;
    lo += adj;
    rationale.push(`Away starter ERA ${awayEra!.toFixed(2)} vs lg 4.20 → ${adj >= 0 ? "+" : ""}${adj.toFixed(2)} logit`);
  }

  // ── 5. Park factor (same as v0.3) ────────────────────────────────────────
  const pf = parkFactor(venue);
  if (pf !== 100) {
    const amplify = 1 + (pf - 100) / 200;
    lo = lo * amplify;
    rationale.push(`Park factor ${pf} (${venue}) → ×${amplify.toFixed(3)} logit`);
  }

  // ══ NEW V4 FEATURES ══════════════════════════════════════════════════════

  // ── 6. Team OPS gap ──────────────────────────────────────────────────────
  // League-average OPS ≈ 0.720. A gap of 0.040 (roughly 1 SD) adds ~0.05 logit.
  // Coefficient: 1.2 logit per OPS unit  →  0.040 gap ≈ +0.048 logit.
  const { homeHitting, awayHitting } = features;
  if (homeHitting.ops != null && awayHitting.ops != null) {
    const opsGap = homeHitting.ops - awayHitting.ops;
    const opsAdj = opsGap * 1.2;
    lo += opsAdj;
    rationale.push(
      `OPS gap ${opsGap >= 0 ? "+" : ""}${opsGap.toFixed(3)} → ${opsAdj >= 0 ? "+" : ""}${opsAdj.toFixed(2)} logit`,
    );
  }

  // ── 7. Team WHIP gap (holistic staff / bullpen quality) ──────────────────
  // Lower WHIP = better pitching. League avg ≈ 1.30.
  // awayWhip − homeWhip > 0 means home staff is better.
  // Coefficient: 0.40 logit per WHIP unit  →  0.10 gap ≈ +0.040 logit.
  const { homePitching, awayPitching } = features;
  if (homePitching.whip != null && awayPitching.whip != null) {
    const whipGap = awayPitching.whip - homePitching.whip;
    const whipAdj = whipGap * 0.4;
    lo += whipAdj;
    rationale.push(
      `WHIP gap ${whipGap >= 0 ? "+" : ""}${whipGap.toFixed(3)} → ${whipAdj >= 0 ? "+" : ""}${whipAdj.toFixed(2)} logit`,
    );
  }

  // ── 8. Rest days advantage ────────────────────────────────────────────────
  // Each extra rest day advantage ≈ +0.03 logit (capped at 4 days effective).
  // Literature: Cui et al. (2020) found rest days statistically significant.
  const { homeRest, awayRest } = features;
  const homeEffRest = Math.min(homeRest.daysSinceLastGame, 4);
  const awayEffRest = Math.min(awayRest.daysSinceLastGame, 4);
  const restDelta = homeEffRest - awayEffRest;
  if (restDelta !== 0) {
    const restAdj = restDelta * 0.03;
    lo += restAdj;
    rationale.push(
      `Rest ${homeRest.daysSinceLastGame}d vs ${awayRest.daysSinceLastGame}d → ${restAdj >= 0 ? "+" : ""}${restAdj.toFixed(2)} logit`,
    );
  }

  // ── 9. Last-5 form ────────────────────────────────────────────────────────
  // Shorter window than L10 catches hot/cold streaks but is highly volatile in baseball.
  // Regressed coefficient: 0.08 logit difference for 5-0 vs 0-5.
  const { homeL5, awayL5 } = features;
  const l5Gap = homeL5.pct - awayL5.pct;
  if (homeL5.wins + homeL5.losses > 0 || awayL5.wins + awayL5.losses > 0) {
    const l5Adj = l5Gap * 0.08;
    lo += l5Adj;
    rationale.push(
      `L5 form ${(homeL5.pct * 100).toFixed(0)}% vs ${(awayL5.pct * 100).toFixed(0)}% → ${l5Adj >= 0 ? "+" : ""}${l5Adj.toFixed(2)} logit`,
    );
  }

  // ── 10. Head-to-head record (confidence-weighted) ─────────────────────────
  // Season series matters but is noisy early. Apply confidence weight:
  // full weight (×1.0) after 6 H2H games; proportional before that.
  // Max logit adjustment at full confidence: (0.5 − 0.5) × 0.10 × 1.0 = 0.05
  const { h2h } = features;
  if (h2h.totalGames >= 2) {
    const h2hPct = h2h.homeWins / h2h.totalGames;
    const confidence = Math.min(1.0, h2h.totalGames / 6);
    const h2hAdj = (h2hPct - 0.5) * 0.10 * confidence;
    lo += h2hAdj;
    rationale.push(
      `H2H ${h2h.homeWins}-${h2h.awayWins} (${h2h.totalGames}g) → ${h2hAdj >= 0 ? "+" : ""}${h2hAdj.toFixed(2)} logit`,
    );
  }

  // ── Final sigmoid + hard clamp ────────────────────────────────────────────
  const p = Math.min(0.9, Math.max(0.1, 1 / (1 + Math.exp(-lo))));
  return { home: p, away: 1 - p, rationale };
}

// ─── Full date pipeline ───────────────────────────────────────────────────────

/**
 * Fetch all data and compute v0.4 predictions for every game on `date`.
 * Returns PredictedGameV4 objects that extend PredictedGame with v4 fields.
 */
export async function buildPredictionsV4ForDate(
  date: string,
): Promise<PredictedGameV4[]> {
  const season = parseInt(date.slice(0, 4), 10);

  // ── Step 1: Schedule + standings in parallel ──────────────────────────────
  const scheduleUrl = `${STATS_API}/schedule?sportId=1&hydrate=probablePitcher,team,venue,linescore&startDate=${date}&endDate=${date}`;
  const [scheduleRes, standings] = await Promise.all([
    fetch(scheduleUrl),
    fetchStandings(season),
  ]);
  if (!scheduleRes.ok) throw new Error(`MLB schedule fetch failed: ${scheduleRes.status}`);
  const scheduleJson: any = await scheduleRes.json();
  const games: any[] = scheduleJson?.dates?.[0]?.games ?? [];
  if (games.length === 0) return [];

  // ── Step 2: Pitcher ERA (batched, same as v0.3) ───────────────────────────
  const pitcherIds = new Set<number>();
  for (const g of games) {
    const hp = g.teams?.home?.probablePitcher?.id;
    const ap = g.teams?.away?.probablePitcher?.id;
    if (hp) pitcherIds.add(hp);
    if (ap) pitcherIds.add(ap);
  }
  const pitcherStats = new Map<number, Awaited<ReturnType<typeof fetchPitcherEra>>>();
  await batchedAll(
    Array.from(pitcherIds).map((id) => async () => {
      pitcherStats.set(id, await fetchPitcherEra(id, season));
    }),
    8,
  );

  // ── Step 3: Team-level features (batched) ─────────────────────────────────
  // Collect unique team IDs to avoid duplicate fetches across games.
  const teamIds = new Set<number>();
  for (const g of games) {
    teamIds.add(g.teams.home.team.id);
    teamIds.add(g.teams.away.team.id);
  }

  const teamHittingMap = new Map<number, TeamHittingStats>();
  const teamPitchingMap = new Map<number, TeamPitchingStats>();
  const restMap = new Map<number, RestInfo>();
  const l5Map = new Map<number, L5Record>();

  const teamTasks = Array.from(teamIds).flatMap((id) => [
    async () => { teamHittingMap.set(id, await fetchTeamHitting(id, season)); },
    async () => { teamPitchingMap.set(id, await fetchTeamPitching(id, season)); },
    async () => { restMap.set(id, await fetchRestDays(id, date)); },
    async () => { l5Map.set(id, await fetchLastNGames(id, date, 5)); },
  ]);
  await batchedAll(teamTasks, 8);

  // ── Step 4: Head-to-head (one per matchup) ────────────────────────────────
  const h2hMap = new Map<string, HeadToHeadRecord>();
  const h2hTasks = games.map((g) => async () => {
    const hId: number = g.teams.home.team.id;
    const aId: number = g.teams.away.team.id;
    const key = `${hId}-${aId}`;
    h2hMap.set(key, await fetchHeadToHead(hId, aId, season, date));
  });
  await batchedAll(h2hTasks, 8);

  // ── Step 5: Assemble predictions ─────────────────────────────────────────
  return games.map((g: any): PredictedGameV4 => {
    const homeTeam = g.teams.home.team;
    const awayTeam = g.teams.away.team;
    const hs = standings.get(homeTeam.id);
    const as = standings.get(awayTeam.id);
    const hp = g.teams.home.probablePitcher;
    const ap = g.teams.away.probablePitcher;
    const hps = hp ? pitcherStats.get(hp.id) : null;
    const aps = ap ? pitcherStats.get(ap.id) : null;
    const homeEra = hps?.era ?? null;
    const awayEra = aps?.era ?? null;

    const v4Features: V4Features = {
      homeHitting: teamHittingMap.get(homeTeam.id) ?? { obp: null, slg: null, ops: null },
      awayHitting: teamHittingMap.get(awayTeam.id) ?? { obp: null, slg: null, ops: null },
      homePitching: teamPitchingMap.get(homeTeam.id) ?? { era: null, whip: null, kbb: null },
      awayPitching: teamPitchingMap.get(awayTeam.id) ?? { era: null, whip: null, kbb: null },
      homeRest: restMap.get(homeTeam.id) ?? { daysSinceLastGame: 1 },
      awayRest: restMap.get(awayTeam.id) ?? { daysSinceLastGame: 1 },
      homeL5: l5Map.get(homeTeam.id) ?? { wins: 0, losses: 0, pct: 0.5 },
      awayL5: l5Map.get(awayTeam.id) ?? { wins: 0, losses: 0, pct: 0.5 },
      h2h: h2hMap.get(`${homeTeam.id}-${awayTeam.id}`) ?? { homeWins: 0, awayWins: 0, totalGames: 0 },
    };

    // v0.3 prediction
    const v3 = predict({ home: hs, away: as, homeEra, awayEra, venue: g.venue?.name });

    // v0.4 prediction
    const v4 = predictV4({
      home: hs,
      away: as,
      homeEra,
      awayEra,
      homeFip: hps?.fip ?? null,
      awayFip: aps?.fip ?? null,
      venue: g.venue?.name,
      features: v4Features,
    });

    const makeSide = (
      raw: any,
      st: typeof hs,
      pitcher: any,
      ps: typeof hps,
    ): TeamSide => ({
      id: raw.id,
      name: raw.name,
      abbreviation: raw.abbreviation ?? raw.teamCode?.toUpperCase() ?? "",
      record: st ? `${st.wins}-${st.losses}` : "—",
      winPct: st?.winPct ?? 0.5,
      pitcher: pitcher
        ? {
            id: pitcher.id ?? null,
            name: pitcher.fullName ?? "TBD",
            era: ps?.era ?? null,
            wins: ps?.w ?? null,
            losses: ps?.l ?? null,
            fip: ps?.fip ?? null,
            whip: ps?.whip ?? null,
          }
        : null,
    });

    const homeScore: number | null = g.teams.home.score ?? null;
    const awayScore: number | null = g.teams.away.score ?? null;
    const statusStr: string = g.status?.detailedState ?? "Scheduled";
    const isFinal = /final|game over|completed/i.test(statusStr);
    let winner: "home" | "away" | null = null;
    if (isFinal && typeof homeScore === "number" && typeof awayScore === "number" && homeScore !== awayScore) {
      winner = homeScore > awayScore ? "home" : "away";
    }

    return {
      gameId: g.gamePk,
      date: g.gameDate,
      status: statusStr,
      venue: g.venue?.name ?? "—",
      home: makeSide(homeTeam, hs, hp, hps),
      away: makeSide(awayTeam, as, ap, aps),
      homeWinProb: v3.home,       // v0.3 probability (backward-compat)
      awayWinProb: v3.away,
      rationale: v3.rationale,
      homeScore,
      awayScore,
      winner,
      v4WinProb: v4.home,
      v4Rationale: v4.rationale,
      features: v4Features,
    };
  });
}
