/**
 * cfb-td-forest.ts — the college touchdown model: a calibrated extra-trees
 * ensemble, evaluated here rather than in Python.
 *
 * WHY A FOREST AND NOT THE LOGISTIC IT REPLACED
 * ---------------------------------------------
 * CFB-BAKEOFF.md ran 24 algorithms on the held-out 2025-26 seasons and scored
 * them on the metric the board actually uses — of each game's candidates, is the
 * top-ranked one right. Extra trees was the only model whose edge survived a
 * bootstrap that resamples whole Saturdays rather than games: +1.9 points, 95%
 * interval [+0.5, +3.3], McNemar p = 0.042, and 10 of 10 seeds beat the
 * logistic. Held out it calls 58.1% of games against the logistic's 56.3%.
 *
 * WHY IT IS PLATT-SCALED
 * ----------------------
 * A forest predicts by averaging, and averaging compresses: the raw model's
 * probabilities topped out at 0.69 where the logistic reached 0.98. That made
 * it badly under-confident exactly where the board lives — raw lead picks
 * stated 48.3% and hit 58.1% — and a five-leg parlay built from them stated
 * 9.9% when six of sixteen slips had actually won.
 *
 * Platt scaling fixes it: P = sigmoid(a·logit(forest) + b). It is the right
 * tool rather than isotonic for two reasons. It is strictly monotone, so the
 * ranking — the entire reason for switching models — is untouched, and the
 * 58.1% is exactly the same before and after. And it does not quantise:
 * CFB-BAKEOFF.md §6 records isotonic collapsing 21,486 distinct probabilities
 * into 116, which would wreck both the order within a game and the parlay page
 * that multiplies twenty of them together.
 *
 * Calibrated, it beats the logistic on every measure at once: top-1 58.1% vs
 * 56.3%, calibration error 0.0096 vs 0.0166, log loss 0.5069 vs 0.5119.
 *
 * HOW IT IS STORED
 * ----------------
 * 200 trees, 530,890 nodes. As nested JSON objects that is upwards of 30MB; as
 * five base64 typed arrays it is 8.8MB, and the bundle sees five long string
 * literals rather than half a million objects. Child indices are LOCAL to each
 * tree, so they fit in uint16 — the largest tree here is 3,381 nodes against a
 * 65,535 ceiling, and the exporter asserts it.
 *
 * A leaf is marked by feature index 255, which is why the feature array is
 * uint8 and why there are only 16 features to index.
 */
import model from "./cfb-td-forest.json";

/** Decode base64 into a typed array, on a correctly aligned buffer.
 *
 *  `Buffer.from(...).buffer` is a view into a pooled allocation whose
 *  byteOffset is rarely a multiple of 4, and constructing a Float32Array over
 *  an unaligned offset throws. Copying into a fresh ArrayBuffer costs one pass
 *  at module load and removes the whole class of problem. */
function decode<T>(b64: string, Ctor: new (buf: ArrayBuffer) => T): T {
  const bin = Buffer.from(b64, "base64");
  const buf = new ArrayBuffer(bin.byteLength);
  new Uint8Array(buf).set(bin);
  return new Ctor(buf);
}

const T = model.trees;
const FEATURE = decode(T.feature, Uint8Array);
const THRESHOLD = decode(T.threshold, Float32Array);
const LEFT = decode(T.left, Uint16Array);
const RIGHT = decode(T.right, Uint16Array);
const VALUE = decode(T.value, Float32Array);

/** Where each tree's nodes start in the flat arrays. */
const OFFSET = (() => {
  const offs = new Int32Array(T.node_counts.length);
  let acc = 0;
  for (let i = 0; i < T.node_counts.length; i++) {
    offs[i] = acc;
    acc += T.node_counts[i];
  }
  if (acc !== T.total_nodes)
    throw new Error(`cfb-td-forest: node counts sum to ${acc}, expected ${T.total_nodes}`);
  return offs;
})();

const LEAF = 255;
const N_TREES = T.n_trees;

/** The feature order the arrays were built against. */
export const FOREST_FEATURES: string[] = model.features;
export const FOREST_CONSTANTS = model.constants;
export const FOREST_TIERS = model.tiers;
export const FOREST_SECOND_PICK_MIN = model.second_pick_min;
export const FOREST_PAIR_FACTOR = model.pair_factor;
export const FOREST_PARLAY_EVIDENCE = model.parlay_evidence;
export const FOREST_HOLDOUT = model.holdout;
export const FOREST_IMPORTANCES: Record<string, number> = model.importances;

/**
 * P(this player scores a rushing or receiving touchdown).
 *
 * `x` must be in FOREST_FEATURES order and on the RAW scale — standardization
 * happens here, against the same mean and standard deviation the trees were
 * split on.
 */
export function inferForest(x: number[]): number {
  let sum = 0;
  for (let t = 0; t < N_TREES; t++) {
    const base = OFFSET[t];
    let node = 0;
    // A tree is a few thousand nodes and perfectly balanced trees do not
    // happen, but depth is bounded by the node count, so this cannot spin.
    for (let guard = 0; guard < 4096; guard++) {
      const f = FEATURE[base + node];
      if (f === LEAF) break;
      const z = (x[f] - model.mean[f]) / model.std[f];
      node = z <= THRESHOLD[base + node] ? LEFT[base + node] : RIGHT[base + node];
    }
    sum += VALUE[base + node];
  }
  const raw = sum / N_TREES;
  // Platt. Clamped before the logit because a leaf can be a pure 0 or 1.
  const q = Math.min(1 - 1e-6, Math.max(1e-6, raw));
  const z = model.platt_a * Math.log(q / (1 - q)) + model.platt_b;
  return 1 / (1 + Math.exp(-z));
}

/** Replays the vectors frozen in the model file and checks this port agrees
 *  with the Python that fitted it. Called by scripts/test-cfb-forest.ts. */
export function forestSelfTest(): { ok: boolean; worst: number; n: number } {
  let worst = 0;
  for (const t of model.selftest) {
    // selftest vectors are stored standardized, so undo it to hit the same
    // entry point the board uses.
    const raw = t.x.map((z: number, i: number) => z * model.std[i] + model.mean[i]);
    worst = Math.max(worst, Math.abs(inferForest(raw) - t.p));
  }
  return { ok: worst < 1e-5, worst, n: model.selftest.length };
}

/** Fails loudly at import if the model file and the feature builder disagree. */
export function assertForestFeatures(order: string[]) {
  const a = FOREST_FEATURES.join(",");
  const b = order.join(",");
  if (a !== b) throw new Error(`cfb-td-forest feature drift:\n  model: ${a}\n  code:  ${b}`);
}
