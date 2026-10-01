import type { SimLeague } from "@/lib/sim/types";

/** Away and home series colours — the site's validated chart slots 1 and 2,
 *  checked for colour-blind separation and contrast on the card surface. */
export const AWAY_COLOR = "var(--color-chart-1)";
export const HOME_COLOR = "var(--color-chart-2)";
/** A third hue for single-series charts that are about neither team. */
export const NEUTRAL_SERIES = "var(--color-chart-3)";

export const pct = (p: number, digits = 1) => `${(p * 100).toFixed(digits)}%`;

export const signed = (v: number, digits = 1) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;

/** American odds → implied probability (with the vig still in). */
export function impliedProb(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

/** Both moneylines → the market's no-vig home win probability. */
export function noVigHome(homeMl: number | null, awayMl: number | null): number | null {
  if (homeMl == null || awayMl == null) return null;
  const h = impliedProb(homeMl);
  const a = impliedProb(awayMl);
  return h / (h + a);
}

/** Probability → fair American odds. */
export function fairOdds(p: number): string {
  if (p <= 0 || p >= 1) return "—";
  const v = p >= 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
  return v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`;
}

export function spreadText(abbr: string, spread: number): string {
  if (spread === 0) return `${abbr} PK`;
  return `${abbr} ${spread > 0 ? "+" : "−"}${Math.abs(spread)}`;
}

export function kickoff(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export const LEAGUE_LABEL: Record<SimLeague, string> = {
  nfl: "NFL",
  nba: "NBA",
  nhl: "NHL",
  mlb: "MLB",
};

export const PLAY_VERB: Record<SimLeague, string> = {
  nfl: "Kick off",
  nba: "Tip off",
  nhl: "Drop the puck",
  mlb: "Play ball",
};

export const SPORT_NAME: Record<SimLeague, string> = {
  nfl: "football",
  nba: "basketball",
  nhl: "hockey",
  mlb: "baseball",
};

/** Sensible batch sizes per sport — cheap sports can afford more. */
export const BATCH_SIZES = [100, 1000, 5000, 10000];

/** Logos come from ESPN's CDN; if one fails, leave a gap rather than a
 *  broken-image icon. */
export const hideBroken = (e: { currentTarget: HTMLImageElement }) => {
  e.currentTarget.style.visibility = "hidden";
};
