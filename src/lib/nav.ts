/**
 * nav.ts — the site's information architecture, in one place.
 *
 * This file exists because the navigation stopped being small. Four sports, one
 * of which has five leagues, and between them twenty-eight pages. When each
 * component kept its own copy of the route table, a new page meant editing
 * three of them and forgetting the fourth.
 *
 * So the shape of the site is declared once here and every navigation surface
 * reads from it: the sport switcher, the view tabs, the league bar and the
 * landing page. Adding a page means adding a line to this file.
 *
 * The URL grammar it enforces:
 *
 *     /                              the hub — today, across everything
 *     /<sport>                       that sport's slate
 *     /<sport>/<view>                a view within the sport
 *     /soccer/<league>               a competition's fixtures
 *     /soccer/<league>/<view>        a view within one competition
 *     /teams                         cross-sport, sits outside the grammar
 *
 * MLB used to live at the root (`/`, `/model`, `/best-odds`, `/props`,
 * `/history`) from when it was the only sport. Those paths still work — see
 * LEGACY_REDIRECTS — but they are no longer where the pages are.
 */

import { LEAGUES, type LeagueSlug } from "./soccer-leagues";

export type SportKey = "mlb" | "nfl" | "nba" | "soccer";

export type ViewKey =
  | "slate"
  | "recommended"
  | "bestOdds"
  | "props"
  | "tdScorers"
  | "trackRecord"
  | "model";

export type NavItem = { key: ViewKey; label: string; href: string };

export type SportNav = {
  key: SportKey;
  label: string;
  /** One line for the hub card — what this section actually gives you. */
  blurb: string;
  /** Landing route for the sport. */
  href: string;
  /** True when the sport is split into competitions (soccer only, so far). */
  leagued: boolean;
};

export const SPORTS: SportNav[] = [
  {
    key: "mlb",
    label: "MLB",
    blurb: "Win probabilities, the day's parlay, and sixteen player-prop markets.",
    href: "/mlb",
    leagued: false,
  },
  {
    key: "nfl",
    label: "NFL",
    blurb: "Margin-of-victory Elo across the slate, plus touchdown scorers.",
    href: "/nfl",
    leagued: false,
  },
  {
    key: "nba",
    label: "NBA",
    blurb: "Margin-of-victory Elo across the slate, with the market alongside.",
    href: "/nba",
    leagued: false,
  },
  {
    key: "soccer",
    label: "Soccer",
    blurb: "Europe's big five — each league its own model, calibration and backtest.",
    href: "/soccer",
    leagued: true,
  },
];

const SPORT_BY_KEY = new Map(SPORTS.map((s) => [s.key, s]));

export function sportOf(key: string): SportNav | undefined {
  return SPORT_BY_KEY.get(key as SportKey);
}

/** Labels are shared; which views exist is per sport. */
const LABELS: Record<ViewKey, string> = {
  slate: "Slate",
  recommended: "Recommended",
  bestOdds: "Best Odds",
  props: "Player Props",
  tdScorers: "TD Scorers",
  trackRecord: "Track Record",
  model: "Model & Backtest",
};

const VIEWS: Record<SportKey, ViewKey[]> = {
  mlb: ["slate", "recommended", "bestOdds", "props", "trackRecord"],
  nfl: ["slate", "recommended", "bestOdds", "tdScorers", "trackRecord"],
  nba: ["slate", "recommended", "bestOdds", "trackRecord"],
  soccer: ["slate", "props", "model"],
};

/** Path segment for a view; the slate is the section index, so it has none. */
const SEGMENT: Record<ViewKey, string> = {
  slate: "",
  recommended: "recommended",
  bestOdds: "best-odds",
  props: "props",
  tdScorers: "td-scorers",
  trackRecord: "track-record",
  model: "model",
};

/** Soccer's slate tab is called Matches — "slate" is a North American word. */
const SOCCER_LABELS: Partial<Record<ViewKey, string>> = { slate: "Matches" };

/**
 * The route for one view. A leagued sport needs its competition, because
 * `/soccer/props` is not a page — the model is per league, so the league is
 * part of the address rather than a filter on top of it.
 */
export function viewHref(sport: SportKey, view: ViewKey, league?: LeagueSlug): string {
  const base = sport === "soccer" ? `/soccer/${league ?? LEAGUES[0].slug}` : `/${sport}`;
  const seg = SEGMENT[view];
  return seg ? `${base}/${seg}` : base;
}

/** Every view in a sport, in tab order, with hrefs already resolved. */
export function viewsFor(sport: SportKey, league?: LeagueSlug): NavItem[] {
  return VIEWS[sport].map((key) => ({
    key,
    label: (sport === "soccer" ? SOCCER_LABELS[key] : undefined) ?? LABELS[key],
    href: viewHref(sport, key, league),
  }));
}

export { LEAGUES };
export type { LeagueSlug };

/**
 * Paths kept alive from when MLB was the whole site. Each one redirects to its
 * new home rather than 404ing, because they are in people's bookmarks and in
 * whatever they have shared. They are cheap to keep and expensive to break.
 */
export const LEGACY_REDIRECTS: { from: string; to: string }[] = [
  { from: "/model", to: "/mlb/recommended" },
  { from: "/best-odds", to: "/mlb/best-odds" },
  { from: "/props", to: "/mlb/props" },
  { from: "/history", to: "/mlb/track-record" },
];
