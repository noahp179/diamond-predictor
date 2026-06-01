// Static park-factor table (runs index, ~3-year averages from public sources, normalized so 100 = league avg).
// Used as a small hitter-friendliness adjustment to the home win probability.
// Higher = more offense; lower = more pitcher friendly.
export const PARK_FACTORS: Record<string, number> = {
  "Coors Field": 112,
  "Fenway Park": 106,
  "Great American Ball Park": 105,
  "Globe Life Field": 104,
  "Yankee Stadium": 103,
  "Wrigley Field": 102,
  "Citizens Bank Park": 102,
  "Chase Field": 102,
  "Truist Park": 101,
  "Rogers Centre": 101,
  "Kauffman Stadium": 101,
  "Minute Maid Park": 100,
  "Nationals Park": 100,
  "Target Field": 100,
  "American Family Field": 100,
  "loanDepot park": 99,
  "Citi Field": 99,
  "Progressive Field": 99,
  "Comerica Park": 98,
  "PNC Park": 98,
  "Angel Stadium": 98,
  "Busch Stadium": 97,
  "Dodger Stadium": 97,
  "Oracle Park": 95,
  "T-Mobile Park": 95,
  "Petco Park": 95,
  "Oakland Coliseum": 95,
  "Sutter Health Park": 100,
  "Tropicana Field": 96,
  "Steinbrenner Field": 100,
  "Camden Yards": 99,
  "Oriole Park at Camden Yards": 99,
  "Guaranteed Rate Field": 101,
  "Rate Field": 101,
};

export function parkFactor(venue: string | null | undefined): number {
  if (!venue) return 100;
  return PARK_FACTORS[venue] ?? 100;
}