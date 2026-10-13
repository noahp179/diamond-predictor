/**
 * prop-ledger.server.ts — the forward record for every player-prop board that
 * did not have one: MLB player props, NFL player props, the five soccer
 * leagues' player props, and MLB team stacks.
 *
 * The touchdown boards and baseball's 2+ bases board have been written down
 * and scored for weeks (td-ledger, tb2-ledger). These boards were shown to
 * readers every day and never recorded, so nobody — including the site — could
 * say whether their percentages held up. Same discipline as the others:
 *
 *   - WHAT IS RECORDED is exactly the card a reader sees by default: each
 *     game's top five picks, one rung per player (props-board.ts boardPicks),
 *     from the same functions the pages call. Stacks record every team total
 *     and stack card the board offers.
 *   - WHEN: before the game starts. Anything under way is skipped. Rows are
 *     write-once — UNIQUE (model_version, event_id, player_id) — so a second run
 *     cannot revise a call.
 *   - SCORED by the same rule the market's model was fitted to, from the box
 *     score, keyed on the provider's player id, never a name. A player who did
 *     not play is a VOID (settled, `scored` NULL), as a sportsbook voids it —
 *     not a miss.
 *
 * Each board's benchmark is its own published probability: a pick shown at 60%
 * should hit about 60% of the time. The record reports both, per market.
 */

import { supabaseAdmin as _admin } from "@/integrations/supabase/client.server";
import { boardPicks } from "./props-board";
import { DOMESTIC_LEAGUES, type LeagueSlug } from "./soccer-leagues";
import { readPlayerLedger, type TdLedgerView, type TdPickRow } from "./td-ledger.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTable = { from: (t: string) => any };
const admin = () => _admin as unknown as AnyTable | undefined;

/** Bumped when a model changes in a way that makes old rows incomparable. */
export const PROP_MODEL_VERSION = {
  mlb: "mlb-props-logistic-v1",
  nfl: "nfl-props-logistic-v1",
  soccer: (slug: LeagueSlug) => `soccer-props-${slug}-v1`,
  stacks: "mlb-stacks-v1",
} as const;

/** The default card: this many picks per game. Mirrors props-board PER_GAME. */
const CARD = 5;

export function canTrackProps(): boolean {
  return admin() !== undefined;
}

const notStarted = (iso: string) => !iso || new Date(iso).getTime() > Date.now();

async function insertPicks(rows: TdPickRow[], tag: string): Promise<number> {
  const db = admin();
  if (!db || rows.length === 0) return 0;
  const { error, count } = await db.from("player_predictions").upsert(rows, {
    onConflict: "model_version,event_id,player_id",
    ignoreDuplicates: true,
    count: "exact",
  });
  if (error) {
    console.error(`[prop-ledger] insert ${tag}:`, error.message);
    return 0;
  }
  return count ?? 0;
}

// ------------------------------------------------------------------ write

export async function snapshotMlbProps(date: string): Promise<number> {
  try {
    const { propsSlate } = await import("./mlb-props.server");
    const slate = await propsSlate(date);
    const rows: TdPickRow[] = [];
    for (const g of slate.games) {
      if (!notStarted(g.startsAt)) continue;
      boardPicks(g.picks, "all", false).forEach((p, i) =>
        rows.push({
          sport: "mlb",
          market: p.market,
          model_version: PROP_MODEL_VERSION.mlb,
          event_id: String(g.gameId),
          event_date: date,
          player_id: String(p.playerId),
          player: p.player,
          team: p.team,
          position: p.kind === "pitcher" ? "SP" : p.slot ? `Bats ${p.slot}` : "Bat",
          matchup: g.matchup,
          pick_rank: i + 1,
          prob: p.prob,
          tier: p.tier,
        }),
      );
    }
    return await insertPicks(rows, `mlb ${date}`);
  } catch (err) {
    console.error(`[prop-ledger] mlb snapshot ${date}:`, err);
    return 0;
  }
}

export async function snapshotNflProps(date: string): Promise<number> {
  try {
    const { propsSlate } = await import("./nfl-props.server");
    const slate = await propsSlate(date);
    const rows: TdPickRow[] = [];
    for (const g of slate.games) {
      if (!notStarted(g.date)) continue;
      boardPicks(g.picks, "all", false).forEach((p, i) =>
        rows.push({
          sport: "nfl",
          market: p.market,
          model_version: PROP_MODEL_VERSION.nfl,
          event_id: String(g.gameId),
          event_date: date,
          player_id: p.playerId,
          player: p.player,
          team: p.team,
          position: p.kind === "qb" ? "QB" : null,
          matchup: g.matchup,
          pick_rank: i + 1,
          prob: p.prob,
          tier: p.tier,
        }),
      );
    }
    return await insertPicks(rows, `nfl ${date}`);
  } catch (err) {
    console.error(`[prop-ledger] nfl snapshot ${date}:`, err);
    return 0;
  }
}

export async function snapshotSoccerProps(slug: LeagueSlug, date: string): Promise<number> {
  try {
    const { soccerProps } = await import("./soccer-props.server");
    const slate = await soccerProps(slug, date);
    const rows: TdPickRow[] = [];
    for (const f of slate.fixtures) {
      if (!notStarted(f.kickoff)) continue;
      boardPicks(f.picks, "all", false).forEach((p, i) =>
        rows.push({
          sport: "soccer",
          market: p.market,
          model_version: PROP_MODEL_VERSION.soccer(slug),
          event_id: f.matchId,
          event_date: date,
          player_id: p.playerId,
          player: p.player,
          team: p.team,
          position: p.pos || null,
          matchup: f.matchup,
          pick_rank: i + 1,
          prob: p.prob,
          tier: p.tier,
        }),
      );
    }
    return await insertPicks(rows, `soccer ${slug} ${date}`);
  } catch (err) {
    console.error(`[prop-ledger] soccer ${slug} snapshot ${date}:`, err);
    return 0;
  }
}

type StackLegRow =
  | { kind: "team"; line: number; label: string; prob: number }
  | { kind: "batter"; playerId: string; market: string; label: string; prob: number };

export async function snapshotStacks(date: string): Promise<number> {
  const db = admin();
  if (!db) return 0;
  try {
    const { stacksSlate } = await import("./mlb-stacks.server");
    const slate = await stacksSlate(date);
    const rows: Record<string, unknown>[] = [];
    for (const t of slate.teams) {
      if (!notStarted(t.startsAt)) continue;
      const base = {
        sport: "mlb",
        model_version: PROP_MODEL_VERSION.stacks,
        event_id: String(t.gameId),
        event_date: date,
        team_id: String(t.teamId),
        team: t.team,
        matchup: t.matchup,
      };
      for (const tot of t.totals) {
        const leg: StackLegRow = { kind: "team", line: tot.line, label: tot.label, prob: tot.prob };
        rows.push({
          ...base,
          card_key: `total:${tot.market}`,
          kind: "total",
          legs: [leg],
          leg_count: 1,
          prob: tot.prob,
          independent_prob: tot.prob,
          tier: tot.tier,
        });
      }
      // Stack cards anchor on the over-4.5 team total (mlb-stacks buildCards).
      const anchor = t.totals.find((x) => x.market === "r5");
      for (const c of t.cards) {
        const legs: StackLegRow[] = c.legs.map((l) =>
          l.kind === "team"
            ? { kind: "team", line: anchor?.line ?? 4.5, label: l.label, prob: l.prob }
            : {
                kind: "batter",
                playerId: String(l.playerId),
                market: "tb2",
                label: l.label,
                prob: l.prob,
              },
        );
        rows.push({
          ...base,
          card_key: c.key,
          kind: "stack",
          legs,
          leg_count: legs.length,
          prob: c.prob,
          independent_prob: c.independent,
          tier: c.tier,
        });
      }
    }
    if (rows.length === 0) return 0;
    const { error, count } = await db.from("stack_predictions").upsert(rows, {
      onConflict: "model_version,event_id,team_id,card_key",
      ignoreDuplicates: true,
      count: "exact",
    });
    if (error) {
      console.error(`[prop-ledger] stacks insert ${date}:`, error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error(`[prop-ledger] stacks snapshot ${date}:`, err);
    return 0;
  }
}

// ------------------------------------------------------------- MLB box score

const MLB_API = "https://statsapi.mlb.com/api/v1";

/** Final MLB games on a date, any game type (the boards are regular season,
 *  but nothing here should silently refuse a postseason game). */
async function mlbFinals(date: string): Promise<Set<string>> {
  const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}`, {
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

type MlbBox = {
  bat: Map<
    string,
    { pa: number; h: number; tb: number; hr: number; rbi: number; r: number; sb: number }
  >;
  pit: Map<string, { k: number; outs: number; gs: number }>;
  runs: Map<string, number>;
  score: string;
};

export async function mlbBox(gamePk: string): Promise<MlbBox> {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`StatsAPI boxscore ${res.status} for ${gamePk}`);
  const d = (await res.json()) as {
    teams?: Record<
      string,
      {
        team?: { id?: number };
        teamStats?: { batting?: { runs?: number } };
        players?: Record<
          string,
          {
            person?: { id?: number };
            stats?: { batting?: Record<string, number>; pitching?: Record<string, number> };
          }
        >;
      }
    >;
  };
  const box: MlbBox = { bat: new Map(), pit: new Map(), runs: new Map(), score: "" };
  const scoreParts: number[] = [];
  for (const side of ["away", "home"] as const) {
    const t = d.teams?.[side];
    const runs = Number(t?.teamStats?.batting?.runs ?? 0);
    scoreParts.push(runs);
    if (t?.team?.id) box.runs.set(String(t.team.id), runs);
    for (const p of Object.values(t?.players ?? {})) {
      const id = p.person?.id;
      if (!id) continue;
      const b = p.stats?.batting;
      if (b && Object.keys(b).length)
        box.bat.set(String(id), {
          pa: Number(b.plateAppearances ?? 0),
          h: Number(b.hits ?? 0),
          tb: Number(b.totalBases ?? 0),
          hr: Number(b.homeRuns ?? 0),
          rbi: Number(b.rbi ?? 0),
          r: Number(b.runs ?? 0),
          sb: Number(b.stolenBases ?? 0),
        });
      const pi = p.stats?.pitching;
      if (pi && Object.keys(pi).length)
        box.pit.set(String(id), {
          k: Number(pi.strikeOuts ?? 0),
          outs: Number(pi.outs ?? 0),
          gs: Number(pi.gamesStarted ?? 0),
        });
    }
  }
  box.score = `${scoreParts[0] ?? 0}-${scoreParts[1] ?? 0}`;
  return box;
}

// ----------------------------------------------------------------- settle

type Pending = {
  id: number;
  sport: string;
  model_version: string;
  market: string;
  event_id: string;
  event_date: string;
  player_id: string;
  prob: number;
};

const scoreRow = (prob: number, hit: boolean) => {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(prob)));
  return { brier: (p - (hit ? 1 : 0)) ** 2, log_loss: -Math.log(hit ? p : 1 - p) };
};

/** Outcomes for one game's picks: true / false, or null for a void. Undefined
 *  for the whole game while it is not final. */
async function outcomesFor(
  model: string,
  eventId: string,
  date: string,
  rows: Pending[],
  finalsMlb: Map<string, Set<string>>,
): Promise<{ outcomes: Map<number, boolean | null>; score: string } | undefined> {
  const out = new Map<number, boolean | null>();
  if (model === PROP_MODEL_VERSION.mlb) {
    if (!finalsMlb.has(date)) finalsMlb.set(date, await mlbFinals(date));
    if (!finalsMlb.get(date)!.has(eventId)) return undefined;
    const { mlbPropOutcome } = await import("./mlb-props.server");
    const box = await mlbBox(eventId);
    for (const r of rows)
      out.set(
        r.id,
        mlbPropOutcome(
          r.market,
          box.bat.get(r.player_id) ?? null,
          box.pit.get(r.player_id) ?? null,
        ),
      );
    return { outcomes: out, score: box.score };
  }
  if (model === PROP_MODEL_VERSION.nfl) {
    const { fetchScoreboard } = await import("./espn.server");
    const game = (await fetchScoreboard("nfl", date)).find((g) => String(g.id) === eventId);
    if (!game || game.state !== "post") return undefined;
    const { fetchSummary } = await import("./nfl-espn.server");
    const { nflPropOutcome } = await import("./nfl-props.server");
    const box = await fetchSummary(Number(eventId));
    if (!box) return undefined;
    const players = new Map(box.teams.flatMap((t) => t.players.map((p) => [p.id, p] as const)));
    for (const r of rows) out.set(r.id, nflPropOutcome(r.market, players.get(r.player_id)));
    return { outcomes: out, score: `${game.awayScore ?? ""}-${game.homeScore ?? ""}` };
  }
  const soccer = DOMESTIC_LEAGUES.find((l) => PROP_MODEL_VERSION.soccer(l.slug) === model);
  if (soccer) {
    const { soccerMatchLines, soccerPropOutcome } = await import("./soccer-props.server");
    const lines = await soccerMatchLines(soccer.slug, eventId);
    if (!lines) return undefined;
    const byId = new Map(lines.map((l) => [l.playerId, l] as const));
    for (const r of rows) out.set(r.id, soccerPropOutcome(r.market, byId.get(r.player_id)));
    // Home-away, as the other ledgers write it. Own goals are credited to no
    // player line, so this can read low by one on the rare own goal; the score
    // is for reading the row, not for settling it.
    const sum = (home: number) =>
      lines.filter((l) => l.isHome === home).reduce((s, l) => s + l.goal, 0);
    return { outcomes: out, score: `${sum(1)}-${sum(0)}` };
  }
  return undefined;
}

/**
 * Score every unsettled prop pick (and stack card) whose game has finished.
 * One box score per game settles all of its picks. A time budget keeps a slow
 * provider from running the cron out of time; whatever is left is picked up
 * next run.
 */
export async function settlePropPicks(throughDate: string, lookbackDays = 60, budgetMs = 90_000) {
  const db = admin();
  if (!db) return { settled: 0, voided: 0, pending: 0, stacks: 0 };
  const deadline = Date.now() + budgetMs;
  const since = new Date(`${throughDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const from = since.toISOString().slice(0, 10);

  const models = [
    PROP_MODEL_VERSION.mlb,
    PROP_MODEL_VERSION.nfl,
    ...DOMESTIC_LEAGUES.map((l) => PROP_MODEL_VERSION.soccer(l.slug)),
  ];
  const pending: Pending[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("player_predictions")
      .select("id, sport, model_version, market, event_id, event_date, player_id, prob")
      .in("model_version", models)
      .is("settled_at", null)
      .gte("event_date", from)
      .lte("event_date", throughDate)
      .order("event_date", { ascending: true })
      .range(offset, offset + 999);
    if (error) {
      console.error("[prop-ledger] settle read failed:", error.message);
      break;
    }
    pending.push(...((data ?? []) as Pending[]));
    if (!data || data.length < 1000) break;
  }

  const byGame = new Map<string, Pending[]>();
  for (const r of pending) {
    const k = `${r.model_version}|${r.event_id}|${r.event_date}`;
    const g = byGame.get(k);
    if (g) g.push(r);
    else byGame.set(k, [r]);
  }

  let settled = 0;
  let voided = 0;
  const finalsMlb = new Map<string, Set<string>>();
  for (const [key, rows] of byGame) {
    if (Date.now() > deadline) break;
    const [model, eventId, date] = key.split("|");
    try {
      const res = await outcomesFor(model, eventId, date, rows, finalsMlb);
      if (!res) continue;
      const now = new Date().toISOString();
      await Promise.all(
        rows.map(async (r) => {
          const o = res.outcomes.get(r.id);
          const patch =
            o == null
              ? { scored: null, brier: null, log_loss: null, final_score: "DNP", settled_at: now }
              : { scored: o, ...scoreRow(r.prob, o), final_score: res.score, settled_at: now };
          const { error } = await db
            .from("player_predictions")
            .update(patch)
            .eq("id", r.id)
            .is("settled_at", null);
          if (error) console.error(`[prop-ledger] settle ${r.id}:`, error.message);
          else if (o == null) voided += 1;
          else settled += 1;
        }),
      );
    } catch (err) {
      console.error(`[prop-ledger] settle ${key}:`, err);
    }
  }

  const stacks = Date.now() < deadline ? await settleStacks(from, throughDate, finalsMlb) : 0;
  return { settled, voided, pending: pending.length - settled - voided, stacks };
}

async function settleStacks(
  from: string,
  through: string,
  finalsMlb: Map<string, Set<string>>,
): Promise<number> {
  const db = admin()!;
  const { data, error } = await db
    .from("stack_predictions")
    .select("id, event_id, event_date, team_id, legs, prob")
    .is("settled_at", null)
    .gte("event_date", from)
    .lte("event_date", through)
    .limit(1000);
  if (error) {
    // The table is new; until its migration runs there is nothing to settle.
    if (!/does not exist|Could not find the table/i.test(error.message ?? ""))
      console.error("[prop-ledger] stacks read failed:", error.message);
    return 0;
  }
  const rows = (data ?? []) as {
    id: number;
    event_id: string;
    event_date: string;
    team_id: string;
    legs: StackLegRow[];
    prob: number;
  }[];
  const byGame = new Map<string, typeof rows>();
  for (const r of rows) byGame.set(r.event_id, [...(byGame.get(r.event_id) ?? []), r]);

  let n = 0;
  for (const [gamePk, cards] of byGame) {
    try {
      const date = cards[0].event_date;
      if (!finalsMlb.has(date)) finalsMlb.set(date, await mlbFinals(date));
      if (!finalsMlb.get(date)!.has(gamePk)) continue;
      const box = await mlbBox(gamePk);
      const now = new Date().toISOString();
      for (const c of cards) {
        let hit = 0;
        let voidLeg = false;
        for (const l of c.legs) {
          if (l.kind === "team") {
            if ((box.runs.get(c.team_id) ?? 0) > l.line) hit += 1;
          } else {
            const b = box.bat.get(l.playerId);
            if (!b || b.pa <= 0) voidLeg = true;
            else if (b.tb >= 2) hit += 1;
          }
        }
        const won = voidLeg ? null : hit === c.legs.length;
        const { error: uErr } = await db
          .from("stack_predictions")
          .update({
            legs_hit: hit,
            won,
            ...(won == null ? { brier: null, log_loss: null } : scoreRow(c.prob, won)),
            final_score: voidLeg ? "DNP" : box.score,
            settled_at: now,
          })
          .eq("id", c.id);
        if (!uErr) n += 1;
      }
    } catch (err) {
      console.error(`[prop-ledger] stacks settle ${gamePk}:`, err);
    }
  }
  return n;
}

// ------------------------------------------------------------------- read

export type PropBoardKey = "mlb" | "nfl" | LeagueSlug;

/** The live record of one props board — every market it offers. */
export async function readPropBoard(board: PropBoardKey): Promise<TdLedgerView> {
  const sport = board === "mlb" ? "mlb" : board === "nfl" ? "nfl" : "soccer";
  const modelVersion =
    board === "mlb"
      ? PROP_MODEL_VERSION.mlb
      : board === "nfl"
        ? PROP_MODEL_VERSION.nfl
        : PROP_MODEL_VERSION.soccer(board as LeagueSlug);
  return readPlayerLedger({
    sport,
    market: null,
    modelVersion,
    exactModel: true,
    countLabel: "picks",
    rankOrder: ["Pick 1", "Pick 2", "Pick 3", "Pick 4", "Pick 5"],
    maxRank: CARD,
  });
}

export type StackRecord = {
  status: "ok" | "not-provisioned" | "unreadable";
  byKind: { kind: "total" | "stack"; n: number; won: number; expected: number | null }[];
  pending: number;
  recent: {
    date: string;
    team: string;
    label: string;
    prob: number;
    won: boolean | null;
    settled: boolean;
  }[];
};

/** The live record of the Team Stacks board: team totals and stack cards. */
export async function readStackLedger(): Promise<StackRecord> {
  const { supabase } = await import("@/integrations/supabase/client");
  const db = (admin() ?? (supabase as unknown as AnyTable)) as AnyTable;
  const empty: StackRecord = { status: "ok", byKind: [], pending: 0, recent: [] };
  try {
    const { data, error } = await db
      .from("stack_predictions")
      .select("event_date, team, kind, legs, prob, won, settled_at")
      .eq("provenance", "forward")
      .order("event_date", { ascending: false })
      .limit(2000);
    if (error) {
      const missing = /does not exist|Could not find the table/i.test(error.message ?? "");
      return { ...empty, status: missing ? "not-provisioned" : "unreadable" };
    }
    const rows = (data ?? []) as {
      event_date: string;
      team: string;
      kind: "total" | "stack";
      legs: StackLegRow[];
      prob: number;
      won: boolean | null;
      settled_at: string | null;
    }[];
    const byKind = (["total", "stack"] as const).map((kind) => {
      const done = rows.filter((r) => r.kind === kind && r.settled_at && r.won != null);
      return {
        kind,
        n: done.length,
        won: done.filter((r) => r.won).length,
        expected: done.length ? done.reduce((s, r) => s + Number(r.prob), 0) / done.length : null,
      };
    });
    return {
      status: "ok",
      byKind,
      pending: rows.filter((r) => !r.settled_at).length,
      recent: rows.slice(0, 40).map((r) => ({
        date: r.event_date,
        team: r.team,
        label: r.legs.map((l) => l.label).join(" + "),
        prob: Number(r.prob),
        won: r.won,
        settled: r.settled_at != null,
      })),
    };
  } catch (err) {
    console.error("[prop-ledger] stacks read:", err);
    return { ...empty, status: "unreadable" };
  }
}

/**
 * Record and settle every props board. Its own cron, because building the
 * boards is heavy — soccer's replays a season of match reports per league —
 * and the event-and-touchdown cron already fills its time.
 *
 * Settlement first (cheap, and never starved), then today's cards. Soccer
 * leagues with no fixtures today cost one scoreboard call each.
 */
export async function runPropCycle(today: string, budgetMs = 240_000) {
  const start = Date.now();
  const settled = await settlePropPicks(today);
  const left = () => budgetMs - (Date.now() - start);
  const recorded: Record<string, number> = {};
  const jobs: [string, () => Promise<number>][] = [
    ["nfl", () => snapshotNflProps(today)],
    ["mlb", () => snapshotMlbProps(today)],
    ["stacks", () => snapshotStacks(today)],
    ...DOMESTIC_LEAGUES.map(
      (l) => [l.slug, () => snapshotSoccerProps(l.slug, today)] as [string, () => Promise<number>],
    ),
  ];
  for (const [name, job] of jobs) {
    if (left() < 20_000) {
      recorded[name] = -1; // skipped for time; logged below
      continue;
    }
    recorded[name] = await job();
  }
  const skipped = Object.entries(recorded).filter(([, v]) => v < 0);
  if (skipped.length)
    console.warn(`[prop-ledger] out of time, skipped: ${skipped.map(([k]) => k).join(", ")}`);
  return { today, settled, recorded };
}
