"""
Getting the forest's edge into something that can ship.

The forest wins by finding curvature the logistic cannot see: a straight line in
carries-per-game cannot know that the eighth carry matters more than the
twentieth. But "nonlinear" and "a forest" are not the same thing. A logistic
regression on SPLINE-EXPANDED features is still a linear model — it has
coefficients, it serialises to a few kilobytes, and the per-leg reasoning can
map every spline term back to the feature it came from.

So: does a spline logistic capture what the forest found?

Four candidates, all still linear in their own basis:
  plain          the shipped model, 16 coefficients
  splines        each feature expanded into a cubic B-spline basis
  interactions   every pairwise product of the 16 features
  both           splines plus the interactions that survive L1

Judged on top-1 (the product's metric), calibration, and size — the same three
constraints that ruled the forest out.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler, SplineTransformer, PolynomialFeatures
from sklearn.pipeline import make_pipeline
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.metrics import roc_auc_score, log_loss

import features as F
import bakeoff_big as B
from bakeoff_big import ece

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    Xtr, Xte = sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values
    gt = te[["game_id", "scored"]].copy()
    seasons = te.season.values

    def top1(score, mask=None):
        d = gt.copy()
        d["s"] = score
        if mask is not None:
            d = d[mask]
        return np.array([int(g.loc[g.s.idxmax()].scored) for _, g in d.groupby("game_id")])

    cands = []

    lr = LogisticRegression(max_iter=4000, C=1.0).fit(Xtr, ytr)
    cands.append(("plain logistic (shipped)", lr.predict_proba(Xte)[:, 1], len(lr.coef_[0]) + 1))

    for knots in (4, 6):
        pipe = make_pipeline(
            SplineTransformer(n_knots=knots, degree=3, include_bias=False),
            LogisticRegression(max_iter=4000, C=1.0),
        ).fit(Xtr, ytr)
        n = pipe[-1].coef_.shape[1] + 1
        cands.append((f"spline logistic ({knots} knots)", pipe.predict_proba(Xte)[:, 1], n))

    for C in (0.1, 1.0):
        pipe = make_pipeline(
            PolynomialFeatures(degree=2, interaction_only=True, include_bias=False),
            LogisticRegression(max_iter=4000, C=C),
        ).fit(Xtr, ytr)
        n = pipe[-1].coef_.shape[1] + 1
        cands.append((f"interactions (C={C})", pipe.predict_proba(Xte)[:, 1], n))

    # splines + interactions, with L1 to keep only the terms that earn a slot
    pipe = make_pipeline(
        SplineTransformer(n_knots=4, degree=3, include_bias=False),
        LogisticRegression(max_iter=4000, C=0.3, penalty="l1", solver="saga"),
    ).fit(Xtr, ytr)
    nz = int((pipe[-1].coef_[0] != 0).sum())
    cands.append((f"spline + L1 (kept {nz})", pipe.predict_proba(Xte)[:, 1], nz + 1))

    # the reference the others are chasing
    ets = [
        ExtraTreesClassifier(n_estimators=300, min_samples_leaf=20, random_state=s, n_jobs=-1)
        .fit(Xtr, ytr)
        for s in range(3)
    ]
    p_ets = np.mean([m.predict_proba(Xte)[:, 1] for m in ets], axis=0)
    nodes = int(np.mean([sum(t.tree_.node_count for t in m.estimators_) for m in ets]))
    cands.append(("extra trees (300, reference)", p_ets, nodes))

    base = top1(cands[0][1]).mean()
    print(f"{'model':<30} {'params':>10} {'~size':>8} {'top1':>7} {'vs lr':>7} "
          f"{'auc':>8} {'ece':>7} {'2025':>7} {'2026':>7}")
    rows = []
    for name, p, n in cands:
        t = top1(p).mean()
        t25 = top1(p, seasons == 2025).mean()
        t26 = top1(p, seasons == 2026).mean()
        # coefficients serialise at ~20 bytes; tree nodes at ~40
        kb = n * (40 if "extra trees" in name else 20) / 1024
        rows.append({"model": name, "params": n, "kb": round(kb, 1), "top1": float(t),
                     "vs_lr": float(t - base), "auc": float(roc_auc_score(yte, p)),
                     "ece": float(ece(yte, p)), "logloss": float(log_loss(yte, p)),
                     "top1_2025": float(t25), "top1_2026": float(t26)})
        size = f"{kb:.0f}K" if kb < 1024 else f"{kb/1024:.1f}M"
        print(f"{name:<30} {n:>10,} {size:>8} {t*100:>6.1f}% {(t-base)*100:>+6.2f} "
              f"{roc_auc_score(yte,p):>8.4f} {ece(yte,p):>7.4f} {t25*100:>6.1f}% {t26*100:>6.1f}%")

    json.dump(rows, open(os.path.join(HERE, "bakeoff_splines.json"), "w"), indent=1)
    print("\nwrote bakeoff_splines.json")


if __name__ == "__main__":
    main()
