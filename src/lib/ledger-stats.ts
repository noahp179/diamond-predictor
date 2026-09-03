/**
 * ledger-stats.ts — turn a list of scored calls into the numbers a Track Record
 * page draws.
 *
 * Two very different things feed this, and they must be aggregated identically
 * or the page would be comparing apples to a slightly different shape of apple:
 *
 *   LIVE      rows from `event_predictions` — written the morning of an event,
 *             scored after it. The real forward record.
 *   REPLAYED  the model re-run over completed matches, scoring each one using
 *             only what was known before it. Available immediately, because the
 *             matches already happened.
 *
 * The replay is NOT a forward record and the page never calls it one. It is a
 * backtest over recent results — the same thing the NFL and NBA pages have
 * always shown. It is here because a page that says "come back in three months"
 * teaches a reader nothing about whether the model works, and the honest fix is
 * to show both and label which is which.
 *
 * The one property the replay must have to be worth anything: no leakage. Every
 * match is scored with the ratings as they stood BEFORE it, then folded in.
 * That is enforced at the source in soccer.server.ts and tennis.server.ts,
 * where the score is taken before the update.
 */

export type ScoredCall = {
  date: string;
  /** Probability assigned to the side the model picked. */
  pickProb: number;
  correct: boolean;
  brier: number;
  logLoss: number;
  rps: number | null;
};

export type Summary = {
  n: number;
  correct: number;
  accuracy: number | null;
  brier: number | null;
  logLoss: number | null;
  rps: number | null;
  firstDate: string | null;
  lastDate: string | null;
};

export type Stats = {
  summary: Summary;
  /** Accuracy by confidence bucket — the check a hit rate alone cannot make. */
  calibration: Bucket[];
  /** Cumulative accuracy and Brier, oldest call first. */
  running: { i: number; date: string; accuracy: number; brier: number }[];
  /** One row per day that settled anything, oldest first. */
  daily: { date: string; n: number; correct: number; accuracy: number; brier: number }[];
};

/**
 * Confidence buckets.
 *
 * They start at 50% because a two-way pick is by definition the side above the
 * coin flip; a three-way pick can sit below it, so anything under 50% falls in
 * the first bucket rather than being dropped.
 */
const BANDS: [number, number, string][] = [
  [0, 0.55, "<55%"],
  [0.55, 0.65, "55-65%"],
  [0.65, 0.75, "65-75%"],
  [0.75, 0.85, "75-85%"],
  [0.85, 1.01, "85%+"],
];

export type Bucket = {
  band: string;
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  actual: number;
};

/**
 * Accuracy by confidence bucket.
 *
 * Takes the bare minimum — how sure the model was, and whether it was right —
 * so the same bucketing serves the soccer/tennis ledger, the soccer/tennis
 * replay and the NFL/NBA season replay. Those three compute their probabilities
 * in completely different code; sharing the buckets is what makes the charts
 * comparable rather than merely similar-looking.
 *
 * Empty buckets are dropped. A bar of height zero over "no calls" reads as "it
 * never got one right", which is the opposite of what it means.
 */
export function bucketise(calls: { pickProb: number; correct: boolean }[]): Bucket[] {
  return BANDS.map(([lo, hi, band]) => {
    const inBand = calls.filter((c) => c.pickProb >= lo && c.pickProb < hi);
    return {
      band,
      lo,
      hi,
      n: inBand.length,
      predicted: inBand.length ? inBand.reduce((a, c) => a + c.pickProb, 0) / inBand.length : 0,
      actual: inBand.length ? inBand.filter((c) => c.correct).length / inBand.length : 0,
    };
  }).filter((b) => b.n > 0);
}

export const EMPTY_STATS: Stats = {
  summary: {
    n: 0,
    correct: 0,
    accuracy: null,
    brier: null,
    logLoss: null,
    rps: null,
    firstDate: null,
    lastDate: null,
  },
  calibration: [],
  running: [],
  daily: [],
};

/** `calls` may arrive in any order; everything below sorts oldest-first itself. */
export function summarise(calls: ScoredCall[]): Stats {
  if (calls.length === 0) return EMPTY_STATS;

  const chrono = [...calls].sort((a, b) => a.date.localeCompare(b.date));
  const n = chrono.length;
  const correct = chrono.filter((c) => c.correct).length;

  const mean = (f: (c: ScoredCall) => number | null) => {
    const vals = chrono.map(f).filter((v): v is number => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  let hits = 0;
  let brierSum = 0;
  const running = chrono.map((c, i) => {
    hits += c.correct ? 1 : 0;
    brierSum += c.brier;
    return { i: i + 1, date: c.date, accuracy: hits / (i + 1), brier: brierSum / (i + 1) };
  });

  const byDay = new Map<string, { n: number; correct: number; brier: number }>();
  for (const c of chrono) {
    const d = byDay.get(c.date) ?? { n: 0, correct: 0, brier: 0 };
    d.n += 1;
    d.correct += c.correct ? 1 : 0;
    d.brier += c.brier;
    byDay.set(c.date, d);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date,
      n: d.n,
      correct: d.correct,
      accuracy: d.correct / d.n,
      brier: d.brier / d.n,
    }));

  return {
    summary: {
      n,
      correct,
      accuracy: correct / n,
      brier: mean((c) => c.brier),
      logLoss: mean((c) => c.logLoss),
      rps: mean((c) => c.rps),
      firstDate: chrono[0].date,
      lastDate: chrono[n - 1].date,
    },
    calibration: bucketise(chrono),
    running,
    daily,
  };
}

/**
 * Score one outcome.
 *
 * Brier is the multiclass form so a two-way and a three-way market land on the
 * same scale. RPS is three-way only, because it needs the outcomes ORDERED —
 * home > draw > away is an ordering; player A > player B is not.
 */
export function scoreOutcome(
  probs: { a: number; draw: number | null; b: number },
  result: "a" | "draw" | "b",
) {
  const three = probs.draw != null;
  const vec = three ? [probs.a, probs.draw!, probs.b] : [probs.a, probs.b];
  const keys: ("a" | "draw" | "b")[] = three ? ["a", "draw", "b"] : ["a", "b"];
  const truth = keys.map((k) => (k === result ? 1 : 0));

  const brier = vec.reduce((s, p, i) => s + (p - truth[i]) ** 2, 0);
  const pAct = Math.min(1 - 1e-9, Math.max(1e-9, vec[keys.indexOf(result)]));
  const logLoss = -Math.log(pAct);

  let rps: number | null = null;
  if (three) {
    let cp = 0;
    let cy = 0;
    let acc = 0;
    for (let i = 0; i < vec.length - 1; i += 1) {
      cp += vec[i];
      cy += truth[i];
      acc += (cp - cy) ** 2;
    }
    rps = acc;
  }
  return { brier, logLoss, rps };
}

/** Which outcome the model leaned on, and how strongly. */
export function pickOf(probs: { a: number; draw: number | null; b: number }) {
  const d = probs.draw ?? -1;
  const pick: "a" | "draw" | "b" =
    probs.a >= d && probs.a >= probs.b ? "a" : probs.b >= d ? "b" : "draw";
  const pickProb = pick === "a" ? probs.a : pick === "b" ? probs.b : (probs.draw ?? 0);
  return { pick, pickProb };
}
