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
  parseSlug,
  playersFrom,
  probOf,
  simBoard,
  simMarkets,
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
};

export type Box = {
  final: boolean;
  score: string;
  /** player id -> stat values the markets settle on; absent = did not play */
  lines: Map<string, Record<string, number>>;
  /** player id of the first goal / first touchdown, null if none or a team score */
  first: string | null;
};

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
  const lines = new Map<string, Record<string, number>>();
  const names = new Map<string, string>();
  for (const t of d.boxscore?.players ?? [])
    for (const st of t.statistics ?? []) {
      const labels: string[] = st.labels ?? [];
      const keys: string[] = st.keys ?? [];
      for (const a of st.athletes ?? []) {
        const id = a.athlete?.id;
        if (!id || a.didNotPlay || !(a.stats ?? []).length) continue;
        if (a.athlete?.displayName) names.set(String(a.athlete.displayName).toLowerCase(), id);
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
  return { final: true, score, lines, first };
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
    player_id: string;
    market: string;
    prob: number;
  }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("player_predictions")
      .select("id, event_id, player_id, market, prob")
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
};

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
  const { default: nflModel } = await import("./nfl-props-model.json");
  const labels = (nflModel as { markets: Record<string, { label: string }> }).markets;
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
