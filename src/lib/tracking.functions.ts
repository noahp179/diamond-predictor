import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { readLedger } from "./tracking.server";
import { isLeagueSlug, LEAGUES } from "./soccer-leagues";
import { isTourSlug, TOURS } from "./tennis-tours";
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
  // NFL and NBA never had a held-out backtest to claim: their old Track Record
  // pages replayed recent seasons and reported that as the record. There is no
  // honest number to put in the "claimed" column, so the column stays empty
  // rather than being filled with the replay it just replaced.
  if (sport === "nfl" || sport === "nba") return null;
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

/**
 * Normalise the request.
 *
 * NFL and NBA have no divisions, so their division IS the sport — one ledger
 * slice each. Soccer and tennis fall back to a default slug rather than
 * trusting the URL, since an unknown division would otherwise read as an empty
 * ledger and look identical to "nothing has settled".
 */
function resolve(data: { sport: string; division: string }) {
  if (data.sport === "nfl" || data.sport === "nba") {
    return { sport: data.sport, division: data.sport } as const;
  }
  const sport = data.sport === "tennis" ? "tennis" : "soccer";
  const valid = sport === "soccer" ? isLeagueSlug(data.division) : isTourSlug(data.division);
  const division = valid ? data.division : sport === "soccer" ? "epl" : "atp";
  return { sport, division } as const;
}

export const getTrackLedger = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const { sport, division } = resolve(data);
    const ledger = await readLedger(sport, division, "forward");
    return {
      ...ledger,
      /** What the held-out backtest said to expect. Never mixed into the live numbers. */
      claim: claimFor(sport, division),
      meaningfulN: MEANINGFUL_N,
      divisions:
        sport === "soccer"
          ? LEAGUES.map((l) => ({ slug: l.slug, name: l.name }))
          : sport === "tennis"
            ? TOURS.map((t) => ({ slug: t.slug, name: t.name }))
            : [],
    };
  });
