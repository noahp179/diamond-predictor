import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { matchModelFor, soccerSlate } from "./soccer.server";
import { propsModelFor, soccerProps } from "./soccer-props.server";
import { DOMESTIC_LEAGUES, isLeagueSlug, type LeagueSlug } from "./soccer-leagues";
import { uclClubs, uclHistoryRows, uclSlate, uclSquad } from "./ucl.server";

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
    if (league === "ucl") {
      return {
        league,
        date,
        fixtures: [],
        markets: [],
        note: "The Champions League has no player-prop models — its clubs come from twenty leagues and ESPN's shot data covers five. The Simulate page prices goalscorers instead.",
        source: "error" as const,
      };
    }
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
    // The Champions League's model page reads ucl-model.json directly.
    const league = slugOf(data?.league) === "ucl" ? "epl" : slugOf(data?.league);
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
      leagues: DOMESTIC_LEAGUES,
    };
  });

// --------------------------------------------------------- Champions League

const dateInput = z.object({ date: z.string().optional() }).optional();

/**
 * Everything the Champions League simulator needs for a date: the fixtures
 * with each side's live rating and goal rate, ESPN's posted prices, and every
 * club in this season's competition for building a matchup of your own. The
 * matches are played in the browser; the server only gathers ratings.
 */
export const getUclSimData = createServerFn({ method: "GET" })
  .inputValidator(dateInput)
  .handler(async ({ data }) => {
    const date = data?.date ?? todayISO();
    try {
      const [slate, clubs] = await Promise.all([uclSlate(date), uclClubs(date)]);
      return { date, slate, clubs, note: null as string | null };
    } catch (err) {
      console.error(`[uclSimData] ${date}:`, err);
      return {
        date,
        slate: null,
        clubs: [],
        note: "ESPN's soccer feed is unreachable right now. Try refreshing in a moment.",
      };
    }
  });

/** One club's goalscorers as shares of its goals, for the simulator. */
export const getUclSquad = createServerFn({ method: "GET" })
  .inputValidator(z.object({ teamId: z.string().regex(/^\d+$/) }))
  .handler(async ({ data }) => uclSquad(data.teamId));

/**
 * The replayed record: every Champions League match since 2017-18 as the model
 * priced it that morning, with what actually happened.
 */
export const getUclRecord = createServerFn({ method: "GET" }).handler(async () => {
  const rows = await uclHistoryRows(todayISO()).catch((err) => {
    console.error("[uclRecord]", err);
    return [];
  });
  return { rows };
});
