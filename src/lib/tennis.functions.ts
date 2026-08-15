import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { tennisModelFor, tennisSlate } from "./tennis.server";
import { isTourSlug, TOURS, type TourSlug } from "./tennis-tours";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const input = z.object({ tour: z.string().optional(), date: z.string().optional() }).optional();
const slugOf = (s: string | undefined): TourSlug => (s && isTourSlug(s) ? s : "atp");

export const getTennisSlate = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const tour = slugOf(data?.tour);
    const date = data?.date ?? todayISO();
    const model = tennisModelFor(tour);
    try {
      const slate = await tennisSlate(tour, date);
      return {
        ...slate,
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
