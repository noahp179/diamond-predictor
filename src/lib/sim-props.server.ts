/**
 * sim-props.server.ts — the simulation-driven prop boards.
 *
 * NBA points, NHL points / goals / first goal, NFL and college touchdowns and
 * first touchdown: each comes from the site's own game simulator, playing
 * every game on the slate up to 100,000 times and reading off each player's
 * chance of reaching each line. The backtests (research/player-props) chose
 * this, against season averages, fitted models and blends, on seasons the
 * simulator never saw; their calibration maps (sim-props-calibration.json)
 * turn the simulator's raw share into a percentage that has actually come in
 * that often.
 *
 * A hundred thousand plays of a game takes about a minute of computing, so it
 * cannot happen on a page load. Scheduled jobs (/api/public/hooks/sim-props,
 * one per "slot" of games) play the day's games a few at a time within a time
 * budget and store the result in sim_props; the boards read it from there.
 */

import { supabaseAdmin as _admin } from "@/integrations/supabase/client.server";
import { supabase } from "@/integrations/supabase/client";

import {
  linesOf,
  marketSlug,
  parseSlug,
  playersFrom,
  probOf,
  projectionOf,
  simBoard,
  simMarketLabel,
  simMarkets,
  simModelVersion,
  statWords,
  type SimPlayer,
  type SimPropsLeague,
} from "./sim-props-shared";
import { addDays, etDateOf } from "./date";
import { Accumulator } from "./sim/aggregate";
import { buildMatchup, buildSlate, type SlateEntry } from "./sim/build.server";
import { seedFor } from "./sim/core";
import { runner } from "./sim/engine";
import type { SimLeague } from "./sim/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = { from: (t: string) => any };
const admin = () => _admin as unknown as AnyTable | undefined;
const reader = () => supabase as unknown as AnyTable;

export type { SimPlayer, SimPropsLeague };
export const SIM_VERSION = "sim-v1";

/** The most plays per game, and how much of a job's time one slot may use. */
export const TARGET_RUNS = 100_000;
const CHUNK = 2_000;
/** Picks recorded per market per game: the game's three likeliest players. */
const PICKS_PER_GAME = 3;

/** Scheduled slots per league (vercel.json has one cron per slot). The day's
 *  games are spread evenly over all of them (see slotGames), so a quiet night
 *  gives each game a whole job and a busy one shares. 100,000 plays take about
 *  a minute a game for basketball and football and a little over two for
 *  hockey, so a two-game hockey slot lands just under the full count. College
 *  has no cron: its boards use the touchdown model, which beat the simulator
 *  in the backtest. Run by hand, a busy Saturday's ~60 games across 8 slots
 *  get fewer than 100,000 plays each; the time budget decides, and the row
 *  records it. */
export const SLOTS: Record<SimPropsLeague, number> = { nba: 5, nhl: 6, nfl: 6, cfb: 8, mlb: 4 };

export type SimGameRow = {
  league: SimPropsLeague;
  event_id: string;
  game_date: string;
  start_time: string | null;
  home_id: string;
  away_id: string;
  home_abbr: string;
  away_abbr: string;
  runs: number;
  version: string;
  players: SimPlayer[];
  basis: string | null;
  generated_at: string;
};

/**
 * Play one game up to `runs` times, stopping early if `deadline` (ms since
 * epoch) arrives; returns the players' summaries and how many games ran.
 */
export async function simulateGame(
  league: SimPropsLeague,
  g: SlateEntry,
  date: string,
  runs: number,
  deadline: number,
): Promise<{ players: SimPlayer[]; runs: number; basis: string }> {
  const m = await buildMatchup({
    league: league as SimLeague,
    homeId: g.home.id,
    awayId: g.away.id,
    date,
    gameId: g.id,
  });
  // Baseball: the day's nine, so the bench sits (see mlbBenched).
  const lineup = league === "mlb" ? await mlbBenched(m, g, date).catch(() => null) : null;
  const play = runner(m, { benched: lineup?.benched ?? [], activated: [] });
  const acc = new Accumulator(m);
  const base = (Number(g.id) * 2654435761) >>> 0;
  let n = 0;
  while (n < runs) {
    const stop = Math.min(runs, n + CHUNK);
    for (; n < stop; n++) acc.add(play(seedFor(base, n), false));
    if (Date.now() > deadline && n >= 10_000) break;
    // Let the event loop breathe between chunks.
    await new Promise((r) => setTimeout(r, 0));
  }
  const r = acc.summary(0);
  const players = playersFrom(league, r, { home: g.home.abbr, away: g.away.abbr }, g.playoff);
  const basis = lineup?.note ? `${m.ctx.basis} · ${lineup.note}` : m.ctx.basis;
  return { players, runs: n, basis };
}

/**
 * Who sits, for a baseball simulation: every position player outside the
 * day's starting nine. Left to itself the engine bats the nine with the most
 * plate appearances, which on the 2026 replays was the real nine on only 31%
 * of lineups — a regular's day off, a platoon, a September call-up all miss —
 * and its numbers were calibrated on the posted nine
 * (research/player-props/evaluate_mlb.py). The nine is the posted lineup
 * card when MLB has it (about two to four hours before first pitch), else the
 * nine the team started its last game with. MLB's names are matched to
 * ESPN's roster; if fewer than eight of a side's nine match, that side is
 * left to the engine rather than guessed at.
 */
async function mlbBenched(
  m: Awaited<ReturnType<typeof buildMatchup>>,
  g: SlateEntry,
  date: string,
): Promise<{ benched: string[]; note: string } | null> {
  if (m.league !== "mlb") return null;
  const day = await mlbDayLineups(date);
  const game = day
    // ESPN's slate says "Guardians", MLB "Cleveland Guardians".
    .filter(
      (x) =>
        x.homeName.endsWith(normName(g.home.name)) && x.awayName.endsWith(normName(g.away.name)),
    )
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.start) - Date.parse(g.date)) -
        Math.abs(Date.parse(b.start) - Date.parse(g.date)),
    )[0];
  if (!game) return null;
  const benched: string[] = [];
  const how: string[] = [];
  for (const side of ["home", "away"] as const) {
    const nine =
      game[side].posted.length >= 9
        ? game[side].posted
        : await mlbLastNine(game[side].teamId, date);
    const names = new Set(nine.map(normName));
    const shorts = nine.map(shortName);
    const batters = m[side].batters;
    const inNine = batters.filter(
      (b) =>
        names.has(normName(b.name)) ||
        (shorts.filter((s) => s === shortName(b.name)).length === 1 &&
          batters.filter((x) => shortName(x.name) === shortName(b.name)).length === 1),
    );
    if (nine.length < 9 || inNine.length < 8) {
      how.push(`${m[side].abbr}: the engine's nine`);
      continue;
    }
    const keep = new Set(inNine.map((b) => b.id));
    const pitchers = new Set(m[side].pitchers.map((p) => p.id));
    for (const b of batters) if (!keep.has(b.id) && !pitchers.has(b.id)) benched.push(b.id);
    how.push(
      `${m[side].abbr}: ${game[side].posted.length >= 9 ? "posted lineup" : "last game's lineup"}`,
    );
  }
  return { benched, note: how.join(", ") };
}

type SideLineup = { teamId: number; posted: string[] };
type DayLineup = {
  start: string;
  homeName: string;
  awayName: string;
  home: SideLineup;
  away: SideLineup;
};

const lineupCache = new Map<string, { at: number; v: DayLineup[] }>();

/** MLB's schedule for a day with each side's posted lineup card, if out. */
async function mlbDayLineups(date: string): Promise<DayLineup[]> {
  const hit = lineupCache.get(date);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const d = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}&hydrate=lineups,team`, {
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.json() : null));
  const v: DayLineup[] = ((d?.dates ?? []) as any[])
    .flatMap((x) => x.games ?? [])
    .map((x: any) => {
      const side = (s: "home" | "away"): SideLineup => ({
        teamId: Number(x.teams?.[s]?.team?.id ?? 0),
        posted: ((x.lineups?.[`${s}Players`] ?? []) as any[]).map((p) => String(p.fullName ?? "")),
      });
      return {
        start: String(x.gameDate ?? ""),
        homeName: normName(String(x.teams?.home?.team?.name ?? "")),
        awayName: normName(String(x.teams?.away?.team?.name ?? "")),
        home: side("home"),
        away: side("away"),
      };
    });
  lineupCache.set(date, { at: Date.now(), v });
  return v;
}

/** The nine a team started its last finished game with, in order. */
async function mlbLastNine(teamId: number, date: string): Promise<string[]> {
  if (!teamId) return [];
  const sched = await fetch(
    `${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${addDays(date, -10)}&endDate=${addDays(date, -1)}&gameType=R,F,D,L,W`,
    { signal: AbortSignal.timeout(15000) },
  ).then((r) => (r.ok ? r.json() : null));
  const last = ((sched?.dates ?? []) as any[])
    .flatMap((x) => x.games ?? [])
    .filter((x: any) => ["F", "O"].includes(x.status?.codedGameState))
    .sort((a: any, b: any) => String(a.gameDate).localeCompare(String(b.gameDate)))
    .pop();
  if (!last) return [];
  const box = await fetch(`${MLB_API}/game/${last.gamePk}/boxscore`, {
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.json() : null));
  for (const s of ["home", "away"] as const) {
    const t = box?.teams?.[s];
    if (Number(t?.team?.id) !== teamId) continue;
    return Object.values<any>(t?.players ?? {})
      .filter((p) => Number(p.battingOrder) % 100 === 0 && Number(p.battingOrder) > 0)
      .sort((a, b) => Number(a.battingOrder) - Number(b.battingOrder))
      .map((p) => String(p.person?.fullName ?? ""));
  }
  return [];
}

/**
 * The games one slot plays: the slate, in start order, cut into SLOTS equal
 * runs. Fixed blocks of three left a quiet night's last slots idle while the
 * first squeezed three hockey games each into one job (34,000 plays apiece on
 * 15 October). When the split is uneven the earlier slots take the extra
 * game: the scheduler can fire a job up to an hour late, so the day's first
 * games belong in its first jobs, and a one-game day is played by slot 0.
 */
export function slotGames<T>(slate: T[], slot: number, slots: number): T[] {
  const at = (s: number) => Math.ceil((s * slate.length) / slots);
  return slate.slice(at(slot), at(slot + 1));
}

/**
 * One scheduled slot: its share of the date's slate (slotGames), each game
 * played up to TARGET_RUNS times within `budgetMs`. A game already stored
 * today with the full count, or already under way, is skipped.
 */
export async function runSimSlot(
  league: SimPropsLeague,
  date: string,
  slot: number,
  budgetMs = 270_000,
) {
  const db = admin();
  if (!db) return { ok: false, reason: "no service-role key" };
  const t0 = Date.now();
  // The first slot of the morning grades the earlier days' picks.
  if (slot === 0) await settleSimPicks(league, date, 60_000).catch((e) => console.error(e));
  // Preseason games are not simulated or recorded: starters sit and rotations
  // are trial runs, so they say nothing about the boards (see
  // supabase/fixes/20261013_remove_nba_preseason.sql).
  const slate = (await buildSlate(league as SimLeague, date))
    .filter((g) => g.state === "pre" && !g.preseason)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  const mine = slotGames(slate, slot, SLOTS[league]);
  if (!mine.length) return { ok: true, games: 0, slate: slate.length };

  const { data: have } = await db
    .from("sim_props")
    .select("event_id, runs, generated_at")
    .eq("league", league)
    .in(
      "event_id",
      mine.map((g) => g.id),
    );
  const done = new Map<string, { runs: number; generated_at: string }>(
    (have ?? []).map((r: { event_id: string; runs: number; generated_at: string }) => [
      r.event_id,
      r,
    ]),
  );

  const out: { id: string; runs: number; players: number }[] = [];
  for (let i = 0; i < mine.length; i++) {
    const g = mine[i];
    const prev = done.get(g.id);
    if (
      prev &&
      prev.runs >= TARGET_RUNS &&
      prev.generated_at.slice(0, 10) === new Date().toISOString().slice(0, 10)
    )
      continue;
    // Share what is left of the budget across the games still to play.
    const left = budgetMs - (Date.now() - t0);
    if (left < 20_000) break;
    const deadline = Date.now() + left / (mine.length - i);
    try {
      const r = await simulateGame(league, g, date, TARGET_RUNS, deadline);
      const row: Omit<SimGameRow, "generated_at"> & { generated_at: string } = {
        league,
        event_id: g.id,
        game_date: date,
        start_time: g.date || null,
        home_id: g.home.id,
        away_id: g.away.id,
        home_abbr: g.home.abbr,
        away_abbr: g.away.abbr,
        runs: r.runs,
        version: SIM_VERSION,
        players: r.players,
        basis: r.basis,
        generated_at: new Date().toISOString(),
      };
      const { error } = await db.from("sim_props").upsert(row, { onConflict: "league,event_id" });
      if (error) console.error(`[sim-props] ${league} ${g.id}:`, error.message);
      if (g.state === "pre") await snapshotSimPicks(league, row);
      out.push({ id: g.id, runs: r.runs, players: r.players.length });
    } catch (err) {
      console.error(`[sim-props] ${league} ${g.id}:`, err);
    }
  }
  return { ok: true, slate: slate.length, slot, games: out, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ read

export async function readSimGames(league: SimPropsLeague, date: string): Promise<SimGameRow[]> {
  const { data, error } = await reader()
    .from("sim_props")
    .select("*")
    .eq("league", league)
    .eq("game_date", date);
  if (error) {
    if (/relation .* does not exist|sim_props/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as SimGameRow[];
}

// ---------------------------------------------------------------- ledger

/**
 * Write a game's picks to the forward ledger: for every market on the
 * league's boards, the three likeliest players in the game. Written once,
 * before the game — a later re-simulation the same day does not overwrite
 * them (ignoreDuplicates), so the record is what the board said first.
 */
export async function snapshotSimPicks(league: SimPropsLeague, row: SimGameRow): Promise<number> {
  const db = admin();
  if (!db) return 0;
  const rows: Record<string, unknown>[] = [];
  const matchup = `${row.away_abbr} @ ${row.home_abbr}`;
  for (const m of simMarkets(league)) {
    const slug = marketSlug(league, m.key);
    const top = row.players
      .map((p) => ({ p, prob: probOf(league, p, m.key) }))
      .filter((x) => x.prob > 0.001)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, PICKS_PER_GAME);
    top.forEach(({ p, prob }, i) =>
      rows.push({
        sport: league,
        market: slug,
        model_version: simModelVersion(league, slug),
        event_id: row.event_id,
        event_date: row.game_date,
        player_id: p.id,
        player: p.name,
        team: p.team,
        position: p.pos || null,
        matchup,
        pick_rank: i + 1,
        prob: Math.round(prob * 10000) / 10000,
        tier: null,
      }),
    );
  }
  if (!rows.length) return 0;
  const { error, count } = await db.from("player_predictions").upsert(rows, {
    onConflict: "model_version,event_id,player_id",
    ignoreDuplicates: true,
    count: "exact",
  });
  if (error) {
    console.error(`[sim-props] ledger ${league} ${row.event_id}:`, error.message);
    return 0;
  }
  return count ?? 0;
}

const ESPN: Record<SimPropsLeague, string> = {
  nba: "basketball/nba",
  nhl: "hockey/nhl",
  nfl: "football/nfl",
  cfb: "football/college-football",
  mlb: "baseball/mlb",
};

export type Box = {
  final: boolean;
  score: string;
  /** 'SEA @ DEN' */
  matchup: string;
  /** player id -> stat values the markets settle on; absent = did not play */
  lines: Map<string, Record<string, number>>;
  /** player id -> who he is, for the stored result */
  who: Map<string, { name: string; team: string }>;
  /** player id of the first goal / first touchdown, null if none or a team score */
  first: string | null;
};

/** Where to check a game by hand. */
const ESPN_SITE: Record<SimPropsLeague, string> = {
  nba: "nba",
  nhl: "nhl",
  nfl: "nfl",
  cfb: "college-football",
  mlb: "mlb",
};
export const boxUrl = (league: SimPropsLeague, eventId: string) =>
  `https://www.espn.com/${ESPN_SITE[league]}/boxscore/_/gameId/${eventId}`;

/** One finished game, read for settlement. Null while it is not final. */
export async function boxFor(league: SimPropsLeague, eventId: string): Promise<Box | null> {
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/${ESPN[league]}/summary?event=${eventId}`,
    { signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const d = (await res.json()) as any;
  const comp = d.header?.competitions?.[0];
  if (comp?.status?.type?.completed !== true) return null;
  const score = (comp.competitors ?? [])
    .map((c: any) => `${c.team?.abbreviation ?? "?"} ${c.score ?? "?"}`)
    .join(" – ");
  const side = (h: string) =>
    (comp.competitors ?? []).find((c: any) => c.homeAway === h)?.team?.abbreviation ?? "?";
  const matchup = `${side("away")} @ ${side("home")}`;
  if (league === "mlb") return mlbBox(d, comp, score, matchup);
  const lines = new Map<string, Record<string, number>>();
  const who = new Map<string, { name: string; team: string }>();
  const names = new Map<string, string>();
  for (const t of d.boxscore?.players ?? [])
    for (const st of t.statistics ?? []) {
      const labels: string[] = st.labels ?? [];
      const keys: string[] = st.keys ?? [];
      for (const a of st.athletes ?? []) {
        const id = a.athlete?.id;
        if (!id || a.didNotPlay || !(a.stats ?? []).length) continue;
        if (a.athlete?.displayName) names.set(String(a.athlete.displayName).toLowerCase(), id);
        who.set(id, {
          name: String(a.athlete?.displayName ?? ""),
          team: String(t.team?.abbreviation ?? ""),
        });
        const raw = (k: string) => {
          const i = labels.indexOf(k);
          return String(a.stats[i >= 0 ? i : keys.indexOf(k)] ?? "");
        };
        // "3-7" (made-attempted) reads as its first number.
        const v = (k: string) => Number(raw(k).split("-")[0].split("/")[0]) || 0;
        const row = lines.get(id) ?? {};
        if (league === "nba") {
          if (v("MIN") <= 0) continue;
          Object.assign(row, nbaLine(v("PTS"), v("REB"), v("AST"), v("3PT"), v("STL"), v("BLK")));
        } else if (league === "nhl") {
          if (st.name === "goalies") {
            // A dressed backup who never went in did not play.
            if (!/[1-9]/.test(raw("TOI"))) continue;
            row.sv = v("SV");
          } else {
            row.g = v("G");
            row.a = v("A");
            row.pts = row.g + row.a;
            row.sog = v("S");
          }
        } else {
          const add = (k: string, x: number) => (row[k] = (row[k] ?? 0) + x);
          if (st.name === "passing") {
            add("cmp", v("completions/passingAttempts"));
            add("pyd", v("passingYards"));
            add("ptd", v("passingTouchdowns"));
          } else if (st.name === "rushing") {
            add("car", v("rushingAttempts"));
            add("ryd", v("rushingYards"));
            add("td", v("rushingTouchdowns"));
          } else if (st.name === "receiving") {
            add("rec", v("receptions"));
            add("reyd", v("receivingYards"));
            add("td", v("receivingTouchdowns"));
          }
          for (const k of ["td", "cmp", "pyd", "ptd", "car", "ryd", "rec", "reyd"]) row[k] ??= 0;
          row.rry = row.ryd + row.reyd;
        }
        lines.set(id, row);
      }
    }
  let first: string | null = null;
  if (league === "nhl") {
    const goal = (d.plays ?? []).find(
      (p: any) => p.scoringPlay && !/shootout/i.test(p.text ?? "") && (p.period?.number ?? 0) < 5,
    );
    first = goal?.participants?.find((x: any) => x.type === "scorer")?.athlete?.id ?? null;
  } else if (league === "nfl" || league === "cfb") {
    const td = (d.scoringPlays ?? []).find((p: any) => p.scoringType?.name === "touchdown");
    const nm = String(td?.text ?? "")
      .match(/^(.+?)\s+\d+\s+Yd/i)?.[1]
      ?.toLowerCase();
    first = nm ? (names.get(nm) ?? null) : null;
  }
  return { final: true, score, matchup, lines, who, first };
}

/**
 * Store a final box score in game_results: every player's line in the stats
 * the markets settle on, the score and who scored first, so any recorded pick
 * can be checked against what happened. Players with no line (did not play)
 * are left out, exactly as settlement voids them.
 */
export async function saveResult(
  league: SimPropsLeague,
  eventId: string,
  box: Box,
  gameDate: string | null,
): Promise<boolean> {
  const db = admin();
  if (!db) return false;
  const players = [...box.lines.entries()].map(([id, stats]) => ({
    id,
    name: box.who.get(id)?.name ?? "",
    team: box.who.get(id)?.team ?? "",
    stats,
  }));
  // Every player the board priced, graded at every line — only from a
  // simulation stored before the game started, so nothing after the fact.
  const { data: sim } = await db
    .from("sim_props")
    .select("players, generated_at, start_time")
    .eq("league", league)
    .eq("event_id", eventId)
    .maybeSingle();
  const priced =
    sim && (!sim.start_time || String(sim.generated_at) <= String(sim.start_time))
      ? pricedBands(league, sim.players as SimPlayer[], box)
      : null;
  const { error } = await db.from("game_results").upsert(
    {
      league,
      event_id: eventId,
      game_date: gameDate,
      matchup: box.matchup,
      final_score: box.score,
      players,
      first_scorer: box.first,
      priced,
      box_url: boxUrl(league, eventId),
      source: "espn",
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "league,event_id" },
  );
  if (error) console.error(`[sim-props] result ${league} ${eventId}:`, error.message);
  return !error;
}

/** A priced-and-graded tally: [band, priced, did it, sum of the board's numbers]. */
export type PricedBand = [number, number, number, number];

/**
 * Every player a game's simulation priced, at every line its boards show,
 * against the box score: per market and ten-point band of the board's number
 * (as the board shows it, calibrated where it is), how many were priced there,
 * how many did it and what the board said in sum. Players who did not play
 * are left out (a void), as are those the board gave no real chance (under
 * half a percent) — the linemen and backup goalies who would only pad the
 * bottom band.
 */
export function pricedBands(
  league: SimPropsLeague,
  sim: SimPlayer[],
  box: Box,
): Record<string, PricedBand[]> {
  const out: Record<string, PricedBand[]> = {};
  for (const m of simMarkets(league)) {
    const slug = marketSlug(league, m.key);
    const bands = new Map<number, PricedBand>();
    for (const pl of sim) {
      const p = probOf(league, pl, m.key);
      if (!(p >= 0.005)) continue;
      const y = outcome(slug, box, String(pl.id));
      if (y == null) continue;
      const band = Math.min(9, Math.floor(p * 10));
      const b = bands.get(band) ?? [band, 0, 0, 0];
      b[1] += 1;
      b[2] += y ? 1 : 0;
      b[3] = Math.round((b[3] + p) * 1e4) / 1e4;
      bands.set(band, b);
    }
    if (bands.size) out[slug] = [...bands.values()].sort((a, b) => a[0] - b[0]);
  }
  return out;
}

/** Every priced player at every line, summed over a league's stored games. */
export async function readPricedBands(
  league: SimPropsLeague,
): Promise<{ market: string; band: number; n: number; hits: number; said: number }[]> {
  const acc = new Map<string, { n: number; hits: number; said: number }>();
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await reader()
      .from("game_results")
      .select("priced")
      .eq("league", league)
      .not("priced", "is", null)
      .range(from, from + 999);
    if (error) return [];
    for (const r of (data ?? []) as { priced: Record<string, PricedBand[]> }[]) {
      for (const [market, bands] of Object.entries(r.priced ?? {}))
        for (const [band, n, hits, said] of bands) {
          const k = `${market}|${band}`;
          const a = acc.get(k) ?? { n: 0, hits: 0, said: 0 };
          a.n += n;
          a.hits += hits;
          a.said += said;
          acc.set(k, a);
        }
    }
    if (!data || data.length < 1000) break;
  }
  return [...acc.entries()].map(([k, v]) => {
    const [market, band] = k.split("|");
    return { market, band: Number(band), ...v };
  });
}

/**
 * Store the result of every tracked game that has none yet: each game this
 * season with recorded picks (the simulation boards' and the boards before
 * them) or a stored simulation, once it is final. The grading job calls it
 * with whatever time it has left, newest games first, so the first run after
 * this shipped works back through the season and later runs only add the
 * night's games.
 */
export async function recordResults(
  league: SimPropsLeague,
  throughDate: string,
  budgetMs = 60_000,
): Promise<{ stored: number; missing: number }> {
  const db = admin();
  if (!db) return { stored: 0, missing: 0 };
  const t0 = Date.now();
  const year = Number(throughDate.slice(0, 4)) - (Number(throughDate.slice(5, 7)) >= 8 ? 0 : 1);
  const games = new Map<string, string>(); // event id -> game date
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("player_predictions")
      .select("event_id, event_date")
      .eq("sport", league)
      .eq("provenance", "forward")
      .gte("event_date", `${year}-08-01`)
      .lte("event_date", throughDate)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { stored: 0, missing: 0 };
    for (const r of data ?? []) games.set(String(r.event_id), String(r.event_date));
    if (!data || data.length < 1000) break;
  }
  const { data: sims } = await db
    .from("sim_props")
    .select("event_id, game_date")
    .eq("league", league)
    .lte("game_date", throughDate);
  for (const r of sims ?? []) games.set(String(r.event_id), String(r.game_date));
  const { data: have } = await db.from("game_results").select("event_id").eq("league", league);
  const stored = new Set((have ?? []).map((r: { event_id: string }) => String(r.event_id)));
  const todo = [...games.entries()]
    .filter(([id]) => !stored.has(id))
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  let n = 0;
  for (const [eventId, date] of todo) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      const box = await boxFor(league, eventId);
      if (box && (await saveResult(league, eventId, box, date))) n += 1;
    } catch (err) {
      console.error(`[sim-props] result ${league} ${eventId}:`, err);
    }
  }
  return { stored: n, missing: todo.length - n };
}

// ------------------------------------------------------------ MLB box score

const MLB_API = "https://statsapi.mlb.com/api/v1";

/** A name as both feeds can agree on it: no accents, case, punctuation or suffix. */
const normName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
/** Last name plus first initial, for the nickname cases ("Mike" / "Michael"). */
const shortName = (s: string) => {
  const parts = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z ]/g, "")
    .trim()
    .split(/\s+/);
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1] ?? ""}`;
};

/**
 * A finished MLB game, graded from MLB's own box score.
 *
 * ESPN's MLB box score has hits, runs, RBI, home runs and strikeouts per
 * player but not doubles, triples or stolen bases, so total bases and steals
 * cannot be read from it. MLB's Stats API has every one of them. The picks
 * carry ESPN ids (the simulator runs on ESPN's rosters), so ESPN says who
 * played and MLB says what each of them did: the game is found on MLB's
 * schedule by date and teams, and each ESPN player is matched to MLB's line
 * by name within his team (full name, then last name and first initial). A
 * player who cannot be matched keeps the numbers ESPN does have, and his total
 * bases and steals are left out, so those picks void rather than guess.
 */
async function mlbBox(d: any, comp: any, score: string, matchup: string): Promise<Box | null> {
  const start = String(comp.date ?? "");
  const espnSide = new Map<string, "home" | "away">();
  const espnName = new Map<"home" | "away", string>();
  for (const c of comp.competitors ?? []) {
    if (c.team?.id) espnSide.set(String(c.team.id), c.homeAway);
    espnName.set(c.homeAway, normName(String(c.team?.displayName ?? c.team?.name ?? "")));
  }
  // MLB's schedule for the game's day (and the next, for a late start that
  // crosses midnight in UTC).
  const day = start ? etDateOf(start) : "";
  if (!day) return null;
  const sched = await fetch(
    `${MLB_API}/schedule?sportId=1&startDate=${day}&endDate=${addDays(day, 1)}&hydrate=team`,
    { signal: AbortSignal.timeout(15000) },
  ).then((r) => (r.ok ? r.json() : null));
  const cands = ((sched?.dates ?? []) as any[])
    .flatMap((x) => x.games ?? [])
    .filter(
      (g: any) =>
        normName(String(g.teams?.home?.team?.name ?? "")) === espnName.get("home") &&
        normName(String(g.teams?.away?.team?.name ?? "")) === espnName.get("away"),
    )
    .sort(
      (a: any, b: any) =>
        Math.abs(Date.parse(a.gameDate) - Date.parse(start)) -
        Math.abs(Date.parse(b.gameDate) - Date.parse(start)),
    );
  const pk = cands[0]?.gamePk;
  if (!pk) {
    console.error(`[sim-props] mlb: no MLB game for ${matchup} on ${day}`);
    return null; // left pending, tried again tomorrow
  }
  const mb = await fetch(`${MLB_API}/game/${pk}/boxscore`, {
    signal: AbortSignal.timeout(15000),
  }).then((r) => (r.ok ? r.json() : null));
  if (!mb) return null;
  type MlbLine = { name: string; bat: any; pit: any };
  const mlbBy: Record<
    "home" | "away",
    { full: Map<string, MlbLine>; short: Map<string, MlbLine[]> }
  > = { home: { full: new Map(), short: new Map() }, away: { full: new Map(), short: new Map() } };
  for (const sd of ["home", "away"] as const)
    for (const p of Object.values<any>(mb.teams?.[sd]?.players ?? {})) {
      const name = String(p.person?.fullName ?? "");
      const ln: MlbLine = { name, bat: p.stats?.batting ?? {}, pit: p.stats?.pitching ?? {} };
      mlbBy[sd].full.set(normName(name), ln);
      const k = shortName(name);
      mlbBy[sd].short.set(k, [...(mlbBy[sd].short.get(k) ?? []), ln]);
    }

  const lines = new Map<string, Record<string, number>>();
  const who = new Map<string, { name: string; team: string }>();
  const n = (v: unknown) => Number(v ?? 0) || 0;
  for (const t of d.boxscore?.players ?? []) {
    const sd = espnSide.get(String(t.team?.id ?? ""));
    if (!sd) continue;
    for (const st of t.statistics ?? []) {
      const keys: string[] = st.keys ?? [];
      for (const a of st.athletes ?? []) {
        const id = a.athlete?.id ? String(a.athlete.id) : null;
        if (!id || a.didNotPlay || !(a.stats ?? []).length) continue;
        const name = String(a.athlete?.displayName ?? "");
        who.set(id, { name, team: String(t.team?.abbreviation ?? "") });
        const espn = (k: string) => String(a.stats[keys.indexOf(k)] ?? "");
        const short = mlbBy[sd].short.get(shortName(name)) ?? [];
        const m = mlbBy[sd].full.get(normName(name)) ?? (short.length === 1 ? short[0] : null);
        const row = lines.get(id) ?? {};
        if (st.type === "batting" || st.name === "batting") {
          const b = m?.bat ?? null;
          row.h = b ? n(b.hits) : n(espn("hits"));
          row.hr = b ? n(b.homeRuns) : n(espn("homeRuns"));
          row.r = b ? n(b.runs) : n(espn("runs"));
          row.rbi = b ? n(b.rbi) : n(espn("RBIs"));
          row.hrr = row.h + row.r + row.rbi;
          if (b) {
            row.tb = n(b.totalBases);
            row.sb = n(b.stolenBases);
          }
        } else if (st.type === "pitching" || st.name === "pitching") {
          const p = m?.pit ?? null;
          const [whole, part] = espn("fullInnings.partInnings").split(".");
          row.k = p ? n(p.strikeOuts) : n(espn("strikeouts"));
          row.outs = p ? n(p.outs) : n(whole) * 3 + n(part);
          row.er = p ? n(p.earnedRuns) : n(espn("earnedRuns"));
        }
        if (!m) console.warn(`[sim-props] mlb: no MLB line for ${name} (${matchup})`);
        lines.set(id, row);
      }
    }
  }
  return { final: true, score, matchup, lines, who, first: null };
}

/** A basketball line, with the combinations the boards sell. */
export function nbaLine(
  pts: number,
  reb: number,
  ast: number,
  tpm: number,
  stl: number,
  blk: number,
) {
  return {
    pts,
    reb,
    ast,
    "3pm": tpm,
    stl,
    blk,
    pra: pts + reb + ast,
    pr: pts + reb,
    pa: pts + ast,
    ra: reb + ast,
    stk: stl + blk,
    // categories in double figures: 2+ is a double-double, 3+ a triple-double
    dd: [pts, reb, ast, stl, blk].filter((x) => x >= 10).length,
  };
}

/** Did the pick come in? Null = void (he did not play), as a sportsbook has it. */
export function outcome(market: string, box: Box, pid: string): boolean | null {
  const ln = box.lines.get(pid);
  if (!ln) return null; // did not play: void
  if (market === "firstgoal" || market === "firsttd") return box.first === pid;
  const m = parseSlug(market);
  if (!m || ln[m[0]] == null) return null;
  return ln[m[0]] >= m[1];
}

/** Grade every pending simulation pick from the box score. */
export async function settleSimPicks(
  league: SimPropsLeague,
  throughDate: string,
  budgetMs = 60_000,
) {
  const db = admin();
  if (!db) return { settled: 0 };
  const t0 = Date.now();
  const since = new Date(`${throughDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 14);
  // Every market of every game is a few rows, so a busy night runs past one
  // page of the API: read them all.
  const pending: {
    id: number;
    event_id: string;
    event_date: string;
    player_id: string;
    market: string;
    prob: number;
  }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("player_predictions")
      .select("id, event_id, event_date, player_id, market, prob")
      .eq("sport", league)
      .like("model_version", `${league}-sim-%`)
      .is("settled_at", null)
      .gte("event_date", since.toISOString().slice(0, 10))
      .lte("event_date", throughDate)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { settled: 0, error: error.message };
    pending.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const byGame = new Map<string, typeof pending>();
  for (const r of pending) byGame.set(r.event_id, [...(byGame.get(r.event_id) ?? []), r]);
  let settled = 0;
  for (const [eventId, rows] of byGame) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      const box = await boxFor(league, eventId);
      if (!box) continue;
      // The box score the picks are graded on, kept so each can be checked.
      await saveResult(league, eventId, box, rows[0].event_date);
      const now = new Date().toISOString();
      const update = async (r: (typeof rows)[number]) => {
        const hit = outcome(r.market, box, String(r.player_id));
        const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(r.prob)));
        const upd =
          hit == null
            ? { scored: null, settled_at: now, final_score: box.score }
            : {
                scored: hit,
                brier: (p - (hit ? 1 : 0)) ** 2,
                log_loss: -Math.log(hit ? p : 1 - p),
                final_score: box.score,
                settled_at: now,
              };
        const { error: uErr } = await db
          .from("player_predictions")
          .update(upd)
          .eq("id", r.id)
          .is("settled_at", null);
        if (!uErr) settled += 1;
      };
      // A game's rows in parallel batches: one round trip each is the cost.
      for (let i = 0; i < rows.length; i += 25)
        await Promise.all(rows.slice(i, i + 25).map(update));
    } catch (err) {
      console.error(`[sim-props] settle ${league} ${eventId}:`, err);
    }
  }
  return { settled, pending: pending.length - settled };
}

/** A simulation board's live record, for the record panel. */
export async function readSimBoard(league: SimPropsLeague, board: string) {
  const def = simBoard(league, board);
  const { readPlayerLedger } = await import("./td-ledger.server");
  const markets = (def?.markets ?? []).map((m) => marketSlug(league, m.key));
  return readPlayerLedger({
    sport: league,
    market: null,
    markets,
    modelVersion: `${league}-sim-`,
    modelPrefix: `${league}-sim-`,
    countLabel: "picks",
    rankOrder: ["Pick 1", "Pick 2", "Pick 3"],
  });
}

// ------------------------------------------------------------- analytics

export type SimBandRow = {
  market: string;
  pick_rank: number;
  /** 0 = priced 0-10%, ... 9 = 90-100% */
  band: number;
  n: number;
  hits: number;
  said: number;
  voids: number;
  pending: number;
  first_date: string | null;
  last_settled: string | null;
};

/**
 * Every simulation pick in the ledger, counted per market, confidence band
 * and card rank (the sim_prop_bands view). Empty, with a reason, until the
 * view exists and the first picks are written.
 */
export async function readSimBands(
  league: SimPropsLeague,
): Promise<{ rows: SimBandRow[]; note: string | null }> {
  const rows: SimBandRow[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await reader()
      .from("sim_prop_bands")
      .select("market, pick_rank, band, n, hits, said, voids, pending, first_date, last_settled")
      .eq("sport", league)
      .order("market", { ascending: true })
      .order("pick_rank", { ascending: true })
      .order("band", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error(`[sim-props] bands ${league}:`, error.message);
      return { rows: [], note: "The live record starts once the database view is in place." };
    }
    rows.push(
      ...(data ?? []).map((r: Record<string, unknown>) => ({
        market: String(r.market),
        pick_rank: Number(r.pick_rank),
        band: Number(r.band),
        n: Number(r.n),
        hits: Number(r.hits),
        said: Number(r.said),
        voids: Number(r.voids),
        pending: Number(r.pending),
        first_date: (r.first_date as string | null) ?? null,
        last_settled: (r.last_settled as string | null) ?? null,
      })),
    );
    if (!data || data.length < 1000) break;
  }
  return { rows, note: rows.length ? null : "No simulation picks have been recorded yet." };
}

// ------------------------------------------------- this season, other boards

export type SeasonLedgerRow = {
  model: string;
  modelName: string;
  market: string;
  label: string;
  /** settled picks that were not voided */
  n: number;
  hits: number;
  said: number;
  voids: number;
  pending: number;
  bands: { band: number; n: number; hits: number; said: number }[];
  first: string | null;
  last: string | null;
};

const MODEL_NAME: Record<string, string> = {
  "nfl-td-pairrank-v1": "Previous TD model",
  "nfl-td-logistic-v1": "Earlier TD model",
  "nfl-props-logistic-v1": "Logistic prop models",
  "mlb-props-logistic-v1": "Logistic prop models",
  "mlb-tb2-logistic-v1": "2+ bases model",
};

/** Bet names for the logistic prop models' market codes, per league. */
async function modelLabelsFor(league: SimPropsLeague): Promise<Record<string, { label: string }>> {
  if (league === "mlb") {
    const { default: m } = await import("./mlb-props-model.json");
    return {
      ...(m as { markets: Record<string, { label: string }> }).markets,
      tb2: { label: "2+ total bases" },
    };
  }
  const { default: m } = await import("./nfl-props-model.json");
  return (m as { markets: Record<string, { label: string }> }).markets;
}

/**
 * This season's picks from the boards that came before the simulations —
 * written down before each game by their own ledgers (td-ledger,
 * prop-ledger) and settled from the box score. The simulation markets have
 * their own record (readSimBands); this is everything else for the sport.
 */
export async function readSeasonLedger(league: SimPropsLeague): Promise<SeasonLedgerRow[]> {
  const now = new Date();
  // Seasons here start in August or later: from 1 August of the season's year.
  const year = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const rows: {
    model_version: string;
    market: string;
    prob: number;
    scored: boolean | null;
    settled_at: string | null;
    event_date: string;
  }[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await reader()
      .from("player_predictions")
      .select("model_version, market, prob, scored, settled_at, event_date")
      .eq("sport", league)
      .eq("provenance", "forward")
      .not("model_version", "like", "%-sim-%")
      .gte("event_date", `${year}-08-01`)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error(`[sim-props] season ledger ${league}:`, error.message);
      return [];
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const labels = await modelLabelsFor(league);
  const byKey = new Map<string, SeasonLedgerRow>();
  for (const r of rows) {
    const k = `${r.model_version}|${r.market}`;
    let o = byKey.get(k);
    if (!o) {
      o = {
        model: r.model_version,
        modelName: MODEL_NAME[r.model_version] ?? r.model_version,
        market: r.market,
        label: r.market === "anytime_td" ? "Anytime TD" : (labels[r.market]?.label ?? r.market),
        n: 0,
        hits: 0,
        said: 0,
        voids: 0,
        pending: 0,
        bands: [],
        first: null,
        last: null,
      };
      byKey.set(k, o);
    }
    o.first = !o.first || r.event_date < o.first ? r.event_date : o.first;
    o.last = !o.last || r.event_date > o.last ? r.event_date : o.last;
    if (!r.settled_at) {
      o.pending += 1;
      continue;
    }
    if (r.scored == null) {
      o.voids += 1;
      continue;
    }
    const p = Number(r.prob);
    o.n += 1;
    o.hits += r.scored ? 1 : 0;
    o.said += p;
    const band = Math.min(9, Math.floor(p * 10));
    let b = o.bands.find((x) => x.band === band);
    if (!b) {
      b = { band, n: 0, hits: 0, said: 0 };
      o.bands.push(b);
    }
    b.n += 1;
    b.hits += r.scored ? 1 : 0;
    b.said += p;
  }
  return [...byKey.values()].sort((a, b) => b.n + b.pending - (a.n + a.pending));
}

// ------------------------------------------------------------ game by game

export type ResultPick = {
  /** "60+ receiving yards" */
  market: string;
  /** "Simulation", or the earlier board that wrote it */
  model: string;
  player: string;
  team: string;
  /** what the board said, as recorded before the game */
  prob: number;
  /** what happened, in words: "87 receiving yards", "scored first" */
  actual: string;
  result: "hit" | "miss" | "void" | "pending";
};
export type ResultStar = {
  player: string;
  team: string;
  /** the stat that put him here: touchdowns, goals, points */
  value: number;
  /** the board's chance for him before the game (null: not priced) */
  prob: number | null;
  /** NBA: the board's projection instead of a chance */
  proj: number | null;
  /** where that chance ranked among everyone in the game, of how many */
  rank: number | null;
  of: number | null;
  picked: boolean;
};
export type ResultGame = {
  eventId: string;
  date: string | null;
  matchup: string;
  score: string;
  boxUrl: string;
  simulated: boolean;
  stars: { title: string; noun: string; rows: ResultStar[] };
  picks: ResultPick[];
  graded: number;
  hits: number;
};

/** The stat each sport's "who did it" list is built on. */
const STAR: Record<SimPropsLeague, { stat: string; title: string; noun: string }> = {
  nfl: { stat: "td", title: "Who scored a touchdown", noun: "TD" },
  cfb: { stat: "td", title: "Who scored a touchdown", noun: "TD" },
  nhl: { stat: "g", title: "Who scored a goal", noun: "G" },
  nba: { stat: "pts", title: "Top scorers", noun: "PTS" },
  mlb: { stat: "hr", title: "Who homered", noun: "HR" },
};

/** The logistic NFL prop models' codes, as box-score stats: "recy60" is 60+ receiving yards. */
const NFL_MODEL_STAT: [RegExp, string][] = [
  [/^recy(\d+)$/, "reyd"],
  [/^rec(\d+)$/, "rec"],
  [/^rushy(\d+)$/, "ryd"],
  [/^scrim(\d+)$/, "rry"],
  [/^passy(\d+)$/, "pyd"],
  [/^passtd(\d+)$/, "ptd"],
];

type StoredLine = { id: string; name: string; team: string; stats: Record<string, number> };

/**
 * The box-score stat and line a ledger market code settles on, whichever board
 * wrote it: the simulation's "reyd60" and the logistic model's "recy60" are
 * both 60+ receiving yards, "anytime_td" is 1+ touchdowns. Null for the
 * first-scorer markets, which settle on who scored first.
 */
export function marketStat(league: SimPropsLeague, market: string): [string, number] | null {
  if (market === "anytime_td") return ["td", 1];
  const m = parseSlug(market);
  if (!m) return null;
  if (league === "nfl" || league === "cfb")
    for (const [re, st] of NFL_MODEL_STAT) if (re.test(market)) return [st, m[1]];
  return m;
}

/**
 * Tracked games, newest first, each with what happened next to what the board
 * said: the box score's touchdown / goal scorers (NBA: top scorers) with the
 * chance the board gave each before the game and where it ranked them, and
 * every recorded pick with its real number and verdict. Built from
 * game_results (the stored box scores), sim_props (the pre-game simulation)
 * and player_predictions (the picks) — nothing recomputed after the fact.
 */
export async function readGameResults(
  league: SimPropsLeague,
  offset = 0,
  limit = 8,
): Promise<{ games: ResultGame[]; more: boolean; note: string | null }> {
  const { data: res, error } = await reader()
    .from("game_results")
    .select("event_id, game_date, matchup, final_score, players, first_scorer, box_url")
    .eq("league", league)
    .order("game_date", { ascending: false })
    .order("event_id", { ascending: true })
    .range(offset, offset + limit);
  if (error)
    return {
      games: [],
      more: false,
      note: "Game results are stored once the game_results table is in place.",
    };
  const rows = (res ?? []) as StoredResult[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!page.length)
    return {
      games: [],
      more: false,
      note: "No tracked game has finished and been stored yet — results are added each morning.",
    };
  const ids = page.map((r) => String(r.event_id));

  const [{ data: sims }, picks] = await Promise.all([
    reader().from("sim_props").select("event_id, players").eq("league", league).in("event_id", ids),
    (async () => {
      const out: StoredPick[] = [];
      for (let from = 0; from < 20_000; from += 1000) {
        const { data } = await reader()
          .from("player_predictions")
          .select(
            "event_id, model_version, market, player_id, player, team, pick_rank, prob, scored, settled_at",
          )
          .eq("sport", league)
          .eq("provenance", "forward")
          .in("event_id", ids)
          .order("id", { ascending: true })
          .range(from, from + 999);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      return out;
    })(),
  ]);
  const modelLabels = await modelLabelsFor(league);
  const simBy = new Map<string, SimPlayer[]>(
    (sims ?? []).map((s: { event_id: string; players: SimPlayer[] }) => [
      String(s.event_id),
      s.players,
    ]),
  );
  const games = resultGames(league, page, simBy, picks, modelLabels);
  return { games, more, note: null };
}

/** A stored game's row, as game_results holds it. */
export type StoredResult = {
  event_id: string;
  game_date: string | null;
  matchup: string | null;
  final_score: string | null;
  players: StoredLine[];
  first_scorer: string | null;
  box_url: string | null;
};
/** A recorded pick, as player_predictions holds it. */
export type StoredPick = {
  event_id: string;
  model_version: string;
  market: string;
  player_id: string;
  player: string;
  team: string;
  pick_rank: number;
  prob: number;
  scored: boolean | null;
  settled_at: string | null;
};

/**
 * The game-by-game view from what is stored — pure, so it can be checked on
 * real games without the database (scripts/test-game-results.ts).
 */
export function resultGames(
  league: SimPropsLeague,
  page: StoredResult[],
  simBy: Map<string, SimPlayer[]>,
  picks: StoredPick[],
  modelLabels: Record<string, { label: string }>,
): ResultGame[] {
  const order = new Map(simMarkets(league).map((m, i) => [marketSlug(league, m.key), i]));
  const star = STAR[league];
  const oneIdx = linesOf(league, star.stat).indexOf(1);
  const starMarket = oneIdx >= 0 ? `${star.stat}:${oneIdx}` : null;

  return page.map((g): ResultGame => {
    const lines = new Map(g.players.map((p) => [String(p.id), p]));
    const sim = simBy.get(String(g.event_id)) ?? null;
    const mine = picks.filter((p) => String(p.event_id) === String(g.event_id));

    // what happened to each pick, in its own stat
    const actualOf = (market: string, pid: string): string => {
      const ln = lines.get(pid);
      if (market === "firsttd" || market === "firstgoal") {
        if (g.first_scorer === pid) return "scored first";
        const who = g.first_scorer ? lines.get(g.first_scorer)?.name : null;
        return who ? `first was ${who}` : "no first scorer";
      }
      if (!ln) return "did not play";
      if (market === "anytime_td") return `${ln.stats.td ?? 0} ${star.noun}`;
      const stat = marketStat(league, market)?.[0];
      if (!stat || ln.stats[stat] == null) return "—";
      const noun = statWords(league, stat)?.noun ?? stat;
      return `${ln.stats[stat]} ${noun}`;
    };
    const labelOf = (model: string, market: string) =>
      model.includes("-sim-")
        ? simMarketLabel(league, market)
        : market === "anytime_td"
          ? "Anytime TD"
          : (modelLabels[market]?.label ?? market);

    const recorded: ResultPick[] = mine
      .slice()
      .sort(
        (a, b) =>
          (order.get(a.market) ?? 999) - (order.get(b.market) ?? 999) ||
          a.model_version.localeCompare(b.model_version) ||
          a.pick_rank - b.pick_rank,
      )
      .map((p) => ({
        market: labelOf(p.model_version, p.market),
        model: p.model_version.includes("-sim-")
          ? "Simulation"
          : (MODEL_NAME[p.model_version] ?? p.model_version),
        player: p.player,
        team: p.team,
        prob: Number(p.prob),
        actual: actualOf(p.market, String(p.player_id)),
        result: !p.settled_at ? "pending" : p.scored == null ? "void" : p.scored ? "hit" : "miss",
      }));

    // who actually did it, and what the board had said about each
    const ranked =
      sim && starMarket
        ? sim
            .map((pl) => ({ id: pl.id, p: probOf(league, pl, starMarket) }))
            .sort((a, b) => b.p - a.p)
        : [];
    const rankOf = new Map(ranked.map((r, i) => [r.id, { rank: i + 1, p: r.p }]));
    const simOf = new Map((sim ?? []).map((pl) => [pl.id, pl]));
    const pickedIds = new Set(mine.map((p) => String(p.player_id)));
    const earlierTd = new Map(
      mine
        .filter((p) => p.market === "anytime_td")
        .map((p) => [String(p.player_id), Number(p.prob)]),
    );
    let doers = g.players.filter((p) => (p.stats[star.stat] ?? 0) >= 1);
    doers.sort((a, b) => (b.stats[star.stat] ?? 0) - (a.stats[star.stat] ?? 0));
    if (league === "nba") doers = doers.slice(0, 5);
    const stars: ResultStar[] = doers.map((p) => {
      const r = rankOf.get(String(p.id));
      const pl = simOf.get(String(p.id));
      return {
        player: p.name,
        team: p.team,
        value: p.stats[star.stat] ?? 0,
        prob: league === "nba" ? null : (r?.p ?? earlierTd.get(String(p.id)) ?? null),
        proj:
          league === "nba" && pl?.mean?.pts != null
            ? projectionOf(league, "pts", pl.mean.pts)
            : null,
        rank: league === "nba" ? null : (r?.rank ?? null),
        of: league === "nba" ? null : ranked.length || null,
        picked: pickedIds.has(String(p.id)),
      };
    });

    const graded = recorded.filter((p) => p.result === "hit" || p.result === "miss");
    return {
      eventId: String(g.event_id),
      date: g.game_date,
      matchup: g.matchup ?? "",
      score: g.final_score ?? "",
      boxUrl: g.box_url ?? boxUrl(league, String(g.event_id)),
      simulated: !!sim,
      stars: { title: star.title, noun: star.noun, rows: stars },
      picks: recorded,
      graded: graded.length,
      hits: graded.filter((p) => p.result === "hit").length,
    };
  });
}
