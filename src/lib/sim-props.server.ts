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

import { playersFrom, type SimPlayer, type SimPropsLeague } from "./sim-props-shared";
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

/** Games per scheduled slot, sized so a slot's games fit its time budget at
 *  100,000 plays (about a minute a game for basketball, football; a little
 *  more for hockey). */
export const PER_SLOT: Record<SimPropsLeague, number> = { nba: 3, nhl: 3, nfl: 3, cfb: 8 };
/** Scheduled slots per league (vercel.json has one cron per slot). College
 *  Saturdays run ~60 games across 8 slots, so a busy one gets fewer than
 *  100,000 plays a game — the time budget decides, and the row records it. */
export const SLOTS: Record<SimPropsLeague, number> = { nba: 5, nhl: 6, nfl: 6, cfb: 8 };

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
  const play = runner(m, { benched: [], activated: [] });
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
  const players = playersFrom(league, r, { home: g.home.abbr, away: g.away.abbr });
  return { players, runs: n, basis: m.ctx.basis };
}

/**
 * One scheduled slot: games [slot*per, slot*per+per) of the date's slate, in
 * start order, each played up to TARGET_RUNS times within `budgetMs`. A game
 * already stored today with the full count, or already under way, is skipped.
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
  const slate = (await buildSlate(league as SimLeague, date))
    .filter((g) => g.state === "pre")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  const per = PER_SLOT[league];
  const mine = slate.slice(slot * per, slot * per + per);
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
