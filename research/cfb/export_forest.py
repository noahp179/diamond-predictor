"""
Fit the shipped extra-trees model and refit everything that depends on it.

Changing the model is not a one-line swap. The board's tier thresholds, the
second-pick bar, the parlay evidence and the parlay's correlation correction
were all measured against the logistic's probability distribution. A forest's
distribution is different — differently shaped, differently spread — so every
one of those constants has to be re-measured or it is quoting the wrong model.

This script does all of it in one pass, from one fit, so nothing can drift:

  1. fit ExtraTrees(100, leaf 20) on 2021-24
  2. export it in a form TypeScript can evaluate, compactly
  3. refit the tier thresholds and measure their held-out hit rates
  4. refit the second-pick bar
  5. re-measure the parlay evidence per size
  6. re-measure the same-team / opposed correlation factors
  7. write a self-test so the TypeScript port can be checked against this fit

WHY THE FOREST NEEDS CALIBRATING AND THE LOGISTIC DID NOT
A forest predicts by averaging trees, and averaging compresses: the raw model's
probabilities top out at 0.69 where the logistic reaches 0.98. That makes it
badly under-confident exactly where the board spends its time — raw lead picks
state 48.3% and hit 58.1%, a gap of ten points, and a five-leg parlay built from
them states 9.9% when six of sixteen slips actually won.

Platt scaling fixes it, and it is the right tool rather than isotonic for two
reasons. It is strictly monotone, so the ranking — the entire reason for
switching models — is mathematically untouched. And it does not quantise:
CFB-BAKEOFF.md §6 records isotonic collapsing 21,486 distinct probabilities into
116, which would wreck both the ordering within a game and the parlay page that
multiplies twenty of them.

Calibrated, the forest beats the logistic on every metric at once: top-1 58.1%
against 56.3%, ECE 0.0096 against 0.0166, log loss 0.5069 against 0.5119.

SERIALISATION
Each tree becomes four flat arrays — feature, threshold, left, right — plus a
value per node, base64'd as typed arrays. Child indices are LOCAL to their
tree, so they fit in uint16 (trees run ~2,600 nodes, the limit is 65,535, and
the export asserts it). That is 13 bytes a node against roughly 60 for the
equivalent nested JSON: 100 trees comes to about 4.6MB rather than 15MB.
"""
import os, json, base64
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import features as F
import bakeoff_big as B
from bakeoff_big import ece

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "cfb-td-forest.json"))

N_TREES = 200
MIN_LEAF = 20
SEED = 0  # fixed before looking at any test result
# Fraction of the training seasons held back to fit the Platt calibration. The
# test seasons are never involved in it.
CALIB_HOLDBACK = 0.20


def b64(arr, dtype):
    return base64.b64encode(np.ascontiguousarray(arr, dtype=dtype).tobytes()).decode("ascii")


def export_trees(model):
    """Flat arrays per tree, child indices local to the tree."""
    feats, thresh, left, right, vals = [], [], [], [], []
    per_tree = []
    for est in model.estimators_:
        t = est.tree_
        n = t.node_count
        assert n < 65535, f"tree has {n} nodes, too many for uint16 child indices"
        # sklearn marks a leaf with children_left == -1; store the node's own
        # index there so the walker can detect a leaf without a sentinel branch.
        lc = t.children_left.astype(np.int64).copy()
        rc = t.children_right.astype(np.int64).copy()
        is_leaf = lc == -1
        lc[is_leaf] = 0
        rc[is_leaf] = 0
        fidx = t.feature.astype(np.int64).copy()
        fidx[is_leaf] = 0
        thr = t.threshold.astype(np.float64).copy()
        thr[is_leaf] = 0.0
        # P(scores) at each leaf; interior values are unused but kept aligned
        v = t.value[:, 0, :]
        p = v[:, 1] / np.clip(v.sum(axis=1), 1e-12, None)
        # a leaf is flagged by feature = 255
        fexp = fidx.astype(np.uint8)
        fexp[is_leaf] = 255
        feats.append(fexp)
        thresh.append(thr.astype(np.float32))
        left.append(lc.astype(np.uint16))
        right.append(rc.astype(np.uint16))
        vals.append(p.astype(np.float32))
        per_tree.append(int(n))
    return {
        "n_trees": len(per_tree),
        "node_counts": per_tree,
        "feature": b64(np.concatenate(feats), np.uint8),
        "threshold": b64(np.concatenate(thresh), np.float32),
        "left": b64(np.concatenate(left), np.uint16),
        "right": b64(np.concatenate(right), np.uint16),
        "value": b64(np.concatenate(vals), np.float32),
        "total_nodes": int(sum(per_tree)),
    }


def predict_reference(trees_blob, X):
    """Walk the exported arrays in numpy — the same algorithm the TypeScript
    will run. If this disagrees with sklearn, the export is wrong."""
    feat = np.frombuffer(base64.b64decode(trees_blob["feature"]), dtype=np.uint8)
    thr = np.frombuffer(base64.b64decode(trees_blob["threshold"]), dtype=np.float32)
    lc = np.frombuffer(base64.b64decode(trees_blob["left"]), dtype=np.uint16)
    rc = np.frombuffer(base64.b64decode(trees_blob["right"]), dtype=np.uint16)
    val = np.frombuffer(base64.b64decode(trees_blob["value"]), dtype=np.float32)
    counts = trees_blob["node_counts"]
    offs = np.concatenate([[0], np.cumsum(counts)])
    out = np.zeros(len(X))
    for ti, n in enumerate(counts):
        o = offs[ti]
        for i, x in enumerate(X):
            node = 0
            while feat[o + node] != 255:
                node = lc[o + node] if x[feat[o + node]] <= thr[o + node] else rc[o + node]
            out[i] += val[o + node]
    return out / len(counts)


def main():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    lg = json.load(open(os.path.join(HERE, "data", "league_rates.json")))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)

    sc = StandardScaler().fit(tr[F.FEATURES].values)
    Xtr, Xte = sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values

    # Platt parameters come from a fit that never saw the holdback slice, then
    # the shipped forest is refitted on all of the training seasons.
    cut = int(len(tr) * (1 - CALIB_HOLDBACK))
    pre = ExtraTreesClassifier(
        n_estimators=N_TREES, min_samples_leaf=MIN_LEAF, random_state=SEED, n_jobs=-1
    ).fit(Xtr[:cut], ytr[:cut])

    def logit(p):
        q = np.clip(p, 1e-6, 1 - 1e-6)
        return np.log(q / (1 - q))

    from sklearn.linear_model import LogisticRegression
    platt = LogisticRegression(max_iter=2000).fit(
        logit(pre.predict_proba(Xtr[cut:])[:, 1]).reshape(-1, 1), ytr[cut:]
    )
    PLATT_A, PLATT_B = float(platt.coef_[0][0]), float(platt.intercept_[0])

    model = ExtraTreesClassifier(
        n_estimators=N_TREES, min_samples_leaf=MIN_LEAF, random_state=SEED, n_jobs=-1
    ).fit(Xtr, ytr)

    def calibrate(p_raw):
        return 1.0 / (1.0 + np.exp(-(PLATT_A * logit(p_raw) + PLATT_B)))

    p_raw_te = model.predict_proba(Xte)[:, 1]
    p_te = calibrate(p_raw_te)
    print(f"platt: a={PLATT_A:.4f} b={PLATT_B:.4f}  "
          f"(raw max {p_raw_te.max():.3f} -> calibrated max {p_te.max():.3f})")

    gt = te[["game_id", "scored", "date", "team", "season"]].copy()

    def top1(p):
        d = gt.copy()
        d["s"] = p
        return np.array([int(g.loc[g.s.idxmax()].scored) for _, g in d.groupby("game_id")])

    t1 = top1(p_te)
    print("=== the shipped fit, held out on 2025-26 ===")
    print(f"  top-1 {t1.mean()*100:.2f}%   auc {roc_auc_score(yte,p_te):.4f}   "
          f"logloss {log_loss(yte,p_te):.4f}   brier {brier_score_loss(yte,p_te):.4f}   "
          f"ece {ece(yte,p_te):.4f}")

    # ---------------------------------------------------- 1-2 picks per game
    d = te.copy()
    d["p"] = p_te
    ranked = []
    for gid, g in d.groupby("game_id"):
        g = g.sort_values("p", ascending=False).reset_index(drop=True)
        for i in range(min(3, len(g))):
            ranked.append({"game_id": gid, "rank": i + 1, "p": g.loc[i, "p"],
                           "scored": int(g.loc[i, "scored"]), "season": g.loc[i, "season"],
                           "date": g.loc[i, "date"]})
    R = pd.DataFrame(ranked)

    print("\n=== refit: the second-pick bar ===")
    p2 = R[R["rank"] == 2]
    lead = R[R["rank"] == 1].scored.mean()
    print(f"  lead picks hit {lead*100:.1f}% — the bar a second pick has to approach")
    print(f"  {'threshold':>10} {'share of games':>15} {'pick-2 hit':>11}")
    curve = []
    for thr in [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55]:
        s = p2[p2.p >= thr]
        if len(s) < 40:
            continue
        curve.append({"thr": thr, "share": len(s) / len(p2), "hit": float(s.scored.mean())})
        print(f"  {thr:>10.2f} {len(s)/len(p2)*100:>14.0f}% {s.scored.mean()*100:>10.1f}%")

    # Unlike the logistic, the forest's pick-2 curve has no step in it — the hit
    # rate climbs smoothly from 44% to 51% as the bar rises, so there is no
    # breakpoint to find and the bar is an explicit trade-off rather than a
    # discovery. 0.45 is kept: it is where a second pick appears in about half
    # of games while still hitting roughly twice the 24% base rate, and keeping
    # the same number as the logistic means the board's behaviour changes for
    # one reason (the model) rather than two.
    second_min = 0.45
    at_bar = next(c for c in curve if abs(c["thr"] - second_min) < 1e-9)
    print(f"  -> second-pick bar {second_min:.2f}: pick-2 hits {at_bar['hit']*100:.1f}% "
          f"in {at_bar['share']*100:.0f}% of games (lead picks {lead*100:.1f}%)")
    print("     no step in the curve, so this is a trade-off, not a breakpoint")

    # ------------------------------------------------------------- 2. tiers
    print("\n=== refit: tiers ===")
    shown = R[(R["rank"] == 1) | ((R["rank"] == 2) & (R.p >= second_min))].copy()
    qs = shown.p.quantile([0.62, 0.30]).values  # top ~38% Strong, next ~32% Solid
    strong, solid = float(round(qs[0], 3)), float(round(qs[1], 3))
    tiers = []
    for label, lo, hi in (("Strong", strong, 1.01), ("Solid", solid, strong), ("Lean", 0.0, solid)):
        s = shown[(shown.p >= lo) & (shown.p < hi)]
        by = {str(y): float(s[s.season == y].scored.mean()) for y in B.TEST if (s.season == y).sum() >= 20}
        tiers.append({"label": label, "min": lo, "hit": float(s.scored.mean()),
                      "n": int(len(s)), "by_season": by})
        print(f"  {label:<7} p>={lo:.3f}: {s.scored.mean()*100:5.1f}% hit "
              f"(n={len(s)}, {len(s)/len(shown)*100:.0f}% of shown)  {by}")

    board = {
        "games": int(shown.game_id.nunique()),
        "picks": int(len(shown)),
        "picks_per_game": float(len(shown) / shown.game_id.nunique()),
        "pick_hit_rate": float(shown.scored.mean()),
        "lead_hit": float(R[R["rank"] == 1].scored.mean()),
        "second_hit": float(shown[shown["rank"] == 2].scored.mean()),
        "game_hit_rate": float(shown.groupby("game_id").scored.max().mean()),
    }
    print(f"\n  board: {board['picks_per_game']:.2f} picks/game, "
          f"{board['pick_hit_rate']*100:.1f}% of picks scored, "
          f"{board['game_hit_rate']*100:.1f}% of games hit")

    # --------------------------------------------- 3. parlay evidence + corr
    print("\n=== re-measure: parlay evidence (one leg per game) ===")
    games_per = te.groupby("date").game_id.nunique()
    parlay_ev = {}
    for size, floor in ((5, 0.55), (10, 0.45), (15, 0.45), (20, 0.45)):
        elig = set(games_per[games_per >= size].index)
        n = h = 0
        prod = 0.0
        for dt, slate in d.groupby("date"):
            if dt not in elig:
                continue
            best_leg = slate.loc[slate.groupby("game_id").p.idxmax()]
            best_leg = best_leg[best_leg.p >= floor].nlargest(size, "p")
            if len(best_leg) < size:
                continue
            n += 1
            h += int(best_leg.scored.sum() == size)
            prod += float(np.prod(best_leg.p.values))
        if n == 0:
            continue
        stated = prod / n
        parlay_ev[str(size)] = {"stated": stated, "oneIn": round(1 / stated) if stated else None,
                                "slips": n, "hits": h, "expected": stated * n}
        print(f"  {size:>2} legs: stated {stated*100:6.3f}% (1 in {round(1/stated):,})  "
              f"observed {h} of {n} (exp {stated*n:.2f})")

    print("\n=== re-measure: correlation factors ===")
    import itertools
    cand = d[d.p >= 0.40]
    buckets = {k: {"n": 0, "both": 0, "prod": 0.0} for k in ("same_team", "opposed", "diff")}
    for _, slate in cand.groupby("date"):
        s = slate.sort_values("p", ascending=False).drop_duplicates("player_id").head(40)
        for x, y in itertools.combinations(list(s.itertuples()), 2):
            k = "same_team" if x.team == y.team else "opposed" if x.game_id == y.game_id else "diff"
            buckets[k]["n"] += 1
            buckets[k]["both"] += int(x.scored) * int(y.scored)
            buckets[k]["prod"] += x.p * y.p
    ratios = {k: (v["both"] / v["n"]) / (v["prod"] / v["n"]) for k, v in buckets.items() if v["n"]}
    control = ratios["diff"]
    pair = {"sameTeam": round(ratios["same_team"] / control, 3),
            "opposed": round(ratios["opposed"] / control, 3)}
    for k in ("same_team", "opposed", "diff"):
        print(f"  {k:<10} {buckets[k]['n']:>7,} pairs  ratio {ratios[k]:.3f}  "
              f"vs control {ratios[k]/control:.3f}")
    print(f"  -> sameTeam {pair['sameTeam']}, opposed {pair['opposed']}")

    # ------------------------------------------------------------- 4. export
    blob = export_trees(model)
    sample = Xte[:5]
    ref = calibrate(predict_reference(blob, sample))
    sk = calibrate(model.predict_proba(sample)[:, 1])
    worst = float(np.abs(ref - sk).max())
    print(f"\n=== export ===")
    print(f"  {blob['n_trees']} trees, {blob['total_nodes']:,} nodes")
    print(f"  export-vs-sklearn worst disagreement on 5 rows: {worst:.2e}")
    assert worst < 1e-6, "the exported arrays do not reproduce sklearn"

    out = {
        "kind": "extratrees",
        "features": F.FEATURES,
        "mean": sc.mean_.tolist(),
        "std": sc.scale_.tolist(),
        "trees": blob,
        "platt_a": PLATT_A,
        "platt_b": PLATT_B,
        "importances": dict(zip(F.FEATURES, model.feature_importances_.round(5).tolist())),
        "constants": {"K_RUSH": F.K_RUSH, "K_REC": F.K_REC, "K_ANY": F.K_ANY,
                      "LG_RUSH": lg["LG_RUSH"], "LG_REC": lg["LG_REC"], "LG_ANY": lg["LG_ANY"],
                      "USAGE_WINDOW": F.USAGE_WINDOW,
                      "ELO_K": 40, "ELO_HFA": 55, "ELO_CARRY": 0.60},
        "second_pick_min": float(second_min),
        "tiers": [{"label": t["label"], "min": t["min"], "hit": t["hit"]} for t in tiers],
        "tier_detail": tiers,
        "board": board,
        "parlay_evidence": parlay_ev,
        "pair_factor": pair,
        "holdout": {"seasons": B.TEST, "top1": float(t1.mean()),
                    "auc": float(roc_auc_score(yte, p_te)),
                    "logloss": float(log_loss(yte, p_te)),
                    "ece": float(ece(yte, p_te)),
                    "pick_hit_rate": board["pick_hit_rate"],
                    "picks_per_game": board["picks_per_game"],
                    "game_hit_rate": board["game_hit_rate"]},
        "notes": (f"ExtraTreesClassifier({N_TREES} trees, min_samples_leaf={MIN_LEAF}, "
                  f"seed {SEED}) on standardized season-to-date features, then Platt-scaled: "
                  "P = sigmoid(a*logit(forest) + b). Chosen on held-out top-1 accuracy over 8 "
                  "seeds (CFB-BAKEOFF.md). The forest alone is under-confident because averaging "
                  "compresses; Platt is monotone so it fixes the probabilities without touching "
                  "the ranking. Every downstream constant here was re-measured against this fit."),
        "trained_seasons": B.TRAIN + B.TEST,
        "selftest": [{"x": Xte[i].tolist(), "p": float(sk[i])} for i in range(5)],
    }
    json.dump(out, open(OUT, "w"))
    mb = os.path.getsize(OUT) / 1024 / 1024
    print(f"  wrote {OUT} ({mb:.2f} MB)")
    json.dump({"top1": float(t1.mean()), "tiers": tiers, "board": board,
               "parlay": parlay_ev, "pair": pair, "second_min": second_min,
               "second_pick_curve": curve, "platt": {"a": PLATT_A, "b": PLATT_B},
               "lead_hit": float(R[R["rank"] == 1].scored.mean())},
              open(os.path.join(HERE, "forest_final.json"), "w"), indent=1)
    print("  wrote forest_final.json")


if __name__ == "__main__":
    main()
