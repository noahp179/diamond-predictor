import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { matchModelFor, soccerSlate } from "./soccer.server";
import { propsModelFor, soccerProps } from "./soccer-props.server";
import { LEAGUES, isLeagueSlug, type LeagueSlug } from "./soccer-leagues";
import { withViewer } from "./viewer";
import { canSeeProps, predictionAllowance, redact } from "./entitlements";

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
  .middleware([withViewer])
  .inputValidator(input)
  .handler(async ({ data, context }) => {
    const league = slugOf(data?.league);
    const date = data?.date ?? todayISO();
    const { tier } = context.viewer;
    try {
      const slate = await soccerSlate(league, date);
      const model = matchModelFor(league);
      // Redaction happens HERE, before serialisation. A locked fixture leaves
      // with its probabilities stripped, so they are not in the payload at all.
      const gated = redact(
        slate.matches,
        tier,
        (m) => (m.probs ? Math.max(m.probs.home, m.probs.draw, m.probs.away) : null),
        (m) => ({ ...m, probs: null, ratingGap: null }),
      );
      return {
        ...slate,
        matches: gated.items,
        tier,
        lockedCount: gated.lockedCount,
        allowance: gated.allowance,
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
        tier,
        lockedCount: 0,
        allowance: predictionAllowance(tier),
        source: "error" as const,
      };
    }
  });

// -------------------------------------------------------------------- props

export const getSoccerProps = createServerFn({ method: "GET" })
  .middleware([withViewer])
  .inputValidator(input)
  .handler(async ({ data, context }) => {
    const league = slugOf(data?.league);
    const date = data?.date ?? todayISO();
    const { tier } = context.viewer;
    // Props are premium, always. Nothing is fetched and nothing is returned —
    // there is no partial version of this to leak.
    if (!canSeeProps(tier)) {
      return {
        league,
        date,
        fixtures: [],
        markets: [],
        tier,
        locked: true as const,
        note: null,
        source: "locked" as const,
      };
    }
    try {
      return {
        ...(await soccerProps(league, date)),
        tier,
        locked: false as const,
        source: "live" as const,
      };
    } catch (err) {
      console.error(`[soccerProps] ${league} ${date}:`, err);
      return {
        league,
        date,
        fixtures: [],
        markets: [],
        note: "Could not build player form from ESPN just now. Try refreshing in a moment.",
        tier,
        locked: false as const,
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
