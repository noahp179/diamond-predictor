import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { readLedger } from "./tracking.server";
import { EMPTY_STATS, summarise } from "./ledger-stats";
import { soccerHistory } from "./soccer.server";
import { tennisHistory } from "./tennis.server";
import { isLeagueSlug, LEAGUES, type LeagueSlug } from "./soccer-leagues";
import { isTourSlug, TOURS, type TourSlug } from "./tennis-tours";
import soccerModels from "./soccer-match-model.json";
import tennisModels from "./tennis-match-model.json";

/**
 * The Track Record pages need two numbers side by side and must never confuse
 * them: what the backtest CLAIMED, and what the live ledger has actually
 * recorded since it started. This returns both, plus the sample size, so the
 * page can say "too early to tell" when that is the truth.
 */

const input = z.object({ sport: z.string(), division: z.string() });

type SoccerModel = {
  backtest: { rps: number; acc: number; brier: number; logloss: number; n: number };
};
type TennisModel = {
  backtest: { logloss: number; acc: number; brier: number; auc: number; n: number };
};

const SOCCER = soccerModels as unknown as Record<string, SoccerModel>;
const TENNIS = tennisModels as unknown as Record<string, TennisModel>;

/** How many settled calls before the live rate is worth reading at all. */
export const MEANINGFUL_N = 100;

function claimFor(sport: string, division: string) {
  if (sport === "soccer") {
    const m = SOCCER[division];
    if (!m) return null;
    return {
      accuracy: m.backtest.acc,
      brier: m.backtest.brier,
      logLoss: m.backtest.logloss,
      rps: m.backtest.rps,
      n: m.backtest.n,
    };
  }
  const m = TENNIS[division];
  if (!m) return null;
  return {
    accuracy: m.backtest.acc,
    brier: m.backtest.brier,
    logLoss: m.backtest.logloss,
    rps: null,
    n: m.backtest.n,
  };
}

/** Both server functions normalise their input the same way. */
function resolve(data: { sport: string; division: string }) {
  const sport = data.sport === "tennis" ? "tennis" : "soccer";
  const valid = sport === "soccer" ? isLeagueSlug(data.division) : isTourSlug(data.division);
  const division = valid ? data.division : sport === "soccer" ? "epl" : "atp";
  return { sport, division } as const;
}

/**
 * The model re-run over completed matches — a backtest, served separately.
 *
 * Separate from `getTrackLedger` on purpose. The ledger is a single indexed
 * query and returns in milliseconds; the replay walks a year of results and,
 * on a cold cache, has to fetch them first. Behind one call the whole page
 * would wait on the slow half. Behind two, the ledger and the honest "nothing
 * settled yet" render immediately and the replayed charts fill in after.
 *
 * The page must never present this as a forward record, and does not: it lives
 * under its own heading that says what it is.
 */
export const getReplayedHistory = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const { sport, division } = resolve(data);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const calls =
        sport === "soccer"
          ? await soccerHistory(division as LeagueSlug, today)
          : await tennisHistory(division as TourSlug, today);
      const stats = summarise(calls);
      return { sport, division, ...stats, claim: claimFor(sport, division) };
    } catch (err) {
      // A replay that cannot reach ESPN is a missing chart, not a broken page.
      console.error(`[replay] ${sport} ${division}:`, err);
      return { sport, division, ...EMPTY_STATS, claim: claimFor(sport, division) };
    }
  });

export const getTrackLedger = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const { sport, division } = resolve(data);
    const ledger = await readLedger(sport, division);
    return {
      ...ledger,
      /** What the held-out backtest said to expect. Never mixed into the live numbers. */
      claim: claimFor(sport, division),
      meaningfulN: MEANINGFUL_N,
      divisions:
        sport === "soccer"
          ? LEAGUES.map((l) => ({ slug: l.slug, name: l.name }))
          : TOURS.map((t) => ({ slug: t.slug, name: t.name })),
    };
  });
