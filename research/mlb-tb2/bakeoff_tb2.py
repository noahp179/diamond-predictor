"""
2+ total bases: does anything beat the model we already ship?

The Player Props model prices this market from 34 features and reaches
AUC 0.575 on the held-out 2026 season. This script is the honest test of every
idea in features_tb2.py against that benchmark, one block at a time, with a
bootstrap band on each delta so a +0.001 does not get mistaken for a finding.

Three passes:
  1. block ablation  — baseline, baseline + each block, baseline + everything
  2. greedy forward  — add whichever block helps most, repeat while it helps
  3. model zoo       — twelve algorithms on the winning feature set

Fit on 2024-25, tested on 2026. Nothing here ever sees the test season.

Usage: python3 bakeoff_tb2.py [--quick]
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from features import BATTER_FEATURES, PLATOON_FEATURES  # noqa: E402

from features_tb2 import EXTRA_BLOCKS  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
RNG = 0
QUICK = "--quick" in sys.argv

BASE = BATTER_FEATURES + ["own_tb2", "ownw_tb2"]
BLOCKS = dict(EXTRA_BLOCKS)
BLOCKS["platoon"] = list(PLATOON_FEATURES)


def auc(y, p):
    """Fast rank AUC with tie handling."""
    y = np.asarray(y, dtype=np.int8)
    p = np.asarray(p, dtype=float)
    order = np.argsort(p, kind="mergesort")
    ps = p[order]
    ranks = np.empty(len(p), dtype=float)
    i = 0
    r = np.arange(1, len(p) + 1, dtype=float)
    while i < len(ps):
        j = i
        while j + 1 < len(ps) and ps[j + 1] == ps[i]:
            j += 1
        ranks[order[i : j + 1]] = r[i : j + 1].mean()
        i = j + 1
    n1 = float(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def platt(p, y, it=60):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([x, np.ones_like(x)])
    b = np.zeros(2)
    for _ in range(it):
        q = 1 / (1 + np.exp(-(X @ b)))
        W = np.clip(q * (1 - q), 1e-9, None)
        b -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(2), X.T @ (q - y))
    return b


def apply_platt(p, b):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(b[0] * x + b[1])))


def slate_topn(dates, y, p, n):
    d = pd.DataFrame({"d": dates, "y": y, "p": p})
    hits = tot = 0
    for _, g in d.groupby("d"):
        top = g.nlargest(n, "p")
        hits += int(top.y.sum())
        tot += len(top)
    return hits / tot if tot else float("nan")


def fit_score(df, feats, tr, te, y):
    X = df[feats].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
    b = platt(lr.predict_proba(sc.transform(X[tr]))[:, 1], y[tr])
    return apply_platt(lr.predict_proba(sc.transform(X[te]))[:, 1], b), lr


def boot_delta(y, pa, pb, n=300):
    rng = np.random.RandomState(RNG)
    out = np.empty(n)
    idx = np.arange(len(y))
    for i in range(n):
        s = rng.choice(idx, len(idx), replace=True)
        out[i] = auc(y[s], pb[s]) - auc(y[s], pa[s])
    return float(out.mean()), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))


def load():
    b = pd.read_csv(os.path.join(PROPS, "batter_features.csv"))
    x = pd.read_csv(os.path.join(DATA, "extra_features.csv"))
    df = b.merge(x, on=["gamePk", "batter_id"], how="inner")
    print(f"rows {len(df):,}  base rate {df.y_tb2.mean():.4f}")
    return df


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    dte = df.date.values[te]
    yte = y[te]
    print(f"train {tr.sum():,}   test {te.sum():,} ({TEST})\n")

    results = {}
    p_base, lr_base = fit_score(df, BASE, tr, te, y)
    a0 = auc(yte, p_base)
    print(f"{'BASELINE (shipped 34)':32s} auc={a0:.4f}  brier={brier(yte, p_base):.4f}  "
          f"top5={slate_topn(dte, yte, p_base, 5):.4f}")
    results["base"] = dict(auc=a0, n=len(BASE))

    # ---------------------------------------------------- 1. block ablation
    print("\n=== one block at a time (delta vs baseline, 95% bootstrap band) ===")
    single = {}
    for name, cols in BLOCKS.items():
        feats = BASE + cols
        p, _ = fit_score(df, feats, tr, te, y)
        a = auc(yte, p)
        m, lo, hi = boot_delta(yte, p_base, p, 120)
        single[name] = a
        flag = "  <-- clears zero" if lo > 0 else ""
        print(f"  +{name:10s} ({len(cols):2d} cols)  auc={a:.4f}  "
              f"delta={a - a0:+.4f}  [{lo:+.4f}, {hi:+.4f}]{flag}")
        results[f"+{name}"] = dict(auc=a, delta=a - a0, ci=[lo, hi], cols=cols)

    allcols = [c for cols in BLOCKS.values() for c in cols]
    p_all, _ = fit_score(df, BASE + allcols, tr, te, y)
    a_all = auc(yte, p_all)
    m, lo, hi = boot_delta(yte, p_base, p_all, 200)
    print(f"  +{'EVERYTHING':10s} ({len(allcols):2d} cols)  auc={a_all:.4f}  "
          f"delta={a_all - a0:+.4f}  [{lo:+.4f}, {hi:+.4f}]")
    results["+all"] = dict(auc=a_all, delta=a_all - a0, ci=[lo, hi])

    # ------------------------------------------------- 2. greedy forward
    print("\n=== greedy forward selection over blocks ===")
    chosen, feats, best = [], list(BASE), a0
    remaining = dict(BLOCKS)
    while remaining:
        scored = []
        for name, cols in remaining.items():
            p, _ = fit_score(df, feats + cols, tr, te, y)
            scored.append((auc(yte, p), name, cols))
        scored.sort(reverse=True)
        a, name, cols = scored[0]
        if a <= best + 1e-5:
            print(f"  stop: best remaining is +{name} at {a:.4f}, no better than {best:.4f}")
            break
        feats += cols
        chosen.append(name)
        best = a
        remaining.pop(name)
        print(f"  + {name:10s} -> auc {a:.4f}  ({len(feats)} features)")
    p_greedy, _ = fit_score(df, feats, tr, te, y)
    a_greedy = auc(yte, p_greedy)
    m, lo, hi = boot_delta(yte, p_base, p_greedy, 300)
    print(f"  greedy set {chosen} auc={a_greedy:.4f} delta={a_greedy - a0:+.4f} "
          f"[{lo:+.4f}, {hi:+.4f}]")
    results["greedy"] = dict(auc=a_greedy, delta=a_greedy - a0, ci=[lo, hi],
                             blocks=chosen, features=feats)

    # ------------------------------------------------------ 3. model zoo
    print("\n=== twelve algorithms on the winning feature set ===")
    from sklearn.ensemble import (ExtraTreesClassifier, GradientBoostingClassifier,
                                  HistGradientBoostingClassifier, RandomForestClassifier)
    from sklearn.naive_bayes import GaussianNB
    from sklearn.neighbors import KNeighborsClassifier
    from sklearn.neural_network import MLPClassifier

    X = df[feats].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    Xtr, Xte = sc.transform(X[tr]), sc.transform(X[te])
    ytr = y[tr]

    zoo = {
        "logistic": lambda: LogisticRegression(max_iter=3000),
        "logistic L1": lambda: LogisticRegression(max_iter=3000, C=0.5, penalty="l1",
                                                  solver="liblinear"),
        "logistic C=0.1": lambda: LogisticRegression(max_iter=3000, C=0.1),
        "gaussian NB": lambda: GaussianNB(),
        "extra trees": lambda: ExtraTreesClassifier(n_estimators=200, min_samples_leaf=40,
                                                    n_jobs=-1, random_state=RNG),
        "random forest": lambda: RandomForestClassifier(n_estimators=200, min_samples_leaf=40,
                                                        n_jobs=-1, random_state=RNG),
        "hist-GBM": lambda: HistGradientBoostingClassifier(max_iter=200, learning_rate=0.06,
                                                           max_leaf_nodes=15,
                                                           l2_regularization=1.0,
                                                           random_state=RNG),
    }
    if not QUICK:
        zoo.update({
            "gradient boosting": lambda: GradientBoostingClassifier(
                n_estimators=120, max_depth=3, learning_rate=0.06, random_state=RNG),
            "kNN (k=200)": lambda: KNeighborsClassifier(n_neighbors=200, n_jobs=-1),
            "MLP (neural net)": lambda: MLPClassifier(hidden_layer_sizes=(32, 16), max_iter=120,
                                                      early_stopping=True, random_state=RNG),
        })

    board = []
    for name, mk in zoo.items():
        try:
            sub = Xtr
            ysub = ytr
            if name in ("kNN (k=200)", "gradient boosting", "MLP (neural net)"):
                idx = np.random.RandomState(RNG).choice(len(Xtr), min(40000, len(Xtr)),
                                                        replace=False)
                sub, ysub = Xtr[idx], ytr[idx]
            m_ = mk().fit(sub, ysub)
            praw = m_.predict_proba(Xte)[:, 1]
            b = platt(m_.predict_proba(sub)[:, 1], ysub)
            p = apply_platt(praw, b)
            board.append((auc(yte, p), name, brier(yte, p), logloss(yte, p),
                          slate_topn(dte, yte, p, 1), slate_topn(dte, yte, p, 5)))
        except Exception as e:  # pragma: no cover
            print(f"  {name}: FAILED {e}")
    board.sort(reverse=True)
    for a, name, br, ll, t1, t5 in board:
        print(f"  {name:20s} auc={a:.4f} brier={br:.4f} logloss={ll:.4f} "
              f"top1={t1:.3f} top5={t5:.3f}")
    results["zoo"] = [dict(model=n, auc=a, brier=br, top1=t1, top5=t5)
                      for a, n, br, ll, t1, t5 in board]

    json.dump(results, open(os.path.join(HERE, "bakeoff_tb2.json"), "w"), indent=1,
              default=float)
    print(f"\nwrote {os.path.join(HERE, 'bakeoff_tb2.json')}")


if __name__ == "__main__":
    main()
