import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { tennisModelFor, tennisSlate } from "./tennis.server";
import { isTourSlug, TOURS, type TourSlug } from "./tennis-tours";
import { withViewer } from "./viewer";
import { predictionAllowance, redact } from "./entitlements";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const input = z.object({ tour: z.string().optional(), date: z.string().optional() }).optional();
const slugOf = (s: string | undefined): TourSlug => (s && isTourSlug(s) ? s : "atp");

export const getTennisSlate = createServerFn({ method: "GET" })
  .middleware([withViewer])
  .inputValidator(input)
  .handler(async ({ data, context }) => {
    const tour = slugOf(data?.tour);
    const date = data?.date ?? todayISO();
    const model = tennisModelFor(tour);
    const { tier } = context.viewer;
    try {
      const slate = await tennisSlate(tour, date);
      // Confidence for a two-way market is the distance from a coin flip, so a
      // 12% call is as "sure" as an 88% one — it is the same conviction, stated
      // about the other player.
      const gated = redact(
        slate.matches,
        tier,
        (m) => (m.probA == null ? null : Math.max(m.probA, 1 - m.probA)),
        (m) => ({ ...m, probA: null, eloGap: null }),
      );
      return {
        ...slate,
        matches: gated.items,
        tier,
        lockedCount: gated.lockedCount,
        allowance: gated.allowance,
        name: model.name,
        backtest: model.backtest,
        note:
          slate.matches.length === 0
            ? "No completed or scheduled singles matches on this date. The tour does not play every day, and between tournaments there is nothing to price."
            : null,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[tennisSlate] ${tour} ${date}:`, err);
      return {
        tour,
        date,
        matches: [],
        table: [],
        tournaments: [],
        name: model.name,
        backtest: model.backtest,
        note: "ESPN's tennis scoreboard is unreachable right now. Try refreshing in a moment.",
        tier,
        lockedCount: 0,
        allowance: predictionAllowance(tier),
        source: "error" as const,
      };
    }
  });

/**
 * The model card. Static — it reads the frozen model file rather than fetching,
 * so it renders instantly and always matches what the site predicts with.
 */
export const getTennisModelCard = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const tour = slugOf(data?.tour);
    const m = tennisModelFor(tour);
    return {
      tour,
      name: m.name,
      algorithm: m.algorithm,
      features: m.features,
      /** Standardised coefficients: comparable to each other, so they rank. */
      weights: m.features.map((f, i) => ({ feature: f, coef: m.coef[i] })),
      backtest: m.backtest,
      priors: m.priors,
      tours: TOURS,
    };
  });
