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
import { supabase } from "@/integrations/supabase/client";
import cfbModel from "./cfb-td-model.json";

export type TdSport = "cfb" | "nfl";

/** Bumped when a model changes in a way that makes old rows incomparable. */
export const TD_MODEL_VERSION: Record<TdSport, string> = {
  cfb: "cfb-td-logistic-v1",
  nfl: "nfl-td-logistic-v1",
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
export const TD_CLAIM: Record<TdSport, { leadHit: number; anyHit: number; source: string }> = {
  cfb: {
    leadHit: 0.563,
    anyHit: cfbModel.holdout.pick_hit_rate,
    source: "held out on 2025–26, CFB-ANALYSIS.md",
  },
  nfl: { leadHit: 0.483, anyHit: 0.483, source: "held out on 2023–24, NFL-TD-SCORER-BACKTEST.md" },
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
  sport: TdSport;
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

export type TdLedgerView = {
  sport: TdSport;
  modelVersion: string;
  /** 'ok' | 'not-provisioned' — the table not existing is a different thing
   *  from having no rows yet, and the page has to be able to say which. */
  status: "ok" | "not-provisioned";
  writable: boolean;
  claim: { leadHit: number; anyHit: number; source: string };
  summary: {
    n: number;
    hits: number;
    hitRate: number | null;
    brier: number | null;
    logLoss: number | null;
    pending: number;
    games: number;
    gamesWithHit: number;
    gameHitRate: number | null;
    firstDate: string | null;
    lastDate: string | null;
  };
  byRank: TdLedgerGroup[];
  byTier: TdLedgerGroup[];
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
  const modelVersion = TD_MODEL_VERSION[sport];
  const empty: TdLedgerView = {
    sport,
    modelVersion,
    status: "ok",
    writable: canTrackTd(),
    claim: TD_CLAIM[sport],
    summary: {
      n: 0,
      hits: 0,
      hitRate: null,
      brier: null,
      logLoss: null,
      pending: 0,
      games: 0,
      gamesWithHit: 0,
      gameHitRate: null,
      firstDate: null,
      lastDate: null,
    },
    byRank: [],
    byTier: [],
    recent: [],
  };

  try {
    const { data, error } = await reader()
      .from("player_predictions")
      .select("*")
      .eq("sport", sport)
      .eq("market", TD_MARKET)
      .eq("provenance", "forward")
      .order("event_date", { ascending: false })
      .limit(2000);
    if (error) {
      // 42P01 is "relation does not exist" — the table was never created, which
      // the page must not report as "no picks yet".
      const missing = /does not exist|schema cache/i.test(error.message);
      if (!missing) console.error(`[td-ledger] read ${sport}:`, error.message);
      return { ...empty, status: missing ? "not-provisioned" : "ok" };
    }
    const rows = (data ?? []) as {
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

    return {
      ...empty,
      summary: {
        n: done.length,
        hits,
        hitRate: done.length ? hits / done.length : null,
        brier: mean(done.map((r) => (r.brier == null ? null : Number(r.brier)))),
        logLoss: mean(done.map((r) => (r.log_loss == null ? null : Number(r.log_loss)))),
        pending: rows.length - done.length,
        games: byGame.size,
        gamesWithHit,
        gameHitRate: byGame.size ? gamesWithHit / byGame.size : null,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
      },
      byRank: group(
        done.map((r) => ({ key: `Pick ${r.pick_rank}`, scored: r.scored })),
        ["Pick 1", "Pick 2", "Pick 3"],
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
    console.error(`[td-ledger] read ${sport}:`, err);
    return empty;
  }
}
