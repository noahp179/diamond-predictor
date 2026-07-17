#!/usr/bin/env -S npx tsx
/** Cache per-game Poisson (Dixon-Coles NB) home-win probs for every date in
 * records-v5, using the production module (walk-forward, point-in-time). */
import { readFileSync, writeFileSync } from "node:fs";
import { buildDixonColesPredictionsForDate } from "../src/lib/mlb-dixon-coles";

async function main() {
  const recs = readFileSync(".backtest-cache/records-v5.jsonl", "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const dates = Array.from(new Set(recs.map((r: any) => r.date))).sort() as string[];
  const out: Record<number, number> = {};
  let done = 0;
  for (const d of dates) {
    try {
      const preds = await buildDixonColesPredictionsForDate(d);
      for (const p of preds) out[p.gameId] = Number(p.homeWinProb.toFixed(4));
    } catch (e) {
      console.error("fail", d, (e as Error).message);
    }
    done++;
    if (done % 10 === 0) console.error(`  ${done}/${dates.length} dates, ${Object.keys(out).length} games`);
  }
  writeFileSync(".backtest-cache/dcnb.json", JSON.stringify(out));
  console.error(`saved dcnb.json — ${Object.keys(out).length} games`);
}
main().catch((e) => { console.error("💥", e); process.exit(1); });
