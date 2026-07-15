// mlb-lineup.ts — lineup-derived offense, built properly (a helper, not a model)
//
// Round 4's naïve version — an equal-weight average of the nine starters'
// regressed rates — LOST to the team aggregate (MODEL-ANALYSIS.md): averaging
// shrank the offense's spread and fed a mis-calibrated run environment. This
// rebuild fixes the three specific failures:
//
//   1. PA WEIGHTING — lineup slots don't bat equally: the leadoff hitter gets
//      ~4.65 PA/game, the ninth ~3.81. Each hitter's rates are weighted by his
//      slot's expected PA share instead of 1/9, so putting the best bat second
//      actually matters.
//   2. PLATOON — batters with the handedness advantage vs tonight's starter
//      (L-vs-R, R-vs-L, switch always) hit better by a well-established league
//      margin. Applied as fixed odds multipliers on each hitter's on-base
//      events and strikeouts, scaled to ~60% of PAs (the starter's share —
//      the pen's handedness mix is unknown pre-game). Constants are published
//      league norms, deliberately NOT fit on our data. Batter/pitcher
//      handedness are static facts from the people API — no lookahead.
//   3. ENVIRONMENT NORMALIZATION — the sim's run-environment constants were
//      calibrated for team-aggregate lines. Each slate's lineup lines are
//      re-centered so their PA-weighted league mean equals the team-line
//      league mean, component by component. Self-normalizing — no dev fit.
//
// Lineup availability: the boxscore batting order exists once a lineup is
// posted (~1–4h pre-game) and always for settled games. No lineup → null →
// caller falls back to the team line. All rates end the day before the game.

import { STATS_API, fetchWithTimeout, batchedAll } from "./mlb-core";
import { type BattingRates } from "./mlb-sim";

const HIT_PRIOR_PA = 60; // regress a hitter's per-PA rates toward league
const HIT_MIN_PA = 20; // below this, drop the hitter and lean on the rest

/** Expected PA per game by lineup slot (1-9), normalized to shares below. */
const SLOT_PA = [4.65, 4.55, 4.43, 4.33, 4.24, 4.13, 4.02, 3.92, 3.81];

// League platoon effect as odds multipliers, pre-scaled to the starter's ~60%
// PA share. Published norms (~±6% on-base odds, ∓3% strikeouts vs the starter)
// → effective ±4% / ∓2% over the full game. Fixed constants — never fit here.
const PLATOON_ON_BASE_ADV = 1.04;
const PLATOON_ON_BASE_DIS = 0.96;
const PLATOON_SO_ADV = 0.98;
const PLATOON_SO_DIS = 1.02;

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One hitter's per-PA batting rates over [startDate, endDate], regressed to league. */
async function fetchHitterRates(
  personId: number,
  season: number,
  startDate: string,
  endDate: string,
  lg: BattingRates,
): Promise<BattingRates | null> {
  try {
    const url = `${STATS_API}/people/${personId}/stats?stats=byDateRange&group=hitting&season=${season}&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const splits: any[] = (await res.json())?.stats?.[0]?.splits ?? [];
    if (splits.length === 0) return null;
    const st: any = {};
    for (const k of ["plateAppearances", "hits", "doubles", "triples", "homeRuns", "baseOnBalls", "hitByPitch", "strikeOuts"])
      st[k] = splits.reduce((a, s) => a + (s.stat?.[k] ?? 0), 0);
    const pa = st.plateAppearances ?? 0;
    if (pa < HIT_MIN_PA) return null;
    const reg = (count: number, lgRate: number) => (count + lgRate * HIT_PRIOR_PA) / (pa + HIT_PRIOR_PA);
    const h = st.hits ?? 0, d2 = st.doubles ?? 0, d3 = st.triples ?? 0, hr = st.homeRuns ?? 0;
    return {
      pa,
      bb: reg((st.baseOnBalls ?? 0) + (st.hitByPitch ?? 0), lg.bb),
      so: reg(st.strikeOuts ?? 0, lg.so),
      b1: reg(Math.max(0, h - d2 - d3 - hr), lg.b1),
      b2: reg(d2, lg.b2),
      b3: reg(d3, lg.b3),
      hr: reg(hr, lg.hr),
    };
  } catch {
    return null;
  }
}

/** Boxscore batting order (nine person ids) per side, or [] if not posted yet. */
export async function fetchBattingOrders(gamePk: number): Promise<{ home: number[]; away: number[] }> {
  try {
    const res = await fetchWithTimeout(`${STATS_API}/game/${gamePk}/boxscore`, 20_000);
    if (!res.ok) return { home: [], away: [] };
    const json: any = await res.json();
    const order = (side: "home" | "away"): number[] => {
      const arr = json?.teams?.[side]?.battingOrder ?? [];
      return Array.isArray(arr) ? arr.slice(0, 9) : [];
    };
    return { home: order("home"), away: order("away") };
  } catch {
    return { home: [], away: [] };
  }
}

/** batSide/pitchHand for a set of people (batched; static facts, cacheable forever). */
export async function fetchHandedness(
  ids: number[],
  cache?: Map<number, { bat: string; throw: string }>,
): Promise<Map<number, { bat: string; throw: string }>> {
  const out = new Map<number, { bat: string; throw: string }>();
  const need: number[] = [];
  for (const id of ids) {
    const hit = cache?.get(id);
    if (hit) out.set(id, hit);
    else need.push(id);
  }
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    try {
      const res = await fetchWithTimeout(`${STATS_API}/people?personIds=${chunk.join(",")}`, 20_000);
      if (!res.ok) continue;
      const json: any = await res.json();
      for (const p of json?.people ?? []) {
        const v = { bat: p?.batSide?.code ?? "R", throw: p?.pitchHand?.code ?? "R" };
        out.set(p.id, v);
        cache?.set(p.id, v);
      }
    } catch {
      /* missing ids default to R below */
    }
  }
  return out;
}

/** True when the batter has the platoon advantage vs a pitcher of `hand`. */
function platoonAdvantage(bat: string, hand: string): boolean {
  if (bat === "S") return true; // switch hitter always takes the advantage
  return bat !== hand;
}

function applyPlatoon(r: BattingRates, adv: boolean): BattingRates {
  const ob = adv ? PLATOON_ON_BASE_ADV : PLATOON_ON_BASE_DIS;
  const so = adv ? PLATOON_SO_ADV : PLATOON_SO_DIS;
  return { ...r, bb: r.bb * ob, b1: r.b1 * ob, b2: r.b2 * ob, b3: r.b3 * ob, hr: r.hr * ob, so: r.so * so };
}

/** PA-share-weighted blend of the (up to nine) usable hitters into one line. */
function weightedLineup(rates: Array<BattingRates | null>): BattingRates | null {
  let W = 0;
  const acc = { bb: 0, so: 0, b1: 0, b2: 0, b3: 0, hr: 0, pa: 0 };
  let usable = 0;
  rates.forEach((r, slot) => {
    if (!r) return;
    usable++;
    const w = SLOT_PA[Math.min(slot, SLOT_PA.length - 1)];
    W += w;
    acc.bb += w * r.bb; acc.so += w * r.so; acc.b1 += w * r.b1;
    acc.b2 += w * r.b2; acc.b3 += w * r.b3; acc.hr += w * r.hr;
    acc.pa += r.pa;
  });
  if (usable < 5 || W === 0) return null;
  return { pa: acc.pa, bb: acc.bb / W, so: acc.so / W, b1: acc.b1 / W, b2: acc.b2 / W, b3: acc.b3 / W, hr: acc.hr / W };
}

export interface LineupSide {
  line: BattingRates | null; // platoon-adjusted, pre-normalization
  lineNoPlatoon: BattingRates | null;
}

/**
 * Build lineup offenses for a set of games in one pass, then re-center every
 * line so the slate's PA-weighted league mean matches `lg` component-wise
 * (fix #3). Returns per gamePk → { home, away }, each with platoon-adjusted
 * and platoon-free variants (the collector records both so the platoon
 * constants can be judged without refitting).
 *
 * @param starters  gamePk → { homeHand, awayHand } (the OPPOSING starter's hand
 *                  is what each lineup faces).
 * @param windowDays  trailing window for hitter rates; omit for season-to-date.
 */
export async function buildLineupOffenses(
  games: Array<{ gamePk: number }>,
  starters: Map<number, { homeHand: string | null; awayHand: string | null }>,
  season: number,
  date: string,
  lg: BattingRates,
  windowDays?: number,
  handednessCache?: Map<number, { bat: string; throw: string }>,
): Promise<Map<number, { home: LineupSide; away: LineupSide }>> {
  const endDate = addDaysISO(date, -1);
  const startDate = windowDays ? addDaysISO(date, -windowDays) : `${season}-03-01`;

  // 1. Batting orders for every game.
  const orders = new Map<number, { home: number[]; away: number[] }>();
  await batchedAll(
    games.map((g) => async () => {
      orders.set(g.gamePk, await fetchBattingOrders(g.gamePk));
    }),
    6,
  );

  // 2. Rates + handedness for every distinct hitter.
  const ids = new Set<number>();
  for (const o of orders.values()) for (const id of [...o.home, ...o.away]) ids.add(id);
  const rateById = new Map<number, BattingRates | null>();
  await batchedAll(
    Array.from(ids).map((id) => async () => {
      rateById.set(id, await fetchHitterRates(id, season, startDate, endDate, lg));
    }),
    10,
  );
  const hands = await fetchHandedness(Array.from(ids), handednessCache);

  // 3. Raw lines per side, platoon-adjusted and not.
  const raw = new Map<number, { home: LineupSide; away: LineupSide }>();
  for (const g of games) {
    const o = orders.get(g.gamePk) ?? { home: [], away: [] };
    const st = starters.get(g.gamePk) ?? { homeHand: null, awayHand: null };
    const side = (idsArr: number[], oppHand: string | null): LineupSide => {
      const base = idsArr.map((id) => rateById.get(id) ?? null);
      const noP = weightedLineup(base);
      if (!oppHand) return { line: noP, lineNoPlatoon: noP };
      const adj = idsArr.map((id, slot) => {
        const r = base[slot];
        if (!r) return null;
        const bat = hands.get(id)?.bat ?? "R";
        return applyPlatoon(r, platoonAdvantage(bat, oppHand));
      });
      return { line: weightedLineup(adj), lineNoPlatoon: noP };
    };
    raw.set(g.gamePk, {
      home: side(o.home, st.awayHand), // home lineup faces the AWAY starter
      away: side(o.away, st.homeHand),
    });
  }

  // 4. Environment normalization: re-center each variant so the slate's mean
  //    equals the team-line league mean, component by component (fix #3).
  const normalize = (pick: (s: LineupSide) => BattingRates | null, write: (s: LineupSide, r: BattingRates) => void) => {
    const lines: BattingRates[] = [];
    for (const v of raw.values()) {
      const h = pick(v.home), a = pick(v.away);
      if (h) lines.push(h);
      if (a) lines.push(a);
    }
    if (lines.length < 6) return; // tiny slates: leave un-normalized rather than over-correct
    const mean = (f: (r: BattingRates) => number) => lines.reduce((s, r) => s + f(r), 0) / lines.length;
    const ratio = {
      bb: lg.bb / (mean((r) => r.bb) || lg.bb),
      so: lg.so / (mean((r) => r.so) || lg.so),
      b1: lg.b1 / (mean((r) => r.b1) || lg.b1),
      b2: lg.b2 / (mean((r) => r.b2) || lg.b2),
      b3: lg.b3 / (mean((r) => r.b3) || lg.b3),
      hr: lg.hr / (mean((r) => r.hr) || lg.hr),
    };
    for (const v of raw.values()) {
      for (const s of [v.home, v.away]) {
        const r = pick(s);
        if (!r) continue;
        write(s, {
          pa: r.pa,
          bb: r.bb * ratio.bb, so: r.so * ratio.so, b1: r.b1 * ratio.b1,
          b2: r.b2 * ratio.b2, b3: r.b3 * ratio.b3, hr: r.hr * ratio.hr,
        });
      }
    }
  };
  normalize((s) => s.line, (s, r) => (s.line = r));
  normalize((s) => s.lineNoPlatoon, (s, r) => (s.lineNoPlatoon = r));

  return raw;
}
