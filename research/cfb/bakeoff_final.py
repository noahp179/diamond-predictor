"""
The candidate that could actually ship, tested properly.

bakeoff_splines.py found that a logistic regression on the 16 features PLUS
their 120 pairwise products gets +1.24 points of top-1 over the shipped model —
83% of what a 300-tree forest found — in 137 coefficients rather than 782,570
tree nodes, and with better calibration than either.

Two findings worth separating. Splines on individual features made things WORSE
(-0.71 at four knots, -1.68 at six), so the structure the forest was finding is
not curvature in any single feature. It is interaction: carries matter more when
the team is favoured, a receiver's touchdown rate matters more in a high-total
game. Those are products, not bends.

This runs the same tests the forest had to pass — paired bootstrap by slate,
McNemar, per-season — plus the two the forest failed: does it stay calibrated,
and can it be explained.
"""
import os, json
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import features as F
import bakeoff_big as B
from bakeoff_big import ece, parlay_rate

HERE = os.path.dirname(os.path.abspath(__file__))
BOOTSTRAPS = 4000
RNG = np.random.default_rng(11)


def main():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    Xtr, Xte = sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values

    poly = PolynomialFeatures(degree=2, interaction_only=True, include_bias=False).fit(Xtr)
    Ptr, Pte = poly.transform(Xtr), poly.transform(Xte)

    lr = LogisticRegression(max_iter=4000, C=1.0).fit(Xtr, ytr)
    ix = LogisticRegression(max_iter=4000, C=0.1).fit(Ptr, ytr)
    p_lr = lr.predict_proba(Xte)[:, 1]
    p_ix = ix.predict_proba(Pte)[:, 1]

    gt = te[["game_id", "scored", "date", "season"]].copy()

    def top1_vec(score):
        d = gt.copy()
        d["s"] = score
        rows = [(gid, int(g.loc[g.s.idxmax()].scored), g.date.iloc[0], g.season.iloc[0])
                for gid, g in d.groupby("game_id")]
        rows.sort()
        return (np.array([r[1] for r in rows]), np.array([r[2] for r in rows]),
                np.array([r[3] for r in rows]))

    a, slate_of, season_of = top1_vec(p_ix)
    b, _, _ = top1_vec(p_lr)
    slates = np.unique(slate_of)
    sidx = {s: np.flatnonzero(slate_of == s) for s in slates}

    print("=== metrics, held out on 2025-26 ===")
    print(f"{'':<26} {'top1':>7} {'auc':>8} {'logloss':>8} {'brier':>7} {'ece':>7}")
    for nm, p, v in (("logistic (shipped)", p_lr, b), ("+ interactions", p_ix, a)):
        print(f"{nm:<26} {v.mean()*100:>6.1f}% {roc_auc_score(yte,p):>8.4f} "
              f"{log_loss(yte,p):>8.4f} {brier_score_loss(yte,p):>7.4f} {ece(yte,p):>7.4f}")

    print("\n=== paired bootstrap by slate (top-1 difference) ===")
    diffs = np.empty(BOOTSTRAPS)
    for k in range(BOOTSTRAPS):
        pick = RNG.choice(slates, size=len(slates), replace=True)
        idx = np.concatenate([sidx[s] for s in pick])
        diffs[k] = a[idx].mean() - b[idx].mean()
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    print(f"  +{diffs.mean()*100:.2f} points  95% CI [{lo*100:+.2f}, {hi*100:+.2f}]  "
          f"P(better) {(diffs>0).mean():.3f}")
    verdict = "CLEAR OF ZERO" if lo > 0 else "includes zero"
    print(f"  -> {verdict}")

    print("\n=== McNemar ===")
    a_only = int(((a == 1) & (b == 0)).sum())
    b_only = int(((a == 0) & (b == 1)).sum())
    disc = a_only + b_only
    p = float(stats.binomtest(a_only, disc, 0.5).pvalue) if disc else 1.0
    print(f"  interactions only right: {a_only}   shipped only right: {b_only}")
    print(f"  both {int(((a==1)&(b==1)).sum())}, neither {int(((a==0)&(b==0)).sum())}")
    print(f"  two-sided p = {p:.4f}")

    print("\n=== per season ===")
    for s in B.TEST:
        m = season_of == s
        print(f"  {s}: interactions {a[m].mean()*100:.1f}%  shipped {b[m].mean()*100:.1f}%  "
              f"({(a[m].mean()-b[m].mean())*100:+.1f}, n={m.sum()})")

    print("\n=== calibration by band (interactions) ===")
    print(f"{'band':>12} {'n':>7} {'predicted':>10} {'actual':>8}")
    for loB, hiB in [(0, .2), (.2, .35), (.35, .5), (.5, .65), (.65, .8), (.8, 1.01)]:
        m = (p_ix >= loB) & (p_ix < hiB)
        if m.sum() < 50:
            continue
        print(f"{loB:>5.2f}-{hiB:<6.2f} {m.sum():>7,} {p_ix[m].mean()*100:>9.1f}% "
              f"{yte[m].mean()*100:>7.1f}%")

    print("\n=== 5-leg parlay ===")
    for nm, p_ in (("logistic (shipped)", p_lr), ("+ interactions", p_ix)):
        pv = parlay_rate(te, p_, probs=p_)
        print(f"  {nm:<22} {pv.mean()*100:>5.1f}% of {len(pv)} slips")

    print("\n=== the biggest interaction terms ===")
    names = poly.get_feature_names_out(F.FEATURES)
    coefs = ix.coef_[0]
    pairs = [(n, c) for n, c in zip(names, coefs) if " " in n]
    pairs.sort(key=lambda x: -abs(x[1]))
    for n, c in pairs[:10]:
        print(f"  {n:<44} {c:+.4f}")

    json.dump({
        "shipped": {"top1": float(b.mean()), "auc": float(roc_auc_score(yte, p_lr)),
                    "ece": float(ece(yte, p_lr)), "logloss": float(log_loss(yte, p_lr))},
        "interactions": {"top1": float(a.mean()), "auc": float(roc_auc_score(yte, p_ix)),
                         "ece": float(ece(yte, p_ix)), "logloss": float(log_loss(yte, p_ix)),
                         "params": int(len(coefs) + 1)},
        "bootstrap": {"mean": float(diffs.mean()), "lo": float(lo), "hi": float(hi),
                      "p_better": float((diffs > 0).mean())},
        "mcnemar": {"ix_only": a_only, "shipped_only": b_only, "p": p},
        "per_season": {str(s): {"ix": float(a[season_of == s].mean()),
                                "shipped": float(b[season_of == s].mean())} for s in B.TEST},
        "top_interactions": [{"term": n, "coef": float(c)} for n, c in pairs[:20]],
    }, open(os.path.join(HERE, "bakeoff_final.json"), "w"), indent=1)
    print("\nwrote bakeoff_final.json")


if __name__ == "__main__":
    main()
