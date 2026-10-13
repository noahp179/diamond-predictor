/**
 * soccer-leagues.ts — the competitions the Soccer tab covers: Europe's big five
 * leagues and the Champions League.
 *
 * Shared by client and server, so route params, model lookups and nav labels
 * all key off one list. `slug` is the URL segment and the model key; `espn` is
 * the competition code in ESPN's public soccer API.
 *
 * Each competition has its own model, its own calibration and its own backtest.
 * Nothing is pooled: home advantage, draw rate and goal supply differ enough
 * between them that a shared fit would be mis-calibrated at both ends of the
 * range (draws run 23.9% in the Premier League against 27.4% in Serie A, and
 * 19% in the Champions League).
 *
 * The Champions League is the odd one out: its clubs come from twenty leagues,
 * so its ratings are a single Elo across all of them (ucl-model.ts) rather than
 * one league replayed on its own. It has a match simulator and no prop models.
 */

export type LeagueSlug = "epl" | "laliga" | "bundesliga" | "seriea" | "ligue1" | "ucl";

export type League = {
  slug: LeagueSlug;
  espn: string;
  name: string;
  short: string;
  country: string;
  /** A domestic league, or a European club competition. */
  kind: "domestic" | "europe";
};

export const LEAGUES: League[] = [
  {
    slug: "epl",
    espn: "eng.1",
    name: "Premier League",
    short: "EPL",
    country: "England",
    kind: "domestic",
  },
  {
    slug: "laliga",
    espn: "esp.1",
    name: "La Liga",
    short: "La Liga",
    country: "Spain",
    kind: "domestic",
  },
  {
    slug: "bundesliga",
    espn: "ger.1",
    name: "Bundesliga",
    short: "Bundesliga",
    country: "Germany",
    kind: "domestic",
  },
  {
    slug: "seriea",
    espn: "ita.1",
    name: "Serie A",
    short: "Serie A",
    country: "Italy",
    kind: "domestic",
  },
  {
    slug: "ligue1",
    espn: "fra.1",
    name: "Ligue 1",
    short: "Ligue 1",
    country: "France",
    kind: "domestic",
  },
  {
    slug: "ucl",
    espn: "uefa.champions",
    name: "Champions League",
    short: "UCL",
    country: "Europe",
    kind: "europe",
  },
];

/** The five domestic leagues — the ones with an `elo_gd` model and prop models. */
export const DOMESTIC_LEAGUES = LEAGUES.filter((l) => l.kind === "domestic");

const BY_SLUG = new Map(LEAGUES.map((l) => [l.slug, l]));

export function isLeagueSlug(s: string): s is LeagueSlug {
  return BY_SLUG.has(s as LeagueSlug);
}

/** The league for a slug, or the Premier League if the slug is unknown. */
export function leagueOf(slug: string): League {
  return BY_SLUG.get(slug as LeagueSlug) ?? LEAGUES[0];
}
