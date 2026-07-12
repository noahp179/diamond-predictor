// stadium-geo.ts — coordinates and UTC offsets for MLB parks, keyed by the
// venue names the Stats API uses (same keys as park-factors.ts, plus aliases
// for renamed venues). Used by the context layer for travel distance and
// time-zone-shift features. Approximate coordinates are fine — the model
// consumes distance at the hundreds-of-km scale.

export interface StadiumGeo {
  lat: number;
  lon: number;
  /** Standard-time UTC offset; only *differences* matter to the model. */
  utcOffset: number;
}

export const STADIUM_GEO: Record<string, StadiumGeo> = {
  "Angel Stadium": { lat: 33.8003, lon: -117.8827, utcOffset: -8 },
  "Chase Field": { lat: 33.4453, lon: -112.0667, utcOffset: -7 },
  "Truist Park": { lat: 33.8908, lon: -84.4678, utcOffset: -5 },
  "Oriole Park at Camden Yards": { lat: 39.2838, lon: -76.6216, utcOffset: -5 },
  "Camden Yards": { lat: 39.2838, lon: -76.6216, utcOffset: -5 },
  "Fenway Park": { lat: 42.3467, lon: -71.0972, utcOffset: -5 },
  "Wrigley Field": { lat: 41.9484, lon: -87.6553, utcOffset: -6 },
  "Guaranteed Rate Field": { lat: 41.83, lon: -87.6338, utcOffset: -6 },
  "Rate Field": { lat: 41.83, lon: -87.6338, utcOffset: -6 },
  "Great American Ball Park": { lat: 39.0975, lon: -84.5066, utcOffset: -5 },
  "Progressive Field": { lat: 41.4962, lon: -81.6852, utcOffset: -5 },
  "Coors Field": { lat: 39.7559, lon: -104.9942, utcOffset: -7 },
  "Comerica Park": { lat: 42.339, lon: -83.0485, utcOffset: -5 },
  "Minute Maid Park": { lat: 29.7573, lon: -95.3555, utcOffset: -6 },
  "Daikin Park": { lat: 29.7573, lon: -95.3555, utcOffset: -6 },
  "Kauffman Stadium": { lat: 39.0517, lon: -94.4803, utcOffset: -6 },
  "Dodger Stadium": { lat: 34.0739, lon: -118.24, utcOffset: -8 },
  "loanDepot park": { lat: 25.7781, lon: -80.2196, utcOffset: -5 },
  "American Family Field": { lat: 43.028, lon: -87.9712, utcOffset: -6 },
  "Target Field": { lat: 44.9817, lon: -93.2776, utcOffset: -6 },
  "Citi Field": { lat: 40.7571, lon: -73.8458, utcOffset: -5 },
  "Yankee Stadium": { lat: 40.8296, lon: -73.9262, utcOffset: -5 },
  "Sutter Health Park": { lat: 38.5802, lon: -121.5133, utcOffset: -8 },
  "Oakland Coliseum": { lat: 37.7516, lon: -122.2005, utcOffset: -8 },
  "Citizens Bank Park": { lat: 39.9061, lon: -75.1665, utcOffset: -5 },
  "PNC Park": { lat: 40.4469, lon: -80.0057, utcOffset: -5 },
  "Petco Park": { lat: 32.7073, lon: -117.1566, utcOffset: -8 },
  "Oracle Park": { lat: 37.7786, lon: -122.3893, utcOffset: -8 },
  "T-Mobile Park": { lat: 47.5914, lon: -122.3325, utcOffset: -8 },
  "Busch Stadium": { lat: 38.6226, lon: -90.1928, utcOffset: -6 },
  "Tropicana Field": { lat: 27.7683, lon: -82.6534, utcOffset: -5 },
  "Steinbrenner Field": { lat: 27.9803, lon: -82.5067, utcOffset: -5 },
  "George M. Steinbrenner Field": { lat: 27.9803, lon: -82.5067, utcOffset: -5 },
  "Globe Life Field": { lat: 32.7473, lon: -97.0842, utcOffset: -6 },
  "Rogers Centre": { lat: 43.6414, lon: -79.3894, utcOffset: -5 },
  "Nationals Park": { lat: 38.873, lon: -77.0074, utcOffset: -5 },
};

export function stadiumGeo(venue: string | null | undefined): StadiumGeo | null {
  if (!venue) return null;
  return STADIUM_GEO[venue] ?? null;
}

/** Great-circle distance in km between two parks; null when either is unknown. */
export function venueDistanceKm(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const a = stadiumGeo(from);
  const b = stadiumGeo(to);
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Time zones crossed moving between parks: positive = eastward. */
export function venueTzShift(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const a = stadiumGeo(from);
  const b = stadiumGeo(to);
  if (!a || !b) return null;
  return b.utcOffset - a.utcOffset;
}
