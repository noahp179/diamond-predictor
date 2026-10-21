/**
 * nba-geo.ts — where each NBA team plays: arena latitude/longitude, time zone
 * (hours from Eastern) and whether the floor is at altitude. Keyed by ESPN's
 * team abbreviation. For the schedule factors (miles and time zones since the
 * last game, visitors at altitude).
 */
export const NBA_GEO: Record<string, { lat: number; lon: number; tz: number; alt?: true }> = {
  ATL: { lat: 33.757, lon: -84.396, tz: 0 },
  BOS: { lat: 42.366, lon: -71.062, tz: 0 },
  BKN: { lat: 40.683, lon: -73.976, tz: 0 },
  CHA: { lat: 35.225, lon: -80.839, tz: 0 },
  CHI: { lat: 41.881, lon: -87.674, tz: -1 },
  CLE: { lat: 41.496, lon: -81.688, tz: 0 },
  DAL: { lat: 32.79, lon: -96.81, tz: -1 },
  DEN: { lat: 39.749, lon: -105.008, tz: -2, alt: true },
  DET: { lat: 42.341, lon: -83.055, tz: 0 },
  GS: { lat: 37.768, lon: -122.388, tz: -3 },
  HOU: { lat: 29.751, lon: -95.362, tz: -1 },
  IND: { lat: 39.764, lon: -86.156, tz: 0 },
  LAC: { lat: 33.945, lon: -118.341, tz: -3 },
  LAL: { lat: 34.043, lon: -118.267, tz: -3 },
  MEM: { lat: 35.138, lon: -90.051, tz: -1 },
  MIA: { lat: 25.781, lon: -80.188, tz: 0 },
  MIL: { lat: 43.045, lon: -87.917, tz: -1 },
  MIN: { lat: 44.979, lon: -93.276, tz: -1 },
  NO: { lat: 29.949, lon: -90.082, tz: -1 },
  NY: { lat: 40.751, lon: -73.993, tz: 0 },
  OKC: { lat: 35.463, lon: -97.515, tz: -1 },
  ORL: { lat: 28.539, lon: -81.384, tz: 0 },
  PHI: { lat: 39.901, lon: -75.172, tz: 0 },
  PHX: { lat: 33.446, lon: -112.071, tz: -2 },
  POR: { lat: 45.532, lon: -122.667, tz: -3 },
  SAC: { lat: 38.58, lon: -121.5, tz: -3 },
  SA: { lat: 29.427, lon: -98.438, tz: -1 },
  TOR: { lat: 43.643, lon: -79.379, tz: 0 },
  UTAH: { lat: 40.768, lon: -111.901, tz: -2, alt: true },
  WSH: { lat: 38.898, lon: -77.021, tz: 0 },
};

/** Great-circle miles between two arenas (0 if either is unknown). */
export function nbaMiles(a: string, b: string): number {
  const p = NBA_GEO[a];
  const q = NBA_GEO[b];
  if (!p || !q) return 0;
  const rad = Math.PI / 180;
  const dLat = (q.lat - p.lat) * rad;
  const dLon = (q.lon - p.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3959 * Math.asin(Math.sqrt(h));
}
