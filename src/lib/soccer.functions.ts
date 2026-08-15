import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { matchModelFor, soccerSlate } from "./soccer.server";
import { propsModelFor, soccerProps } from "./soccer-props.server";
import { LEAGUES, isLeagueSlug, type LeagueSlug } from "./soccer-leagues";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const input = z.object({ league: z.string().optional(), date: z.string().optional() }).optional();

const slugOf = (s: string | undefined): LeagueSlug => (s && isLeagueSlug(s) ? s : "epl");

/** Season label a fan would recognise: ESPN's 2025 is the 2025-26 campaign. */
function seasonLabel(season: number) {
  return `${season}-${String((season + 1) % 100).padStart(2, "0")}`;
}

// -------------------------------------------------------------- match slate

export const getSoccerSlate = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const league = slugOf(data?.league);
    const date = data?.date ?? todayISO();
    try {
      const slate = await soccerSlate(league, date);
      const model = matchModelFor(league);
      return {
        ...slate,
        seasonLabel: seasonLabel(slate.season),
        backtest: model.backtest,
        priors: model.priors,
        name: model.name,
        note: slate.matches.length === 0 ? "No fixtures scheduled for this date." : null,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[soccerSlate] ${league} ${date}:`, err);
      const model = matchModelFor(league);
      return {
        league,
        date,
        matches: [],
        table: [],
        season: 0,
        seasonLabel: "",
        backtest: model.backtest,
        priors: model.priors,
        name: model.name,
        note: "ESPN's soccer scoreboard is unreachable right now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// -------------------------------------------------------------------- props

export const getSoccerProps = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const league = slugOf(data?.league);
    const date = data?.date ?? todayISO();
    try {
      return { ...(await soccerProps(league, date)), source: "live" as const };
    } catch (err) {
      console.error(`[soccerProps] ${league} ${date}:`, err);
      return {
        league,
        date,
        fixtures: [],
        markets: [],
        note: "Could not build player form from ESPN just now. Try refreshing in a moment.",
        source: "error" as const,
      };
    }
  });

// --------------------------------------------------- model + backtest report

/**
 * Everything the Model page shows. This is static — it comes from the frozen
 * model files, not from a live fetch — so it renders instantly and always
 * matches the numbers the site actually predicts with.
 */
export const getSoccerModelCard = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const league = slugOf(data?.league);
    const match = matchModelFor(league);
    const props = propsModelFor(league);
    return {
      league,
      name: match.name,
      algorithm: match.algorithm,
      elo: match.elo,
      backtest: match.backtest,
      priors: match.priors,
      markets: Object.entries(props.markets).map(([key, m]) => ({
        key,
        label: m.label,
        auc: m.auc,
        base: m.base,
        logloss: m.logloss,
        top1: m.top1,
        top5: m.top5,
        n: m.n,
        tiers: m.tiers,
      })),
      leagues: LEAGUES,
    };
  });
