/**
 * Parity and sanity check for the NFL prop board.
 *
 * Two things can silently break this model, and neither shows up as an error:
 *
 *   1. The arithmetic in nfl-props.server.ts drifting from the arithmetic in
 *      research/nfl-props/features.py. The model file ships the exact feature
 *      vectors the trainer scored and the probabilities it got, so replaying
 *      them here proves the inference half is identical.
 *   2. The FEATURES being built differently even though inference matches —
 *      a team total summed over the wrong window, say. That one only shows up
 *      end to end, so the second half of this script rebuilds a real past slate
 *      from live ESPN and compares the probabilities against the ones Python
 *      computed from its own CSVs (research/nfl-props/dump_expected.py).
 *
 *   npx tsx scripts/test-nfl-props.ts             # selftest + today's board
 *   npx tsx scripts/test-nfl-props.ts 2025-11-16  # + parity against Python
 */
import { readFileSync, existsSync } from "node:fs";

import { propsSlate, selfTest } from "../src/lib/nfl-props.server";
import { todayET } from "../src/lib/date";

const EXPECTED = "research/nfl-props/expected.json";

async function main() {
  const date = process.argv[2] ?? todayET();

  console.log("— inference selftest —");
  const st = selfTest();
  const bad = st.filter((r) => !r.ok);
  console.log(`  ${st.length} vectors, ${bad.length} mismatched`);
  for (const b of bad.slice(0, 5)) {
    console.log(`  ${b.market}: expected ${b.expected}, got ${b.got}`);
  }
  if (bad.length) process.exitCode = 1;

  console.log(`\n— board for ${date} —`);
  const t0 = Date.now();
  const slate = await propsSlate(date, { keepPerGame: 5000, includeVectors: true });
  console.log(`  ${slate.games.length} games, ${Date.now() - t0}ms, season ${slate.season}`);
  for (const g of slate.games) {
    const lead = g.picks.slice(0, 4);
    console.log(
      `  ${g.matchup}  O/U ${g.total ?? "—"}${g.carryover ? "  [window reaches last season]" : ""}` +
        (g.ruledOut.length ? `  [out: ${g.ruledOut.map((r) => r.name).join(", ")}]` : ""),
    );
    for (const p of lead) {
      console.log(
        `      ${p.player.padEnd(22)} ${p.team}  ${p.label.padEnd(20)} ` +
          `${(p.prob * 100).toFixed(1)}%  edge ${p.edge * 100 >= 0 ? "+" : ""}` +
          `${(p.edge * 100).toFixed(1)}  ${p.tier ?? "—"}${p.questionable ? "  (questionable)" : ""}`,
      );
    }
  }

  if (!existsSync(EXPECTED)) {
    console.log(
      `\n(no ${EXPECTED} — run research/nfl-props/dump_expected.py for the parity check)`,
    );
    return;
  }
  const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as {
    date: string;
    features: Record<string, string[]>;
    rows: {
      gameId: number;
      playerId: string;
      player: string;
      market: string;
      prob: number;
      x: number[];
    }[];
  };
  if (expected.date !== date) {
    console.log(`\n(expected.json is for ${expected.date}, not ${date} — skipping parity)`);
    return;
  }

  console.log(`\n— feature parity against Python for ${date} —`);
  const got = new Map<string, { prob: number; x?: number[]; player: string }>();
  for (const g of slate.games) {
    for (const p of g.picks) {
      got.set(`${g.gameId}:${p.playerId}:${p.market}`, { prob: p.prob, x: p.x, player: p.player });
    }
  }
  // Which feature disagrees, and how often. A single mismatched column is the
  // usual cause and is invisible in the probability alone.
  const offenders = new Map<string, { n: number; worst: number; sample: string }>();
  const worstRows: { who: string; d: number; diffs: string[] }[] = [];
  let checked = 0;
  let worst = 0;
  let worstKey = "";
  const missing: string[] = [];
  for (const r of expected.rows) {
    const key = `${r.gameId}:${r.playerId}:${r.market}`;
    const mine = got.get(key);
    if (mine === undefined) {
      missing.push(key);
      continue;
    }
    checked++;
    const d = Math.abs(mine.prob - r.prob);
    if (d > worst) {
      worst = d;
      worstKey = key;
    }
    if (d > 1e-9 && mine.x) {
      const names = expected.features[r.market] ?? [];
      const rowDiffs: string[] = [];
      for (let i = 0; i < r.x.length; i++) {
        const diff = Math.abs((mine.x[i] ?? 0) - r.x[i]);
        if (diff <= 1e-9) continue;
        const name = names[i] ?? `#${i}`;
        const cur = offenders.get(name) ?? { n: 0, worst: 0, sample: "" };
        cur.n++;
        if (diff > cur.worst) {
          cur.worst = diff;
          cur.sample = `${r.player} ${r.market}: live ${mine.x[i]} vs trained ${r.x[i]}`;
        }
        offenders.set(name, cur);
        rowDiffs.push(`${name}: live ${mine.x[i]} vs trained ${r.x[i]}`);
      }
      if (rowDiffs.length) {
        worstRows.push({ who: `${r.player} (${r.market}) game ${r.gameId}`, d, diffs: rowDiffs });
      }
    }
  }
  if (worstRows.length) {
    console.log("  worst rows in full:");
    for (const r of worstRows.sort((a, b) => b.d - a.d).slice(0, 3)) {
      console.log(`    ${r.who}  Δp=${r.d.toFixed(4)}`);
      for (const line of r.diffs) console.log(`      ${line}`);
    }
  }
  if (offenders.size) {
    console.log("  features that disagree:");
    for (const [name, o] of [...offenders].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
      console.log(
        `    ${name.padEnd(18)} ${o.n} rows, worst ${o.worst.toExponential(2)}  — ${o.sample}`,
      );
    }
  }
  console.log(`  compared ${checked} probabilities, ${missing.length} not on the live board`);
  console.log(`  largest difference ${worst.toExponential(2)} (${worstKey})`);
  if (checked === 0) {
    console.log("  PARITY INCONCLUSIVE — nothing lined up");
    process.exitCode = 1;
  } else if (worst > 1e-6) {
    console.log("  PARITY FAILED — the live features differ from the trained ones");
    process.exitCode = 1;
  } else {
    console.log("  PARITY OK");
  }
}

/**
 * Every pick the board renders must carry a reason, and a reason must belong to
 * the channel the market is about.
 *
 * Both failures are silent: a pick with no reason renders as a bare percentage,
 * and a rushing prop faulted for the player's target share reads as if the
 * model is confused. Neither throws, and neither shows up in a parity check —
 * the probability is perfectly correct in both cases.
 */
async function checkReasons(date: string) {
  const { propsSlate } = await import("../src/lib/nfl-props.server");
  const { boardPicks } = await import("../src/lib/props-board");
  const { games } = await propsSlate(date);
  let shown = 0;
  let noReason = 0;
  const misplaced: string[] = [];
  for (const g of games) {
    for (const p of boardPicks(g.picks, "all", false)) {
      shown++;
      if (p.reasons.length === 0) noReason++;
      const a = p.against ?? "";
      const rushMarket = p.market.startsWith("rushy");
      const recvMarket = p.market.startsWith("rec");
      if (rushMarket && (a.includes("targets") || a.includes("catches")))
        misplaced.push(`${p.player} ${p.market}: "${a}"`);
      if (recvMarket && (a.includes("carries") || a.includes("yards a carry")))
        misplaced.push(`${p.player} ${p.market}: "${a}"`);
    }
  }
  console.log(`\n— reasons on ${date} —`);
  console.log(`  ${shown} board picks, ${noReason} without a reason`);
  console.log(`  ${misplaced.length} negatives from the wrong channel`);
  for (const m of misplaced.slice(0, 5)) console.log(`    ${m}`);
  if (shown > 0 && (noReason > 0 || misplaced.length > 0)) process.exitCode = 1;
  else if (shown > 0) console.log("  REASONS OK");
}

main()
  .then(() => checkReasons(process.argv[2] ?? todayET()))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
