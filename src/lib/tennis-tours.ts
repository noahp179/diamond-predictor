/**
 * tennis-tours.ts — the two tours the Tennis tab covers.
 *
 * Same shape as soccer-leagues.ts, and for the same reason: each tour is a
 * separate model with a separate fit and a separate backtest, so the tour is
 * part of the address rather than a filter on top of one.
 *
 * ESPN publishes both singles draws in both tour feeds, so `grouping` is what
 * actually selects a tour's matches, not the feed name.
 */

export type TourSlug = "atp" | "wta";

export type Tour = {
  slug: TourSlug;
  espn: string;
  name: string;
  long: string;
  /** Which grouping in the ESPN feed holds this tour's singles draw. */
  grouping: string;
};

export const TOURS: Tour[] = [
  { slug: "atp", espn: "atp", name: "ATP", long: "Men's singles", grouping: "mens-singles" },
  { slug: "wta", espn: "wta", name: "WTA", long: "Women's singles", grouping: "womens-singles" },
];

const BY_SLUG = new Map(TOURS.map((t) => [t.slug, t]));

export function isTourSlug(s: string): s is TourSlug {
  return BY_SLUG.has(s as TourSlug);
}

/** The tour for a slug, or the ATP if the slug is unknown. */
export function tourOf(slug: string): Tour {
  return BY_SLUG.get(slug as TourSlug) ?? TOURS[0];
}

/**
 * Surface for a tournament name.
 *
 * ESPN's tennis feed has no surface field, so this mirrors the table in
 * research/tennis/tours.py. Only the patterns that matter for a live slate are
 * carried here — the Slams, the 1000-tier and the clear clay and grass swings.
 * Anything unmatched is "unknown", which the model treats as its own surface
 * rather than pretending it is hard court.
 *
 * Kept deliberately short: surface enters the model as one feature among twenty
 * and is worth about 0.0017 log loss (see SOCCER-style ablation in
 * research/tennis/ablate_tennis.py), so a missed label costs little. Splitting
 * ratings BY surface was tested and is worse than not doing it.
 */
const SURFACE_PATTERNS: [string, Surface][] = [
  ["roland garros", "clay"],
  ["french open", "clay"],
  ["wimbledon", "grass"],
  ["australian open", "hard"],
  ["us open", "hard"],
  ["monte-carlo", "clay"],
  ["madrid open", "clay"],
  ["internazionali bnl", "clay"],
  ["barcelona open", "clay"],
  ["hamburg", "clay"],
  ["rome", "clay"],
  ["estoril", "clay"],
  ["munich", "clay"],
  ["bmw open", "clay"],
  ["gstaad", "clay"],
  ["umag", "clay"],
  ["bastad", "clay"],
  ["kitzbuhel", "clay"],
  ["generali open", "clay"],
  ["geneva open", "clay"],
  ["strasbourg", "clay"],
  ["charleston", "clay"],
  ["argentina open", "clay"],
  ["rio open", "clay"],
  ["chile open", "clay"],
  ["cordoba open", "clay"],
  ["porsche tennis grand prix", "clay"],
  ["hsbc championships", "grass"],
  ["terra wortmann", "grass"],
  ["libéma open", "grass"],
  ["boss open", "grass"],
  ["mallorca", "grass"],
  ["eastbourne", "grass"],
  ["birmingham", "grass"],
  ["nottingham", "grass"],
  ["ilkley", "grass"],
  ["bad homburg", "grass"],
  ["berlin tennis open", "grass"],
  ["hall of fame open", "grass"],
  ["bnp paribas open", "hard"],
  ["miami open", "hard"],
  ["cincinnati open", "hard"],
  ["western & southern", "hard"],
  ["national bank open", "hard"],
  ["shanghai masters", "hard"],
  ["paris masters", "hard"],
  ["nitto atp finals", "hard"],
  ["wta finals", "hard"],
  ["china open", "hard"],
  ["wuhan open", "hard"],
  ["dubai duty free", "hard"],
  ["qatar", "hard"],
  ["brisbane international", "hard"],
  ["asb classic", "hard"],
  ["adelaide international", "hard"],
  ["hobart international", "hard"],
  ["abierto mexicano", "hard"],
  ["delray beach", "hard"],
  ["dallas open", "hard"],
  ["winston-salem", "hard"],
  ["citi open", "hard"],
  ["mubadala", "hard"],
  ["abn amro", "hard"],
  ["erste bank open", "hard"],
  ["swiss indoors", "hard"],
  ["japan open", "hard"],
  ["korea open", "hard"],
  ["toray pan pacific", "hard"],
  ["olympics", "clay"],
];

export type Surface = "hard" | "clay" | "grass" | "unknown";

export function surfaceOf(tournament: string): Surface {
  const low = (tournament ?? "").toLowerCase();
  // Longest pattern first so a short one cannot shadow a more specific match.
  let best: Surface = "unknown";
  let bestLen = 0;
  for (const [pat, surf] of SURFACE_PATTERNS) {
    if (pat.length > bestLen && low.includes(pat)) {
      best = surf;
      bestLen = pat.length;
    }
  }
  return best;
}
