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
  marketSlug,
  playersFrom,
  probOf,
  SIM_BOARDS,
  simBoard,
  simModelVersion,
  type SimPlayer,
  type SimPropsLeague,
} from "./sim-props-shared";
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
 *  has no cron: its boards use the touchdown model, which beat the simulator
 *  in the backtest. Run by hand, a busy Saturday's ~60 games across 8 slots
 *  get fewer than 100,000 plays each; the time budget decides, and the row
 *  records it. */
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
  // The first slot of the morning grades the earlier days' picks.
  if (slot === 0) await settleSimPicks(league, date, 60_000).catch((e) => console.error(e));
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
  for (const board of SIM_BOARDS[league])
    for (const m of board.markets) {
      const slug = marketSlug(league, m.key);
      const top = row.players
        .map((p) => ({ p, prob: probOf(league, p, m.key) }))
        .filter((x) => x.prob > 0.001)
        .sort((a, b) => b.prob - a.prob)
        .slice(0, 3);
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
};

type Box = {
  final: boolean;
  score: string;
  /** player id -> stat values the markets settle on; absent = did not play */
  lines: Map<string, Record<string, number>>;
  /** player id of the first goal / first touchdown, null if none or a team score */
  first: string | null;
};

/** One finished game, read for settlement. Null while it is not final. */
async function boxFor(league: SimPropsLeague, eventId: string): Promise<Box | null> {
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
  const lines = new Map<string, Record<string, number>>();
  const names = new Map<string, string>();
  for (const t of d.boxscore?.players ?? [])
    for (const st of t.statistics ?? []) {
      const labels: string[] = st.labels ?? st.keys ?? [];
      const keys: string[] = st.keys ?? [];
      for (const a of st.athletes ?? []) {
        const id = a.athlete?.id;
        if (!id || a.didNotPlay || !(a.stats ?? []).length) continue;
        if (a.athlete?.displayName) names.set(String(a.athlete.displayName).toLowerCase(), id);
        const row = lines.get(id) ?? {};
        const v = (k: string) =>
          Number(a.stats[labels.indexOf(k)] ?? a.stats[keys.indexOf(k)] ?? 0) || 0;
        if (league === "nba") {
          if (v("MIN") > 0) row.pts = v("PTS");
          else continue;
        } else if (league === "nhl") {
          if (st.name === "goalies") continue;
          row.g = v("G");
          row.a = v("A");
          row.pts = row.g + row.a;
        } else {
          if (st.name === "rushing") row.td = (row.td ?? 0) + v("rushingTouchdowns");
          else if (st.name === "receiving") row.td = (row.td ?? 0) + v("receivingTouchdowns");
          else row.td = row.td ?? 0;
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
  return { final: true, score, lines, first };
}

function outcome(league: SimPropsLeague, market: string, box: Box, pid: string): boolean | null {
  const ln = box.lines.get(pid);
  if (!ln) return null; // did not play: void
  if (market === "firstgoal" || market === "firsttd") return box.first === pid;
  const m = market.match(/^(pts|g|a|td)(\d+)$/);
  if (!m) return null;
  return (ln[m[1]] ?? 0) >= Number(m[2]);
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
  const { data, error } = await db
    .from("player_predictions")
    .select("id, event_id, player_id, market, prob")
    .eq("sport", league)
    .like("model_version", `${league}-sim-%`)
    .is("settled_at", null)
    .gte("event_date", since.toISOString().slice(0, 10))
    .lte("event_date", throughDate);
  if (error) return { settled: 0, error: error.message };
  const byGame = new Map<string, any[]>();
  for (const r of data ?? []) byGame.set(r.event_id, [...(byGame.get(r.event_id) ?? []), r]);
  let settled = 0;
  for (const [eventId, rows] of byGame) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      const box = await boxFor(league, eventId);
      if (!box) continue;
      const now = new Date().toISOString();
      for (const r of rows) {
        const hit = outcome(league, r.market, box, String(r.player_id));
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
        const { error: uErr } = await db.from("player_predictions").update(upd).eq("id", r.id);
        if (!uErr) settled += 1;
      }
    } catch (err) {
      console.error(`[sim-props] settle ${league} ${eventId}:`, err);
    }
  }
  return { settled };
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
