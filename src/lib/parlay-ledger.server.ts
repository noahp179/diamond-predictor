/**
 * parlay-ledger.server.ts — the forward record of the touchdown slips.
 *
 * The pick ledger answers "did this man score". This one answers the question
 * the parlay board actually asks: of the five, ten, fifteen and twenty-leg
 * slips it offered, how many came in.
 *
 * WHY A SLIP CANNOT BE RECONSTRUCTED. Every leg is already a row in
 * player_predictions, so it looks as though a slip's result could be derived
 * by rebuilding the board and looking its legs up. It cannot. The board is
 * rebuilt live on every request — from whatever the slate, the odds and the
 * injury report say at that moment, on a date chosen by a forward scan — so
 * two runs a day apart produce different slips. The only honest record of what
 * was offered is a row written when it was offered.
 *
 * WHY SETTLEMENT READS THE PICK LEDGER rather than the box score. Each leg is
 * already settled there, against an ESPN athlete id. Scoring a slip a second
 * way would create two sources for one fact, and the first time they disagreed
 * there would be no way to say which was right. A slip wins iff every leg is
 * settled and scored — so the two records cannot drift apart by construction.
 *
 * WHAT A ZERO MEANS HERE. A five-leg college slip is about 1 in 5; a twenty-leg
 * one is about 1 in 2,400, and the NFL equivalents are longer still. Over a
 * season the honest expectation at twenty legs is zero. So every number this
 * module reports travels with the EXPECTED count — the sum of the stated
 * probabilities — because without it a column of zeros reads as a broken model
 * rather than as arithmetic working exactly as predicted.
 */
import { supabase } from "@/integrations/supabase/client";
import { supabaseAdmin as _admin } from "@/integrations/supabase/client.server";
import { TD_MODEL_VERSION, type PlayerSport } from "./td-ledger.server";
import { PARLAY_SIZES, DEFAULT_MAX_PER_GAME, SIZE_CAP, type ParlayCandidate } from "./td-parlay";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = { from: (t: string) => any };
const admin = () => _admin as unknown as AnyTable | undefined;
const reader = () => admin() ?? (supabase as unknown as AnyTable);

/**
 * The market recorded, per sport. Football's narrow boards (first TD, 2+ TDs)
 * are parlay-only and can be added here by name once they are worth a season of
 * rows; baseball's slips are built from the 2+ total bases board, which is a
 * different question and so a different market.
 */
export const PARLAY_MARKET_FOR: Record<PlayerSport, string> = {
  cfb: "anytime_td",
  nfl: "anytime_td",
  mlb: "tb2",
};

/** Football's market, kept as a named export because callers and tests that
 *  predate baseball ask for it by this name. */
export const PARLAY_MARKET = PARLAY_MARKET_FOR.nfl;

/** Sizes offered per sport. Baseball stops at fifteen: at a mean leg near a
 *  coin flip a twenty-leg slip is 1 in several million, and offering a number
 *  with nothing attached to it is not offering anything. */
const SIZES_FOR: Record<PlayerSport, number[]> = {
  cfb: PARLAY_SIZES,
  nfl: PARLAY_SIZES,
  mlb: [5, 10, 15],
};

/** The pick ledger's model version for the legs of this sport's slips, so a
 *  slip and its legs are always stamped with the same model. */
async function modelVersionFor(sport: PlayerSport): Promise<string> {
  if (sport !== "mlb") return TD_MODEL_VERSION[sport];
  const { TB2_MODEL_VERSION } = await import("./tb2-ledger.server");
  return TB2_MODEL_VERSION;
}

/**
 * Legs from one game the recorded slip is built with.
 *
 * Football records at the board's default of two per game at every size.
 * Baseball's default is per size — unrestricted at five and ten, three per game
 * at fifteen — because that is what the construction sweep chose once stacking
 * was priced, and the recorded slip has to be the slip a reader was offered.
 */
function capFor(sport: PlayerSport, size: number): number {
  return sport === "mlb" ? (SIZE_CAP.mlb?.[size] ?? Infinity) : DEFAULT_MAX_PER_GAME;
}

export function canTrackParlays(): boolean {
  return admin() !== undefined;
}

type LegRow = {
  event_id: string;
  player_id: string;
  player: string;
  team: string;
  prob: number;
  rank: number;
};

// ------------------------------------------------------------------ write

/**
 * Freeze the slips the board would offer for `date`.
 *
 * Built at the DEFAULT construction only. `maxPerGame` is a reader's control
 * with four settings, and recording all four would quadruple the table to
 * track three slips nobody was shown by default. The column is there so a
 * second construction can be added later without a migration.
 */
export async function snapshotParlays(sport: PlayerSport, date: string): Promise<number> {
  const db = admin();
  if (!db) return 0;
  try {
    const { buildTdParlay } = await import("./td-parlay");
    const candidates: ParlayCandidate[] = [];
    if (sport === "mlb") {
      // Baseball's legs come off the 2+ total bases board, through the same
      // builder the page and the pick ledger use — see twoBaseParlayCandidates
      // for why that sharing is load-bearing rather than tidy.
      const { twoBaseParlayCandidates } = await import("./mlb-tb2.server");
      candidates.push(...(await twoBaseParlayCandidates(date)).candidates);
    } else if (sport === "cfb") {
      const { cfbTdSlate } = await import("./cfb-td.server");
      const { games } = await cfbTdSlate(date);
      for (const g of games) {
        if (g.started) continue;
        for (const p of g.picks)
          candidates.push({
            playerId: p.playerId,
            player: p.player,
            position: p.position,
            team: p.team,
            gameId: g.gameId,
            matchup: g.matchup,
            prob: p.prob,
            tier: p.tier,
            tierHit: p.tierHit,
            reasons: p.reasons,
            against: p.against,
          });
      }
    } else {
      const { tdScorersSlate } = await import("./nfl-td.server");
      const { games } = await tdScorersSlate(date);
      for (const g of games) {
        if (g.started) continue;
        // The same cut the board's parlay draws from, so the recorded slip is
        // the slip a reader was offered rather than a better one.
        for (const p of g.picks.slice(0, 3))
          candidates.push({
            playerId: p.playerId,
            player: p.player,
            position: null,
            team: p.team,
            gameId: g.gameId,
            matchup: g.matchup,
            prob: p.prob,
            tier: null,
            tierHit: null,
            reasons: p.reasons,
            against: p.against,
          });
      }
    }
    if (candidates.length === 0) return 0;

    const version = await modelVersionFor(sport);
    const market = PARLAY_MARKET_FOR[sport];
    const slips = SIZES_FOR[sport].map((size) =>
      buildTdParlay(candidates, size, capFor(sport, size), sport),
    );
    const rows = slips
      // A slip that could not be filled at all is not an offer, and recording
      // it would put a guaranteed loss in the denominator.
      .filter((p) => p.legs.length > 0)
      .map((p) => ({
        sport,
        market,
        model_version: version,
        slate_date: date,
        size: p.size,
        max_per_game: Number.isFinite(p.maxPerGame) ? p.maxPerGame : 0,
        legs: p.legs.map(
          (l): LegRow => ({
            event_id: String(l.gameId),
            player_id: l.playerId,
            player: l.player,
            team: l.team,
            prob: l.prob,
            rank: l.rank,
          }),
        ),
        leg_count: p.legs.length,
        short: p.short,
        stated_prob: p.adjustedProb,
        combined_prob: p.combinedProb,
        correlation_factor: p.correlationFactor,
        fair_price: p.fairPrice,
      }));
    if (rows.length === 0) return 0;

    const { error, count } = await db.from("parlay_predictions").upsert(rows, {
      onConflict: "model_version,slate_date,market,size,max_per_game",
      ignoreDuplicates: true,
      count: "exact",
    });
    if (error) {
      console.error(`[parlay-ledger] insert ${sport} ${date}:`, error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[parlay-ledger] snapshot ${sport} ${date}:`, err);
    return 0;
  }
}

// ----------------------------------------------------------------- settle

/**
 * Score every slip whose legs have all settled.
 *
 * A slip is left alone until EVERY leg has a result. Settling early would
 * write a loss for a slip whose remaining games had not kicked off — and once
 * written, `won = false` looks exactly like a slip that genuinely missed.
 */
export async function settleParlays(throughDate: string, lookbackDays = 28) {
  const db = admin();
  if (!db) return { settled: 0, pending: 0 };
  const since = new Date(`${throughDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const from = since.toISOString().slice(0, 10);

  const { data, error } = await db
    .from("parlay_predictions")
    .select("id, sport, slate_date, legs, model_version")
    .is("settled_at", null)
    .gte("slate_date", from)
    .lte("slate_date", throughDate);
  if (error || !data) {
    if (error) console.error("[parlay-ledger] pending read:", error.message);
    return { settled: 0, pending: 0 };
  }

  let settled = 0;
  for (const slip of data as {
    id: number;
    sport: string;
    slate_date: string;
    legs: LegRow[];
    model_version: string;
  }[]) {
    const legs = slip.legs ?? [];
    if (legs.length === 0) continue;

    // One read per slip, keyed on the same ids the legs were written with.
    const { data: picks, error: pe } = await db
      .from("player_predictions")
      .select("player_id, event_id, scored, settled_at")
      .eq("sport", slip.sport)
      .in("event_id", [...new Set(legs.map((l) => l.event_id))])
      .in("player_id", [...new Set(legs.map((l) => l.player_id))]);
    if (pe || !picks) continue;

    const byKey = new Map<string, { scored: boolean | null; settled: boolean }>();
    for (const p of picks as {
      player_id: string;
      event_id: string;
      scored: boolean | null;
      settled_at: string | null;
    }[]) {
      byKey.set(`${p.event_id}:${p.player_id}`, {
        scored: p.scored,
        settled: p.settled_at != null,
      });
    }

    const resolved = legs.map((l) => byKey.get(`${l.event_id}:${l.player_id}`));
    // Every leg must be present AND settled. A leg missing from the pick
    // ledger is not a loss — it is a slip we cannot score, and it waits.
    if (resolved.some((r) => r == null || !r.settled)) continue;

    // A VOIDED LEG VOIDS THE SLIP. Baseball's pick ledger settles a hitter who
    // never came to the plate with `scored` null rather than false, because a
    // sportsbook voids that bet rather than losing it (see tb2-ledger). A slip
    // carrying such a leg is not the slip whose probability was quoted: the
    // book would re-price it over the legs that stood, and this record has no
    // way to say what that slip was worth. So it is settled with `won` null and
    // drops out of the denominator, which is the only honest thing available —
    // counting it as a loss would punish the board for a lineup card, and
    // leaving it pending forever would quietly hide it.
    const void_ = resolved.some((r) => r!.scored == null);
    const hit = resolved.filter((r) => r!.scored).length;
    const { error: ue } = await db
      .from("parlay_predictions")
      .update({
        legs_hit: void_ ? null : hit,
        won: void_ ? null : hit === legs.length,
        settled_at: new Date().toISOString(),
      })
      .eq("id", slip.id);
    if (!ue) settled += 1;
  }
  return { settled, pending: data.length - settled };
}

// ------------------------------------------------------------------- read

export type ParlaySizeRecord = {
  size: number;
  /** Slips settled — the denominator, and the only honest one. */
  slips: number;
  won: number;
  /** Sum of the stated probabilities: how many wins the board predicted over
   *  exactly these slips. The number that makes a zero readable. */
  expected: number;
  /** Mean stated probability across those slips. */
  stated: number | null;
  /** Mean legs that came in, out of the slip's size. Where the action is when
   *  every slip loses: 17 of 20 is a different model from 9 of 20. */
  meanLegsHit: number | null;
  meanLegs: number | null;
  pending: number;
};

export type ParlayLedgerView = {
  sport: PlayerSport;
  status: "ok" | "not-provisioned" | "unreadable";
  writable: boolean;
  bySize: ParlaySizeRecord[];
  totals: { slips: number; won: number; expected: number; pending: number };
  firstDate: string | null;
  lastDate: string | null;
  recent: {
    date: string;
    size: number;
    legCount: number;
    stated: number;
    legsHit: number | null;
    won: boolean | null;
  }[];
};

export async function readParlayLedger(sport: PlayerSport): Promise<ParlayLedgerView> {
  // A ledger with nothing in it still knows which slips this sport offers, and
  // saying so is not padding. The page's backtest columns — what each size is
  // worth, and how many legs it lands on a typical day — hang off these rows,
  // and returning an empty list printed a table with headers and no body: the
  // one question a reader has before any live data exists ("how likely is a
  // fifteen-leg slip?") answered with nothing at all.
  const blankSizes: ParlaySizeRecord[] = SIZES_FOR[sport].map((size) => ({
    size,
    slips: 0,
    won: 0,
    expected: 0,
    stated: null,
    meanLegsHit: null,
    meanLegs: null,
    pending: 0,
  }));
  const empty: ParlayLedgerView = {
    sport,
    status: "ok",
    writable: canTrackParlays(),
    bySize: blankSizes,
    totals: { slips: 0, won: 0, expected: 0, pending: 0 },
    firstDate: null,
    lastDate: null,
    recent: [],
  };
  try {
    const { data, error } = await reader()
      .from("parlay_predictions")
      .select("*")
      .eq("sport", sport)
      .eq("market", PARLAY_MARKET_FOR[sport])
      .eq("provenance", "forward")
      .order("slate_date", { ascending: false })
      .limit(1000);
    if (error) {
      // PGRST205 is PostgREST for "no such table" — a migration nobody ran,
      // which no amount of waiting fixes. Every other failure is "we do not
      // know what is in there", which is a different sentence.
      const missing =
        (error as { code?: string }).code === "PGRST205" ||
        /could not find the table|does not exist/i.test(error.message ?? "");
      return { ...empty, status: missing ? "not-provisioned" : "unreadable" };
    }
    const rows = (data ?? []) as {
      slate_date: string;
      size: number;
      leg_count: number;
      stated_prob: string | number;
      legs_hit: number | null;
      won: boolean | null;
      settled_at: string | null;
    }[];
    if (rows.length === 0) return empty;

    const done = rows.filter((r) => r.settled_at != null && r.won != null);
    const dates = rows.map((r) => r.slate_date).sort();
    const bySize: ParlaySizeRecord[] = SIZES_FOR[sport].map((size) => {
      const all = rows.filter((r) => r.size === size);
      const settled = all.filter((r) => r.settled_at != null && r.won != null);
      const probs = settled.map((r) => Number(r.stated_prob));
      const hits = settled.map((r) => r.legs_hit).filter((x): x is number => x != null);
      return {
        size,
        slips: settled.length,
        won: settled.filter((r) => r.won).length,
        expected: probs.reduce((s, p) => s + p, 0),
        stated: probs.length ? probs.reduce((s, p) => s + p, 0) / probs.length : null,
        meanLegsHit: hits.length ? hits.reduce((s, h) => s + h, 0) / hits.length : null,
        meanLegs: settled.length
          ? settled.reduce((s, r) => s + r.leg_count, 0) / settled.length
          : null,
        pending: all.length - settled.length,
      };
    });

    return {
      ...empty,
      bySize,
      totals: {
        slips: done.length,
        won: done.filter((r) => r.won).length,
        expected: done.reduce((s, r) => s + Number(r.stated_prob), 0),
        pending: rows.length - done.length,
      },
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      recent: rows.slice(0, 40).map((r) => ({
        date: r.slate_date,
        size: r.size,
        legCount: r.leg_count,
        stated: Number(r.stated_prob),
        legsHit: r.legs_hit,
        won: r.won,
      })),
    };
  } catch (err) {
    console.error(`[parlay-ledger] read ${sport}:`, err);
    return { ...empty, status: "unreadable" };
  }
}
