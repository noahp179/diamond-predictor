"""
Can the forest's edge be had without losing what the logistic gives?

Extra trees wins top-1 by 1.8 points, on every one of ten seeds. Two things
stand in the way of simply shipping it:

  size         the full forest is 782,570 nodes, about 30MB of JSON. A small
               one (30 trees, depth 8) is 258KB and keeps roughly half the edge.
  explanation  a forest has no coefficients, and the per-leg reasoning on the
               parlay and TD boards is read straight out of them. Swapping the
               model out silently guts the feature.

A blend keeps both: the logistic's coefficients still explain the pick, and the
forest still sharpens the ranking. This measures whether it also keeps the
accuracy, across weights and seeds, on top-1 AND on calibration — because a
blend that ranks better while lying about probabilities is not an improvement.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss

import features as F
import bakeoff_big as B
from bakeoff_big import ece

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDS = range(5)
# 30 trees / leaf 20 / depth 8 — the smallest configuration that kept most of
# the edge in bakeoff_deploy.py, at 258KB rather than 30MB.
FOREST = dict(n_estimators=30, min_samples_leaf=20, max_depth=8)


def main():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    Xtr, Xte = sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values

    gt = te[["game_id", "scored"]].copy()

    def top1(score):
        d = gt.copy()
        d["s"] = score
        return np.array([int(g.loc[g.s.idxmax()].scored) for _, g in d.groupby("game_id")])

    lr = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, ytr)
    p_lr = lr.predict_proba(Xte)[:, 1]
    base = top1(p_lr).mean()

    print(f"logistic alone: top1 {base*100:.2f}%  auc {roc_auc_score(yte,p_lr):.4f}  "
          f"ece {ece(yte,p_lr):.4f}  ll {log_loss(yte,p_lr):.4f}\n")

    print(f"=== blends, averaged over {len(list(SEEDS))} forest seeds "
          f"(forest: {FOREST['n_estimators']} trees, depth {FOREST['max_depth']}) ===")
    print(f"{'weight on forest':>17} {'top1':>7} {'vs lr':>7} {'auc':>8} {'ece':>7} {'logloss':>8}")
    rows = []
    forests = []
    for s in SEEDS:
        forests.append(
            ExtraTreesClassifier(**FOREST, random_state=s, n_jobs=-1).fit(Xtr, ytr)
        )
    p_ets = [m.predict_proba(Xte)[:, 1] for m in forests]

    for w in [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]:
        t, a, e, l = [], [], [], []
        for pf in p_ets:
            p = (1 - w) * p_lr + w * pf
            t.append(top1(p).mean())
            a.append(roc_auc_score(yte, p))
            e.append(ece(yte, p))
            l.append(log_loss(yte, p))
        row = {"weight": w, "top1": float(np.mean(t)), "top1_sd": float(np.std(t)),
               "auc": float(np.mean(a)), "ece": float(np.mean(e)),
               "logloss": float(np.mean(l)), "vs_lr": float(np.mean(t) - base)}
        rows.append(row)
        print(f"{w:>17.1f} {row['top1']*100:>6.2f}% {row['vs_lr']*100:>+6.2f} "
              f"{row['auc']:>8.4f} {row['ece']:>7.4f} {row['logloss']:>8.4f}")

    best = max(rows, key=lambda r: r["top1"])
    print(f"\nbest top-1 at weight {best['weight']:.1f}: {best['top1']*100:.2f}% "
          f"({best['vs_lr']*100:+.2f} vs logistic alone, sd {best['top1_sd']*100:.2f})")
    print("\nfor comparison, the full 300-tree forest was +1.77 at 30MB and no coefficients.")
    json.dump({"logistic": {"top1": float(base)}, "forest_config": FOREST,
               "blends": rows, "best": best},
              open(os.path.join(HERE, "bakeoff_blend.json"), "w"), indent=1)
    print("wrote bakeoff_blend.json")


if __name__ == "__main__":
    main()
