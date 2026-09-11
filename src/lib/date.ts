/**
 * date.ts — the calendar day a US sports slate belongs to.
 *
 * Every US league files its schedule under the *US Eastern* calendar day, and
 * so do the feeds we read: ESPN's `scoreboard?dates=YYYYMMDD` puts Sunday Night
 * Football (00:20Z Monday) on Sunday, and the MLB Stats API does the same with
 * west-coast night games.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, which rolls over at
 * 8pm ET — i.e. in the middle of essentially every nationally televised game.
 * Using it as "today" asked the feeds for *tomorrow* all evening, which is why
 * a live Thursday-night slate rendered as "No games scheduled". Everything that
 * needs "today" (or the day an ISO timestamp belongs to) goes through here.
 */

/** The timezone every US league schedules in. */
export const LEAGUE_TZ = "America/New_York";

// Built once and reused. A runtime without the full ICU data can't resolve a
// named timezone, so this is allowed to fail and fall back to UTC rather than
// throwing at import time and taking every page down with it.
const fmt: Intl.DateTimeFormat | null = (() => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: LEAGUE_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return null;
  }
})();

/** The US Eastern calendar day of an instant, as YYYY-MM-DD. */
export function etDate(at: Date = new Date()): string {
  if (!fmt) return at.toISOString().slice(0, 10);
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const [y, m, d] = [get("year"), get("month"), get("day")];
  return y && m && d ? `${y}-${m}-${d}` : at.toISOString().slice(0, 10);
}

/** Today, in the league's timezone. The default slate date everywhere. */
export function todayET(): string {
  return etDate();
}

/** The US Eastern day an ISO timestamp from a feed belongs to. Feed timestamps
 *  are UTC, so a 8:20pm ET kickoff arrives stamped with the next day's date —
 *  `"2026-09-14T00:20Z"` is a Sunday game and must compare as `2026-09-13`. */
export function etDateOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? etDate(new Date(t)) : iso.slice(0, 10);
}
