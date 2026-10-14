/**
 * Score feature vectors with the SHIPPED TypeScript model code, so the Python
 * reimplementations in predict_cfb.py / predict_nfl.py can be checked against
 * the exact functions the site runs.
 *
 *   npx tsx research/football-td/ts_infer.ts <cfb|nfl> <in.json> <out.json>
 *
 * in.json  : number[][]  raw (unstandardised) feature vectors in the model's
 *            feature order
 * out.json : number[]    inferForest(x) (cfb) or inferRanker(x) (nfl, which
 *            uses the shipped DEPLOYMENT weights, not the held-out refit)
 *
 * Also prints the module's own self-test result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inferForest, forestSelfTest } from "../../src/lib/cfb-td-forest";
import { inferRanker, rankerSelfTest } from "../../src/lib/nfl-td-ranker";

const [kind, inPath, outPath] = process.argv.slice(2);
const rows: number[][] = JSON.parse(readFileSync(inPath, "utf8"));
const f = kind === "cfb" ? inferForest : inferRanker;
const out = rows.map((x) => f(x));
writeFileSync(outPath, JSON.stringify(out));
const st = kind === "cfb" ? forestSelfTest() : rankerSelfTest();
console.log(JSON.stringify({ kind, n: out.length, selftest: st }));
