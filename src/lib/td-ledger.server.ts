/**
 * td-ledger.server.ts — did the player we picked actually score?
 *
 * The touchdown boards show hit rates from a held-out backtest. That is a real
 * claim and a weaker one than it sounds: a backtest is repeatable, so the
 * person running it chooses when to stop, knowing how each choice looked. This
 * module records the other kind of number — the picks that were on the board
 * the morning of a game, scored afterwards from the box score, with no chance
 * to revise them.
 *
 * Three parts:
 *
 *   snapshotTdPicks   write the day's picks, before kickoff only
 *   settleTdPicks     look up each picked player in the finished box score
 *   readTdLedger      what the record says, next to what the backtest claimed
 *
 * SETTLED ON ATHLETE ID, NEVER ON NAME
 * ------------------------------------
 * Both the pick and the box score come from ESPN keyed by athlete id, so
 * settlement is a lookup rather than a string match. This matters more in
 * college than anywhere: a roster carries brothers, juniors and seniors sharing
 * a surname, and ESPN spells a name differently in different feeds often
 * enough that matching on it would quietly mis-score some fraction of rows
 * forever, in whichever direction nobody checked.
 *
 * WHAT COUNTS AS A HIT
 * --------------------
 * A rushing or receiving touchdown — exactly the event the model was fitted to
 * predict. A punt return or a defensive recovery is a touchdown to a
 * sportsbook and is deliberately not one here, because scoring the ledger on a
 * broader event than the model predicts would flatter it for free.
 */
import { supabaseAdmin as _admin } from "@/integrations/supabase/client.server";
import { bucketise, PLAYER_BANDS, type Bucket } from "./ledger-stats";
import { supabase } from "@/integrations/supabase/client";
import cfbModel from "./cfb-td-forest.json";

export type TdSport = "cfb" | "nfl";

/** Bumped when a model changes in a way that makes old rows incomparable. */
export const TD_MODEL_VERSION: Record<TdSport, string> = {
  cfb: "cfb-td-extratrees-v1",
  nfl: "nfl-td-pairrank-v1",
};

export const TD_MARKET = "anytime_td";

const ESPN_PATH: Record<TdSport, string> = {
  cfb: "football/college-football",
  nfl: "football/nfl",
};

/**
 * What the held-out backtest said to expect, so the page can show the record
 * against the claim rather than in place of it.
 *
 * College comes from the model file, which `final.py` writes — one source of
 * truth, so the claim cannot drift from the fit. The NFL numbers are from
 * NFL-TD-SCORER-BACKTEST.md, whose research predates this ledger and does not
 * export a machine-readable claim; they are quoted here rather than invented.
 */
/**
 * What the held-out backtest claimed, for the live ledger to be measured
 * against. Three numbers because the board makes three different claims:
 *
 *   leadHit  the pick the card leads with
 *   anyHit   every pick the card SHOWS, lead and tail together. Much lower than
 *            leadHit by construction — the fourth name on a card is not the
 *            first — and it is the number to compare a raw hit rate against.
 *   gameHit  games where any shown pick scored. The reader's question if they
 *            take the whole card rather than one name.
 *
 * NFL's entry described the retired logistic until 2026-09-20, and not only the
 * wrong model: it carried anyHit 0.483, the LEAD pick's rate, as though it were
 * the rate across all four shown picks. The real figure is 0.370, so the page
 * was holding the live ledger to a claim eleven points too generous and would
 * have read as underperformance that was not there. Re-measured by
 * research/nfl-td-scorer (board_claim.json) on the seasons the ranker never saw.
 */
export const TD_CLAIM: Record<
  TdSport,
  { leadHit: number; anyHit: number; gameHit: number; source: string }
> = {
  cfb: {
    leadHit: 0.581,
    anyHit: cfbModel.holdout.pick_hit_rate,
    gameHit: cfbModel.holdout.game_hit_rate,
    source: "held out on 2025–26, CFB-ANALYSIS.md",
  },
  nfl: {
    leadHit: 0.4917,
    anyHit: 0.3704,
    gameHit: 0.8405,
    source: "held out on 2025–26, NFL-BAKEOFF.md",
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = {
  from: (t: string) => any;
};
const admin = () => _admin as unknown as AnyTable | undefined;
/** Reads prefer the service-role client; the public one needs Vite's env. */
const reader = () => admin() ?? (supabase as unknown as AnyTable);

export function canTrackTd(): boolean {
  return admin() !== undefined;
}

// ------------------------------------------------------------------ write

export type TdPickRow = {
  sport: PlayerSport;
  market: string;
  model_version: string;
  event_id: string;
  event_date: string;
  player_id: string;
  player: string;
  team: string;
  position: string | null;
  matchup: string;
  pick_rank: number;
  prob: number;
  tier: string | null;
};

/**
 * Record the touchdown picks for one date.
 *
 * What gets written is what the board rendered that morning — the same call,
 * from the same function the page uses — so the ledger cannot drift from what a
 * reader was actually shown. Games already under way are skipped, and the
 * insert ignores duplicates, so running the cron twice in a day changes
 * nothing.
 */
export async function snapshotTdPicks(sport: TdSport, date: string): Promise<number> {
  const db = admin();
  if (!db) return 0;
  const version = TD_MODEL_VERSION[sport];
  try {
    const rows: TdPickRow[] = [];
    if (sport === "cfb") {
      const { cfbTdSlate } = await import("./cfb-td.server");
      const { games } = await cfbTdSlate(date);
      for (const g of games) {
        if (g.started) continue;
        g.picks.forEach((p, i) => {
          rows.push({
            sport,
            market: TD_MARKET,
            model_version: version,
            event_id: String(g.gameId),
            event_date: date,
            player_id: p.playerId,
            player: p.player,
            team: p.team,
            position: p.position || null,
            matchup: g.matchup,
            pick_rank: i + 1,
            prob: p.prob,
            tier: p.tier,
          });
        });
      }
    } else {
      const { tdScorersSlate } = await import("./nfl-td.server");
      const { games } = await tdScorersSlate(date);
      for (const g of games) {
        if (g.started) continue;
        // The NFL card renders three names; the ledger records what was shown.
        g.picks.slice(0, 3).forEach((p, i) => {
          rows.push({
            sport,
            market: TD_MARKET,
            model_version: version,
            event_id: String(g.gameId),
            event_date: date,
            player_id: p.playerId,
            player: p.player,
            team: p.team,
            position: null,
            matchup: g.matchup,
            pick_rank: i + 1,
            prob: p.prob,
            tier: null,
          });
        });
      }
    }
    if (rows.length === 0) return 0;
    const { error, count } = await db.from("player_predictions").upsert(rows, {
      onConflict: "model_version,event_id,player_id",
      ignoreDuplicates: true,
      count: "exact",
    });
    if (error) {
      console.error(`[td-ledger] insert ${sport} ${date}:`, error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[td-ledger] snapshot ${sport} ${date}:`, err);
    return 0;
  }
}

// ----------------------------------------------------------------- settle

/** Rushing + receiving touchdowns per athlete id in one finished game, plus
 *  the final score for the row to carry. Null when the game has no box score
 *  yet, which is the normal state of a game that has not finished. */
async function boxScoreTds(
  sport: TdSport,
  eventId: string,
): Promise<{ tds: Map<string, number>; score: string; final: boolean } | null> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[sport]}/summary?event=${eventId}`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${sport} ${eventId}`);
  const d = (await res.json()) as {
    header?: {
      competitions?: {
        status?: { type?: { completed?: boolean } };
        competitors?: { homeAway?: string; score?: string }[];
      }[];
    };
    boxscore?: {
      players?: { statistics?: { name?: string; keys?: string[]; athletes?: unknown[] }[] }[];
    };
  };
  const comp = d.header?.competitions?.[0];
  const final = comp?.status?.type?.completed === true;
  if (!final) return null;

  const tds = new Map<string, number>();
  for (const tb of d.boxscore?.players ?? []) {
    for (const cat of tb.statistics ?? []) {
      if (cat.name !== "rushing" && cat.name !== "receiving") continue;
      const keys = cat.keys ?? [];
      const field = cat.name === "rushing" ? "rushingTouchdowns" : "receivingTouchdowns";
      const idx = keys.indexOf(field);
      if (idx < 0) continue;
      for (const a of (cat.athletes ?? []) as {
        athlete?: { id?: string };
        stats?: string[];
      }[]) {
        const id = a.athlete?.id;
        if (!id) continue;
        const n = Number(a.stats?.[idx]);
        tds.set(String(id), (tds.get(String(id)) ?? 0) + (Number.isFinite(n) ? n : 0));
      }
    }
  }
  const home = comp?.competitors?.find((c) => c.homeAway === "home")?.score ?? "";
  const away = comp?.competitors?.find((c) => c.homeAway === "away")?.score ?? "";
  return { tds, score: away && home ? `${away}-${home}` : "", final: true };
}

/**
 * Score every unsettled touchdown pick whose game has finished.
 *
 * One box-score fetch per game settles all of that game's picks together.
 * Anything unresolved — postponed, still playing, no box score published — is
 * left pending and picked up on the next run.
 *
 * A player who appears in no box-score row did not record a carry or a catch,
 * which is a legitimate zero rather than missing data: he was active enough to
 * be picked and did not score. Scoring it as a miss is the honest reading, and
 * treating it as unsettled instead would quietly drop the board's worst calls
 * out of the record.
 */
export async function settleTdPicks(throughDate: string, lookbackDays = 21) {
  const db = admin();
  if (!db) return { settled: 0, pending: 0 };

  const since = new Date(`${throughDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const from = since.toISOString().slice(0, 10);

  const { data, error } = await db
    .from("player_predictions")
    .select("id, sport, event_id, event_date, player_id, prob")
    .is("settled_at", null)
    .gte("event_date", from)
    .lte("event_date", throughDate);
  if (error) {
    console.error("[td-ledger] settle read failed:", error.message);
    return { settled: 0, pending: 0 };
  }
  const pending = (data ?? []) as {
    id: number;
    sport: TdSport;
    event_id: string;
    event_date: string;
    player_id: string;
    prob: number;
  }[];
  if (pending.length === 0) return { settled: 0, pending: 0 };

  // Group by game: one fetch settles every pick in it.
  const games = new Map<string, typeof pending>();
  for (const r of pending) {
    const k = `${r.sport}|${r.event_id}`;
    games.set(k, [...(games.get(k) ?? []), r]);
  }

  let settled = 0;
  for (const [key, rows] of games) {
    const [sport, eventId] = key.split("|") as [TdSport, string];
    try {
      const box = await boxScoreTds(sport, eventId);
      if (!box) continue; // not final yet
      const now = new Date().toISOString();
      for (const r of rows) {
        const tds = box.tds.get(r.player_id) ?? 0;
        const scored = tds > 0;
        const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(r.prob)));
        const { error: uErr } = await db
          .from("player_predictions")
          .update({
            scored,
            touchdowns: tds,
            brier: (p - (scored ? 1 : 0)) ** 2,
            log_loss: -Math.log(scored ? p : 1 - p),
            final_score: box.score || null,
            settled_at: now,
          })
          .eq("id", r.id);
        if (uErr) console.error(`[td-ledger] settle ${r.id}:`, uErr.message);
        else settled += 1;
      }
    } catch (err) {
      console.error(`[td-ledger] settle ${key}:`, err);
    }
  }
  return { settled, pending: pending.length - settled };
}

// ------------------------------------------------------------------- read

export type TdLedgerRow = {
  date: string;
  player: string;
  team: string;
  position: string | null;
  matchup: string;
  rank: number;
  prob: number;
  tier: string | null;
  scored: boolean | null;
  touchdowns: number | null;
};

export type TdLedgerGroup = { label: string; n: number; hits: number; hitRate: number | null };

/** Sports that write player-level picks to `player_predictions`. MLB's market
 *  is 2+ total bases rather than touchdowns; the table and the read path do not
 *  care, which is what its `market` column is for. */
export type PlayerSport = TdSport | "mlb";

export type TdLedgerView = {
  sport: PlayerSport;
  modelVersion: string;
  /**
   * Three states, because two of them look identical on an empty page and only
   * one is fixed by waiting:
   *
   *   ok              the table is readable. Zero rows means zero picks so far.
   *   not-provisioned the table does not exist. Nothing is being recorded and
   *                   nothing will be until the migration is applied.
   *   unreadable      the read failed for some other reason. Not "no picks" —
   *                   we do not know what is in there.
   */
  status: "ok" | "not-provisioned" | "unreadable";
  writable: boolean;
  claim: {
    leadHit: number;
    anyHit: number;
    gameHit: number;
    source: string;
    /** Held-out hit rate per card position, where the backtest measured one.
     *  The check on whether the board's own ordering means anything — and on
     *  baseball it already says no, which the page is better off saying than
     *  waiting a season to discover. */
    byRank?: Record<string, number>;
  };
  summary: {
    n: number;
    hits: number;
    hitRate: number | null;
    brier: number | null;
    logLoss: number | null;
    pending: number;
    /**
     * Picks settled with no result to score — baseball's hitter who never came
     * to the plate. Counted separately from `pending`, which was where they
     * landed when the only two states were "scored" and "not yet": a void is
     * finished, it is simply not a hit or a miss, and filing it under pending
     * made a settled ledger look permanently behind.
     */
    voided: number;
    games: number;
    gamesWithHit: number;
    gameHitRate: number | null;
    firstDate: string | null;
    lastDate: string | null;
  };
  /** What the picks are called on the page. Touchdowns for football, total
   *  bases for baseball — the ledger stores a count either way and only the
   *  word differs, so it travels with the view instead of being guessed from
   *  the sport at three separate render sites. */
  countLabel: string;
  byRank: TdLedgerGroup[];
  byTier: TdLedgerGroup[];
  /** Hit rate by stated-probability band, so the board can be checked against
   *  its own claims rather than only against its backtest. Uses PLAYER_BANDS,
   *  not the game-outcome bands — see ledger-stats.ts for why. */
  calibration: Bucket[];
  /** Cumulative hit rate over settled picks, oldest first. The series a reader
   *  needs to see whether a gap is a trend or the first fifty calls. */
  running: { i: number; date: string; accuracy: number }[];
  /** One row per day that settled anything, oldest first. */
  daily: { date: string; n: number; correct: number; accuracy: number }[];
  recent: TdLedgerRow[];
};

function group(rows: { key: string; scored: boolean | null }[], order?: string[]): TdLedgerGroup[] {
  const m = new Map<string, { n: number; hits: number }>();
  for (const r of rows) {
    if (r.scored == null) continue;
    const cur = m.get(r.key) ?? { n: 0, hits: 0 };
    cur.n += 1;
    if (r.scored) cur.hits += 1;
    m.set(r.key, cur);
  }
  const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort();
  return keys.map((k) => {
    const v = m.get(k)!;
    return { label: k, n: v.n, hits: v.hits, hitRate: v.n ? v.hits / v.n : null };
  });
}

/** The live record for one sport's touchdown board. */
export async function readTdLedger(sport: TdSport): Promise<TdLedgerView> {
  return readPlayerLedger({
    sport,
    market: TD_MARKET,
    modelVersion: TD_MODEL_VERSION[sport],
    claim: TD_CLAIM[sport],
    countLabel: "touchdowns",
  });
}

/**
 * The live record for one player board, whatever it predicts.
 *
 * Everything below this line is market-agnostic and always was — the rows come
 * out of one table filtered by sport and market, and the arithmetic on them is
 * hit rates, Brier, calibration bands and a running series. Baseball's 2+ bases
 * board reads through here rather than through a second copy of it, because two
 * copies of a ledger reader is two places for the hit rate to be computed
 * differently.
 */
export async function readPlayerLedger(opts: {
  sport: PlayerSport;
  market: string;
  modelVersion: string;
  claim: TdLedgerView["claim"];
  countLabel: string;
  /** Pick ranks the board actually shows, in card order. */
  rankOrder?: string[];
  /**
   * Deepest pick rank that counts as the card.
   *
   * Baseball's table carries rows deeper than the card, recorded only so its
   * slips can be settled leg by leg (see snapshotTb2Picks). Those are real
   * forward picks, but they are not what a reader was shown, so a record of
   * "the board" has to leave them out or it reports a hit rate nobody saw.
   */
  maxRank?: number;
}): Promise<TdLedgerView> {
  const { sport, market, modelVersion, claim, countLabel } = opts;
  const maxRank = opts.maxRank ?? Infinity;
  const rankOrder = opts.rankOrder ?? ["Pick 1", "Pick 2", "Pick 3"];
  const empty: TdLedgerView = {
    sport,
    modelVersion,
    status: "ok",
    writable: canTrackTd(),
    claim,
    countLabel,
    summary: {
      n: 0,
      hits: 0,
      hitRate: null,
      brier: null,
      logLoss: null,
      pending: 0,
      voided: 0,
      games: 0,
      gamesWithHit: 0,
      gameHitRate: null,
      firstDate: null,
      lastDate: null,
    },
    byRank: [],
    byTier: [],
    calibration: [],
    running: [],
    daily: [],
    recent: [],
  };

  try {
    const { data, error } = await reader()
      .from("player_predictions")
      .select("*")
      .eq("sport", sport)
      .eq("market", market)
      .eq("provenance", "forward")
      .order("event_date", { ascending: false })
      .limit(2000);
    if (error) {
      // PGRST205 is PostgREST for "no such table". Telling it apart from every
      // other read failure is the whole point of the status field: this one is
      // a deployment step nobody ran, and no amount of waiting fixes it. The
      // rest are unknown, and reporting them as "no picks yet" would be the
      // same reassuring lie the event ledger used to tell.
      const missing =
        (error as { code?: string }).code === "PGRST205" ||
        /Could not find the table/i.test(error.message ?? "");
      console.error(
        missing
          ? "[td-ledger] player_predictions does not exist — apply supabase/migrations/20260913120000_player_predictions.sql"
          : `[td-ledger] read ${sport}/${market} failed: ${error.message}`,
      );
      return { ...empty, status: missing ? "not-provisioned" : "unreadable" };
    }
    const all = (data ?? []) as {
      event_id: string;
      event_date: string;
      player: string;
      team: string;
      position: string | null;
      matchup: string;
      pick_rank: number;
      prob: number;
      tier: string | null;
      scored: boolean | null;
      touchdowns: number | null;
      brier: number | null;
      log_loss: number | null;
      settled_at: string | null;
    }[];
    const rows = all.filter((r) => r.pick_rank <= maxRank);
    if (rows.length === 0) return empty;

    const done = rows.filter((r) => r.settled_at != null && r.scored != null);
    const hits = done.filter((r) => r.scored).length;
    const dates = rows.map((r) => r.event_date).sort();

    // Per game: did any shown pick score? The card is what a reader acts on,
    // so "the card had a hit" is a different and fairer question than "this
    // individual name hit".
    const byGame = new Map<string, boolean>();
    for (const r of done) byGame.set(r.event_id, (byGame.get(r.event_id) ?? false) || !!r.scored);
    const gamesWithHit = [...byGame.values()].filter(Boolean).length;

    const mean = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };

    // The query comes back newest-first so the recent table reads correctly.
    // A running series has to read the other way, so it is sorted here rather
    // than reversing the query and breaking the table.
    const chrono = [...done].sort(
      (a, b) => a.event_date.localeCompare(b.event_date) || a.pick_rank - b.pick_rank,
    );
    let seen = 0;
    const byDay = new Map<string, { n: number; hits: number }>();
    for (const r of chrono) {
      const cur = byDay.get(r.event_date) ?? { n: 0, hits: 0 };
      cur.n += 1;
      if (r.scored) cur.hits += 1;
      byDay.set(r.event_date, cur);
    }

    return {
      ...empty,
      summary: {
        n: done.length,
        hits,
        hitRate: done.length ? hits / done.length : null,
        brier: mean(done.map((r) => (r.brier == null ? null : Number(r.brier)))),
        logLoss: mean(done.map((r) => (r.log_loss == null ? null : Number(r.log_loss)))),
        pending: rows.filter((r) => r.settled_at == null).length,
        voided: rows.filter((r) => r.settled_at != null && r.scored == null).length,
        games: byGame.size,
        gamesWithHit,
        gameHitRate: byGame.size ? gamesWithHit / byGame.size : null,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
      },
      calibration: bucketise(
        done.map((r) => ({ pickProb: Number(r.prob), correct: !!r.scored })),
        PLAYER_BANDS,
      ),
      running: chrono.map((r, i) => {
        seen += r.scored ? 1 : 0;
        return { i: i + 1, date: r.event_date, accuracy: seen / (i + 1) };
      }),
      daily: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date,
          n: v.n,
          correct: v.hits,
          accuracy: v.n ? v.hits / v.n : 0,
        })),
      byRank: group(
        done.map((r) => ({ key: `Pick ${r.pick_rank}`, scored: r.scored })),
        rankOrder,
      ),
      byTier: group(
        done.filter((r) => r.tier).map((r) => ({ key: r.tier as string, scored: r.scored })),
        ["Strong", "Solid", "Lean"],
      ),
      recent: rows.slice(0, 60).map((r) => ({
        date: r.event_date,
        player: r.player,
        team: r.team,
        position: r.position,
        matchup: r.matchup,
        rank: r.pick_rank,
        prob: Number(r.prob),
        tier: r.tier,
        scored: r.scored,
        touchdowns: r.touchdowns,
      })),
    };
  } catch (err) {
    console.error(`[td-ledger] read ${sport}/${market}:`, err);
    return empty;
  }
}
