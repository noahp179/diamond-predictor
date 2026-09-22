/**
 * tb2-ledger.server.ts — did the hitters we picked actually get two bases?
 *
 * The same discipline as the touchdown ledger, on baseball's board: rows are
 * written before first pitch, scored afterwards from the box score, and never
 * revised. It writes to the same `player_predictions` table under the market
 * `tb2`, which is what that table's `market` column was put there for.
 *
 * SETTLED ON MLB PERSON ID, AND ON totalBases
 * -------------------------------------------
 * Both the pick and the box score come from the MLB Stats API keyed by person
 * id, so settlement is a lookup rather than a name match. The event is exactly
 * the one the model was fitted to — `totalBases >= 2` in that game, which is
 * research/mlb-tb2/features_tb2.py's `y_tb2` — so the ledger cannot be scored
 * on a broader event than the board predicts.
 *
 * A HITTER WHO DID NOT BAT IS A VOID, NOT A MISS
 * ----------------------------------------------
 * This is the one place baseball needs a concept football does not. Lineup
 * cards land about two hours before first pitch; before that the board projects
 * off the team's most recent order, so a pick can be on somebody who is rested,
 * scratched or traded that afternoon. He then records no plate appearance.
 *
 * Scoring that as a miss would be wrong twice over. The model was fitted on
 * batter-GAMES — players who batted — so a non-appearance is not in the
 * population it predicts. And a sportsbook voids a 2+ total bases prop when the
 * player does not play, so a miss is not what a reader holding that bet
 * experiences either. Such a row is settled with `scored` left NULL and
 * `final_score` marked DNP: it leaves the record rather than being counted as a
 * loss, and the read path already ignores rows whose `scored` is null.
 *
 * WHAT THE BOARD CLAIMS
 * ---------------------
 * research/mlb-tb2/board_claim_tb2.py, measured on 2026 — the season the model
 * never saw — over the three hitters a game card actually shows. Not the
 * model file's `top1`/`top3`, which are the best one and three hitters on the
 * WHOLE SLATE and much stronger selections: 0.535 against 0.431. Quoting those
 * as the card's claim would have held this ledger to a bar the card never
 * cleared and shown ten points of underperformance that was not there.
 */
import { supabaseAdmin as _admin } from "@/integrations/supabase/client.server";
import { readPlayerLedger, type TdLedgerView, type TdPickRow } from "./td-ledger.server";
import claim from "../../research/mlb-tb2/board_claim_tb2.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = { from: (t: string) => any };
const admin = () => _admin as unknown as AnyTable | undefined;

const API = "https://statsapi.mlb.com/api/v1";

/** Bumped when the model changes in a way that makes old rows incomparable. */
export const TB2_MODEL_VERSION = "mlb-tb2-logistic-v1";
export const TB2_MARKET = "tb2";

/** How many hitters a game card leads with. Rows at this rank or better are
 *  the card; anything deeper is recorded only because a slip needs it. */
const SHOWN_PER_GAME = 3;

/** Slip sizes baseball offers, and so the slips whose legs must be recorded. */
const PARLAY_SIZES_MLB = [5, 10, 15];

export const TB2_CLAIM = {
  leadHit: claim.leadHit,
  anyHit: claim.anyHit,
  gameHit: claim.gameHit,
  source: "held out on 2026, research/mlb-tb2/board_claim_tb2.py",
  // WORTH READING BEFORE THE LIVE NUMBERS ARRIVE: on the held-out season these
  // are 0.431, 0.418, 0.430 — flat. The board's ordering WITHIN a game carries
  // essentially no information at the top three, which is not the same as the
  // model carrying none: the best hitter on the whole slate got there 53.5% of
  // the time against a 35% base rate. The signal is across games, not within
  // one, and that is exactly why the parlay draws its legs from the whole slate
  // rather than one per game.
  byRank: claim.byRank as Record<string, number>,
};

export function canTrackTb2(): boolean {
  return admin() !== undefined;
}

// ------------------------------------------------------------------ write

/**
 * Record the 2+ bases picks for one date.
 *
 * The same three hitters per game the card leads with, from the same function
 * the page calls, so the ledger cannot drift from what a reader was shown.
 * Games already under way are skipped and duplicates are ignored, so running
 * the cron twice in a day changes nothing.
 */
export async function snapshotTb2Picks(date: string): Promise<number> {
  const db = admin();
  if (!db) return 0;
  try {
    const { twoBaseParlayCandidates } = await import("./mlb-tb2.server");
    const { buildTdParlay, SIZE_CAP } = await import("./td-parlay");
    const { slate, candidates } = await twoBaseParlayCandidates(date);
    const live = new Set(candidates.map((c) => c.gameId));

    // WHAT GETS RECORDED: the card's three hitters per game, PLUS every leg of
    // every slip the parlay ledger will freeze for this date.
    //
    // The second half is not belt and braces, it is the thing that makes a slip
    // scoreable. settleParlays joins a slip's legs against this table on
    // (event_id, player_id), and baseball's slips draw from the whole slate
    // rather than from the card — a leg can be the fifth-best hitter in its
    // game. Record only the card and that slip has a leg with no row, so it
    // never settles and sits pending forever instead of failing loudly.
    //
    // `pick_rank` is the hitter's rank within his own game either way, so the
    // card is exactly the rows with rank <= 3 and the ledger read can hold the
    // card to the card's record without the extra legs flattering or dragging
    // it. See readTb2Ledger.
    const legIds = new Set<string>();
    for (const size of PARLAY_SIZES_MLB) {
      const slip = buildTdParlay(candidates, size, SIZE_CAP.mlb?.[size] ?? Infinity, "mlb");
      for (const l of slip.legs) legIds.add(`${l.gameId}:${l.playerId}`);
    }

    const rows: TdPickRow[] = [];
    for (const g of slate.byGame) {
      if (!live.has(g.gameId)) continue;
      g.picks.forEach((p, i) => {
        const rank = i + 1;
        if (rank > SHOWN_PER_GAME && !legIds.has(`${g.gameId}:${p.playerId}`)) return;
        rows.push({
          sport: "mlb",
          market: TB2_MARKET,
          model_version: TB2_MODEL_VERSION,
          event_id: String(g.gameId),
          event_date: date,
          player_id: String(p.playerId),
          player: p.player,
          team: p.team,
          // The batting slot is the closest thing a hitter has to a position
          // for this board's purposes, and it is what the card shows.
          position: `Bats ${p.slot}`,
          matchup: g.matchup,
          pick_rank: rank,
          prob: p.prob,
          tier: p.tier,
        });
      });
    }
    if (rows.length === 0) return 0;
    const { error, count } = await db.from("player_predictions").upsert(rows, {
      onConflict: "model_version,event_id,player_id",
      ignoreDuplicates: true,
      count: "exact",
    });
    if (error) {
      console.error(`[tb2-ledger] insert ${date}:`, error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[tb2-ledger] snapshot ${date}:`, err);
    return 0;
  }
}

// ----------------------------------------------------------------- settle

/** Which games on a date have finished. One call covers the whole day. */
async function finalGames(date: string): Promise<Set<string>> {
  const res = await fetch(`${API}/schedule?sportId=1&date=${date}&gameType=R`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`StatsAPI schedule ${res.status} for ${date}`);
  const d = (await res.json()) as {
    dates?: { games?: { gamePk?: number; status?: { abstractGameState?: string } }[] }[];
  };
  const done = new Set<string>();
  for (const day of d.dates ?? [])
    for (const g of day.games ?? [])
      if (g.status?.abstractGameState === "Final" && g.gamePk) done.add(String(g.gamePk));
  return done;
}

/**
 * Total bases and plate appearances per person id in one finished game.
 *
 * Both numbers are needed, and the second is the one that does the work: zero
 * total bases and zero plate appearances is a hitter who never came to the
 * plate, which is a void rather than a miss.
 */
async function boxScoreBases(
  gamePk: string,
): Promise<{ tb: Map<string, number>; pa: Map<string, number>; score: string }> {
  const res = await fetch(`${API}/game/${gamePk}/boxscore`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`StatsAPI boxscore ${res.status} for ${gamePk}`);
  const d = (await res.json()) as {
    teams?: Record<
      string,
      {
        teamStats?: { batting?: { runs?: number } };
        players?: Record<
          string,
          { person?: { id?: number }; stats?: { batting?: Record<string, number> } }
        >;
      }
    >;
  };
  const tb = new Map<string, number>();
  const pa = new Map<string, number>();
  const runs: Record<string, number> = {};
  for (const side of ["away", "home"] as const) {
    const t = d.teams?.[side];
    runs[side] = Number(t?.teamStats?.batting?.runs ?? 0);
    for (const p of Object.values(t?.players ?? {})) {
      const id = p.person?.id;
      const b = p.stats?.batting;
      if (!id || !b) continue;
      tb.set(String(id), Number(b.totalBases ?? 0));
      pa.set(String(id), Number(b.plateAppearances ?? 0));
    }
  }
  return { tb, pa, score: `${runs.away ?? 0}-${runs.home ?? 0}` };
}

/**
 * Score every unsettled 2+ bases pick whose game has finished.
 *
 * One schedule call per date establishes what is final; one box score per game
 * settles all of that game's picks together. Anything unresolved — postponed,
 * suspended, still playing — is left pending for the next run.
 */
export async function settleTb2Picks(throughDate: string, lookbackDays = 14) {
  const db = admin();
  if (!db) return { settled: 0, voided: 0, pending: 0 };

  const since = new Date(`${throughDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const from = since.toISOString().slice(0, 10);

  const { data, error } = await db
    .from("player_predictions")
    .select("id, event_id, event_date, player_id, prob")
    .eq("sport", "mlb")
    .eq("market", TB2_MARKET)
    .is("settled_at", null)
    .gte("event_date", from)
    .lte("event_date", throughDate);
  if (error) {
    console.error("[tb2-ledger] settle read failed:", error.message);
    return { settled: 0, voided: 0, pending: 0 };
  }
  const pending = (data ?? []) as {
    id: number;
    event_id: string;
    event_date: string;
    player_id: string;
    prob: number;
  }[];
  if (pending.length === 0) return { settled: 0, voided: 0, pending: 0 };

  // One schedule read per date tells us which games are worth a box score.
  const finals = new Map<string, Set<string>>();
  for (const date of new Set(pending.map((r) => r.event_date))) {
    try {
      finals.set(date, await finalGames(date));
    } catch (err) {
      console.error(`[tb2-ledger] schedule ${date}:`, err);
    }
  }

  const byGame = new Map<string, typeof pending>();
  for (const r of pending) {
    if (!finals.get(r.event_date)?.has(r.event_id)) continue;
    byGame.set(r.event_id, [...(byGame.get(r.event_id) ?? []), r]);
  }

  let settled = 0;
  let voided = 0;
  for (const [gamePk, rows] of byGame) {
    try {
      const box = await boxScoreBases(gamePk);
      const now = new Date().toISOString();
      for (const r of rows) {
        const bases = box.tb.get(r.player_id);
        const appearances = box.pa.get(r.player_id) ?? 0;
        // No plate appearance: the hitter the board projected did not bat. A
        // void, written as such — see the module note.
        const played = bases != null && appearances > 0;
        const hit = played && bases >= 2;
        const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(r.prob)));
        const { error: uErr } = await db
          .from("player_predictions")
          .update(
            played
              ? {
                  scored: hit,
                  touchdowns: bases,
                  brier: (p - (hit ? 1 : 0)) ** 2,
                  log_loss: -Math.log(hit ? p : 1 - p),
                  final_score: box.score,
                  settled_at: now,
                }
              : {
                  scored: null,
                  touchdowns: null,
                  brier: null,
                  log_loss: null,
                  final_score: "DNP",
                  settled_at: now,
                },
          )
          .eq("id", r.id);
        if (uErr) console.error(`[tb2-ledger] settle ${r.id}:`, uErr.message);
        else if (played) settled += 1;
        else voided += 1;
      }
    } catch (err) {
      console.error(`[tb2-ledger] settle ${gamePk}:`, err);
    }
  }
  return { settled, voided, pending: pending.length - settled - voided };
}

// ------------------------------------------------------------------- read

/**
 * The live record for the 2+ bases board — the CARD's record.
 *
 * Capped at the three hitters a game card shows, because the table also carries
 * deeper picks that exist only so the slips can be settled. Averaging those in
 * would answer a question nobody asked: they are not on the card, and on most
 * nights they are the strongest bats in a game the card already leads with, so
 * they would quietly lift the board's stated hit rate above what a reader of
 * the card actually experienced.
 */
export async function readTb2Ledger(): Promise<TdLedgerView> {
  return readPlayerLedger({
    sport: "mlb",
    market: TB2_MARKET,
    modelVersion: TB2_MODEL_VERSION,
    claim: TB2_CLAIM,
    countLabel: "total bases",
    maxRank: SHOWN_PER_GAME,
  });
}
