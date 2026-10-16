import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { readLedger } from "./tracking.server";
import { isLeagueSlug, LEAGUES } from "./soccer-leagues";
import { isTourSlug, TOURS } from "./tennis-tours";
import soccerModels from "./soccer-match-model.json";
import { UCL_MODEL } from "./ucl-model";
import tennisModels from "./tennis-match-model.json";

/**
 * The Track Record pages need two numbers side by side and must never confuse
 * them: what the backtest CLAIMED, and what the live ledger has actually
 * recorded since it started. This returns both, plus the sample size, so the
 * page can say "too early to tell" when that is the truth.
 */

const input = z.object({ sport: z.string(), division: z.string() });

type SoccerModel = {
  backtest: { rps: number; acc: number; brier: number; logloss: number; n: number };
};
type TennisModel = {
  backtest: { logloss: number; acc: number; brier: number; auc: number; n: number };
};

const SOCCER = soccerModels as unknown as Record<string, SoccerModel>;
const TENNIS = tennisModels as unknown as Record<string, TennisModel>;

/** How many settled calls before the live rate is worth reading at all. */
export const MEANINGFUL_N = 100;

function claimFor(sport: string, division: string) {
  // NFL and NBA never had a held-out backtest to claim: their old Track Record
  // pages replayed recent seasons and reported that as the record. There is no
  // honest number to put in the "claimed" column, so the column stays empty
  // rather than being filled with the replay it just replaced.
  if (sport === "nfl" || sport === "nba") return null;
  if (sport === "soccer" && division === "ucl") {
    const b = UCL_MODEL.backtest.pooled.goals;
    return { accuracy: b.acc, brier: b.brier, logLoss: b.logloss, rps: b.rps, n: b.n };
  }
  if (sport === "soccer") {
    const m = SOCCER[division];
    if (!m) return null;
    return {
      accuracy: m.backtest.acc,
      brier: m.backtest.brier,
      logLoss: m.backtest.logloss,
      rps: m.backtest.rps,
      n: m.backtest.n,
    };
  }
  const m = TENNIS[division];
  if (!m) return null;
  return {
    accuracy: m.backtest.acc,
    brier: m.backtest.brier,
    logLoss: m.backtest.logloss,
    rps: null,
    n: m.backtest.n,
  };
}

/**
 * Normalise the request.
 *
 * NFL and NBA have no divisions, so their division IS the sport — one ledger
 * slice each. Soccer and tennis fall back to a default slug rather than
 * trusting the URL, since an unknown division would otherwise read as an empty
 * ledger and look identical to "nothing has settled".
 */
function resolve(data: { sport: string; division: string }) {
  if (data.sport === "nfl" || data.sport === "nba") {
    return { sport: data.sport, division: data.sport } as const;
  }
  const sport = data.sport === "tennis" ? "tennis" : "soccer";
  const valid = sport === "soccer" ? isLeagueSlug(data.division) : isTourSlug(data.division);
  const division = valid ? data.division : sport === "soccer" ? "epl" : "atp";
  return { sport, division } as const;
}

export const getTrackLedger = createServerFn({ method: "GET" })
  .inputValidator(input)
  .handler(async ({ data }) => {
    const { sport, division } = resolve(data);
    const ledger = await readLedger(sport, division, "forward");
    return {
      ...ledger,
      /** What the held-out backtest said to expect. Never mixed into the live numbers. */
      claim: claimFor(sport, division),
      meaningfulN: MEANINGFUL_N,
      divisions:
        sport === "soccer"
          ? LEAGUES.map((l) => ({ slug: l.slug, name: l.name }))
          : sport === "tennis"
            ? TOURS.map((t) => ({ slug: t.slug, name: t.name }))
            : [],
    };
  });

/**
 * The live touchdown record: picks written before kickoff, scored from the box
 * score afterwards. Served next to the backtest's claim rather than in place of
 * it — a page that quietly falls back to the backtest when the ledger is empty
 * would be worse than one with no record at all.
 */
export const getTdLedger = createServerFn({ method: "GET" })
  .inputValidator(z.object({ sport: z.enum(["cfb", "nfl"]) }))
  .handler(async ({ data }) => {
    const { readTdLedger } = await import("./td-ledger.server");
    return readTdLedger(data.sport);
  });

/**
 * The live 2+ total bases record — the same shape as the touchdown ledger, so
 * one component renders both. Its own function rather than a sport on that one
 * because it answers a different question and carries a different claim.
 */
export const getTb2Ledger = createServerFn({ method: "GET" }).handler(async () => {
  const { readTb2Ledger } = await import("./tb2-ledger.server");
  return readTb2Ledger();
});

/** The 5/10/15/20 slips as offered, and how they came in. */
export const getParlayLedger = createServerFn({ method: "GET" })
  .inputValidator(z.object({ sport: z.enum(["cfb", "nfl", "mlb"]) }))
  .handler(async ({ data }) => {
    const { readParlayLedger } = await import("./parlay-ledger.server");
    return readParlayLedger(data.sport);
  });

// ------------------------------------------------------------ board records

/**
 * How one prop board's picks have actually done, in one plain shape for every
 * board — single picks, slips and stacks alike — so one component can show
 * any of them the same way: how many hit, how many the board said would, and
 * the same per bet type. See BoardRecord.tsx.
 */
export type BoardRecordData = {
  status: "ok" | "not-provisioned" | "unreadable";
  /** What one unit is called: "picks", "slips", "cards". */
  unit: string;
  n: number;
  hits: number;
  /** Mean published probability of the settled ones — what the board said. */
  expected: number | null;
  pending: number;
  voided: number;
  firstDate: string | null;
  lastDate: string | null;
  byType: { label: string; n: number; hits: number; expected: number | null }[];
  recent: {
    date: string;
    who: string;
    what: string;
    prob: number;
    result: "hit" | "miss" | "void" | "pending";
  }[];
  /** Said once, plainly, when the board cannot have a record yet. */
  note: string | null;
};

const boardInput = z.object({ sport: z.string(), board: z.string() });

export const getBoardRecord = createServerFn({ method: "GET" })
  .inputValidator(boardInput)
  .handler(async ({ data }): Promise<BoardRecordData> => {
    const { sport, board } = data;
    const empty: BoardRecordData = {
      status: "ok",
      unit: "picks",
      n: 0,
      hits: 0,
      expected: null,
      pending: 0,
      voided: 0,
      firstDate: null,
      lastDate: null,
      byType: [],
      recent: [],
      note: null,
    };

    // ---- slips
    if (board === "parlays" && (sport === "mlb" || sport === "nfl" || sport === "cfb")) {
      const { readParlayLedger } = await import("./parlay-ledger.server");
      const v = await readParlayLedger(sport);
      return {
        ...empty,
        status: v.status,
        unit: "slips",
        n: v.totals.slips,
        hits: v.totals.won,
        expected: v.totals.slips ? v.totals.expected / v.totals.slips : null,
        pending: v.totals.pending,
        firstDate: v.firstDate,
        lastDate: v.lastDate,
        byType: v.bySize
          .filter((s) => s.slips > 0)
          .map((s) => ({
            label: `${s.size}-leg slip`,
            n: s.slips,
            hits: s.won,
            expected: s.slips ? s.expected / s.slips : null,
          })),
        recent: v.recent.map((r) => ({
          date: r.date,
          who: `${r.size}-leg slip`,
          what: r.legsHit != null ? `${r.legsHit} of ${r.legCount} legs hit` : `${r.legCount} legs`,
          prob: r.stated,
          result: r.won == null ? "pending" : r.won ? "hit" : "miss",
        })),
        note:
          sport === "mlb"
            ? "Slips are recorded the morning of every regular-season and playoff game day."
            : null,
      };
    }

    // ---- stacks
    if (board === "stacks" && sport === "mlb") {
      const { readStackLedger } = await import("./prop-ledger.server");
      const v = await readStackLedger();
      const settled = v.byKind.reduce((s, k) => s + k.n, 0);
      const won = v.byKind.reduce((s, k) => s + k.won, 0);
      const exp = v.byKind.reduce((s, k) => s + (k.expected ?? 0) * k.n, 0);
      return {
        ...empty,
        status: v.status,
        unit: "cards",
        n: settled,
        hits: won,
        expected: settled ? exp / settled : null,
        pending: v.pending,
        byType: v.byKind
          .filter((k) => k.n > 0)
          .map((k) => ({
            label: k.kind === "total" ? "Team runs over the line" : "Team + hitter stacks",
            n: k.n,
            hits: k.won,
            expected: k.expected,
          })),
        recent: v.recent.map((r) => ({
          date: r.date,
          who: r.team,
          what: r.label,
          prob: r.prob,
          result: !r.settled ? "pending" : r.won == null ? "void" : r.won ? "hit" : "miss",
        })),
        note: "Cards are recorded the morning of every regular-season and playoff game.",
      };
    }

    // ---- single picks
    const labels = await marketLabels(sport);
    let view: import("./td-ledger.server").TdLedgerView | null = null;
    let note: string | null = null;
    const { simBoard } = await import("./sim-props-shared");
    if (
      (sport === "nba" || sport === "nhl" || sport === "nfl" || sport === "mlb") &&
      simBoard(sport, board)
    ) {
      // The simulation boards: one model version per market (sim-props.server).
      const { readSimBoard } = await import("./sim-props.server");
      view = await readSimBoard(sport, board);
      note = "Picks are recorded from the first morning the simulations run.";
    } else if (board === "td-scorers" && (sport === "nfl" || sport === "cfb")) {
      const { readTdLedger } = await import("./td-ledger.server");
      view = await readTdLedger(sport);
    } else if (board === "two-bases" && sport === "mlb") {
      const { readTb2Ledger } = await import("./tb2-ledger.server");
      view = await readTb2Ledger();
      note = "Picks are recorded the morning of every regular-season and playoff game.";
    } else if (board === "players" && (sport === "mlb" || sport === "nfl")) {
      const { readPropBoard } = await import("./prop-ledger.server");
      view = await readPropBoard(sport);
      if (sport === "mlb")
        note = "Picks are recorded the morning of every regular-season and playoff game.";
    } else if (sport === "soccer") {
      const { readPropBoard } = await import("./prop-ledger.server");
      const { isLeagueSlug } = await import("./soccer-leagues");
      if (isLeagueSlug(board) && board !== "ucl") view = await readPropBoard(board);
    }
    if (!view) return empty;
    const s = view.summary;
    const exp = view.byMarket.reduce((t, m) => t + (m.expected ?? 0) * m.n, 0);
    return {
      ...empty,
      status: view.status,
      n: s.n,
      hits: s.hits,
      expected: s.n ? exp / s.n : null,
      pending: s.pending,
      voided: s.voided,
      firstDate: s.firstDate,
      lastDate: s.lastDate,
      byType: view.byMarket.map((m) => ({
        label: labels[m.market] ?? m.market,
        n: m.n,
        hits: m.hits,
        expected: m.expected,
      })),
      recent: view.recent.slice(0, 30).map((r) => ({
        date: r.date,
        who: r.player,
        what: labels[r.market] ?? r.market,
        prob: r.prob,
        result:
          r.scored == null
            ? r.touchdowns == null
              ? "pending"
              : "void"
            : r.scored
              ? "hit"
              : "miss",
      })),
      note: s.n === 0 ? note : null,
    };
  });

/** Bet names as the boards print them, keyed by the ledger's market codes. */
async function marketLabels(sport: string): Promise<Record<string, string>> {
  const { SIM_MARKET_LABELS } = await import("./sim-props-shared");
  const base: Record<string, string> = {
    anytime_td: "Anytime touchdown",
    tb2: "2+ total bases",
    ...SIM_MARKET_LABELS,
  };
  if (sport === "mlb") {
    const m = (await import("./mlb-props-model.json")).default as {
      markets: Record<string, { label: string }>;
    };
    for (const [k, v] of Object.entries(m.markets)) base[k] = v.label;
  }
  if (sport === "nfl") {
    const m = (await import("./nfl-props-model.json")).default as unknown as {
      markets: Record<string, { label: string }>;
    };
    for (const [k, v] of Object.entries(m.markets)) base[k] = v.label;
  }
  if (sport === "soccer") {
    const m = (await import("./soccer-props-model.json")).default as unknown as Record<
      string,
      { markets: Record<string, { label: string }> }
    >;
    for (const v of Object.values(m))
      for (const [k, x] of Object.entries(v.markets)) base[k] = x.label;
  }
  return base;
}
