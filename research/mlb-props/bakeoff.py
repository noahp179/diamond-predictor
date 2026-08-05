"""
The MLB player-prop bake-off: every market, every algorithm, one honest
out-of-sample test.

Train on 2024-2025, test on 2026 season-to-date. Nothing in a test row's
features comes from a game that had not already finished (see features.py), and
no 2026 outcome is ever used for fitting.

Reported per (market, model):
  AUC        - ranking quality (can we tell who is likelier than whom?)
  LogLoss    - probability quality
  Brier      - squared error of the probability
  Cal        - mean predicted probability vs actual base rate (calibration)
  Top-5/10   - hit rate of the day's 5 / 10 highest-rated picks, the way you
               would actually bet a slate
  P>=.6/.7   - hit rate of every pick the model prices above that threshold

Usage: python3 bakeoff.py [--quick]
"""

import json
import os
import sys
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesClassifier, GradientBoostingClassifier,
                              HistGradientBoostingClassifier,
                              RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

from features import (BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES,
                      PITCHER_MARKETS)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
QUICK = "--quick" in sys.argv
TRAIN_SEASONS = (2024, 2025)
TEST_SEASON = 2026
RNG = 0


# ------------------------------------------------------------------ metrics
def auc(y, p):
    y = np.asarray(y)
    p = np.asarray(p)
    o = p.argsort()
    r = np.empty(len(p))
    r[o] = np.arange(1, len(p) + 1)
    # average ranks for ties
    df = pd.DataFrame({"p": p, "r": r})
    r = df.groupby("p").r.transform("mean").values
    n1 = y.sum()
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def slate_topn(dates, y, p, n):
    """Hit rate of the n highest-rated picks on each date."""
    df = pd.DataFrame({"d": dates, "y": y, "p": p})
    hits = tot = 0
    for _, g in df.groupby("d"):
        top = g.nlargest(n, "p")
        hits += int(top.y.sum())
        tot += len(top)
    return hits / tot if tot else float("nan")


def thresh_rate(y, p, t):
    m = np.asarray(p) >= t
    return (float(np.asarray(y)[m].mean()), int(m.sum())) if m.sum() >= 30 else (float("nan"), int(m.sum()))


def evaluate(dates, y, p):
    r60, n60 = thresh_rate(y, p, 0.60)
    r70, n70 = thresh_rate(y, p, 0.70)
    return dict(
        auc=auc(y, p), logloss=logloss(y, p), brier=brier(y, p),
        cal=float(np.mean(p)), base=float(np.mean(y)),
        top5=slate_topn(dates, y, p, 5), top10=slate_topn(dates, y, p, 10),
        p60=r60, n60=n60, p70=r70, n70=n70,
    )


# ------------------------------------------------------------------- models
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


def model_zoo():
    """name -> (fit_predict(Xtr, ytr, Xte) -> p_te). Scaled inputs throughout."""
    def sk(make, sub=None, cal=False):
        def run(Xtr, ytr, Xte):
            if sub and len(Xtr) > sub:
                idx = np.random.RandomState(RNG).choice(len(Xtr), sub, replace=False)
                Xf, yf = Xtr[idx], ytr[idx]
            else:
                Xf, yf = Xtr, ytr
            m = make()
            m.fit(Xf, yf)
            p = m.predict_proba(Xte)[:, 1]
            if cal:
                b = platt(m.predict_proba(Xf)[:, 1], yf)
                p = apply_platt(p, b)
            return p
        return run

    zoo = {
        "logistic": sk(lambda: LogisticRegression(max_iter=3000, C=1.0)),
        "logistic L1": sk(lambda: LogisticRegression(max_iter=3000, C=0.5, penalty="l1", solver="liblinear")),
        "logistic + platt": sk(lambda: LogisticRegression(max_iter=3000), cal=True),
        "gaussian NB": sk(lambda: GaussianNB(), cal=True),
        "random forest": sk(lambda: RandomForestClassifier(
            n_estimators=200, min_samples_leaf=40, n_jobs=-1, random_state=RNG)),
        "extra trees": sk(lambda: ExtraTreesClassifier(
            n_estimators=200, min_samples_leaf=40, n_jobs=-1, random_state=RNG)),
        "hist-GBM": sk(lambda: HistGradientBoostingClassifier(
            max_iter=200, learning_rate=0.06, max_leaf_nodes=15,
            l2_regularization=1.0, random_state=RNG)),
        "gradient boosting": sk(lambda: GradientBoostingClassifier(
            n_estimators=120, max_depth=3, learning_rate=0.06, random_state=RNG), sub=40000),
        "kNN (k=200)": sk(lambda: KNeighborsClassifier(n_neighbors=200, n_jobs=-1), sub=20000),
        "MLP (neural net)": sk(lambda: MLPClassifier(
            hidden_layer_sizes=(32, 16), max_iter=120, early_stopping=True,
            random_state=RNG), sub=60000),
    }
    if QUICK:
        for k in ["gradient boosting", "kNN (k=200)", "MLP (neural net)", "random forest"]:
            zoo.pop(k, None)
    return zoo


def stack(Xtr, ytr, Xte):
    """Out-of-fold stack of logistic + hist-GBM + extra trees."""
    bases = [
        LogisticRegression(max_iter=3000),
        HistGradientBoostingClassifier(max_iter=200, learning_rate=0.06,
                                       max_leaf_nodes=15, l2_regularization=1.0,
                                       random_state=RNG),
        ExtraTreesClassifier(n_estimators=200, min_samples_leaf=40, n_jobs=-1,
                             random_state=RNG),
    ]
    oof = np.zeros((len(Xtr), len(bases)))
    te = np.zeros((len(Xte), len(bases)))
    skf = StratifiedKFold(n_splits=3, shuffle=True, random_state=RNG)
    for j, b in enumerate(bases):
        for tr, va in skf.split(Xtr, ytr):
            from sklearn.base import clone
            m = clone(b).fit(Xtr[tr], ytr[tr])
            oof[va, j] = m.predict_proba(Xtr[va])[:, 1]
        m = b.fit(Xtr, ytr)
        te[:, j] = m.predict_proba(Xte)[:, 1]
    meta = LogisticRegression(max_iter=1000).fit(oof, ytr)
    return meta.predict_proba(te)[:, 1]


# --------------------------------------------------------------------- main
def run_group(df, generic, markets, kind):
    out = []
    for market in markets:
        feats = generic + [f"own_{market}", f"ownw_{market}"]
        y = df[f"y_{market}"].values
        tr = df.season.isin(TRAIN_SEASONS).values
        te = (df.season == TEST_SEASON).values
        Xraw = df[feats].values.astype(float)
        sc = StandardScaler().fit(Xraw[tr])
        X = sc.transform(Xraw)
        Xtr, ytr, Xte, yte = X[tr], y[tr], X[te], y[te]
        dte = df.date.values[te]

        print(f"\n=== {kind} · {market}  (train {tr.sum():,} / test {te.sum():,}, "
              f"base {yte.mean():.3f}) ===", flush=True)

        # naive baseline: the player's own shrunk per-game rate, no learning
        naive = df[f"own_{market}"].values[te]
        res = {"market": market, "kind": kind, "model": "own-rate baseline",
               "n_train": int(tr.sum()), "n_test": int(te.sum())}
        res.update(evaluate(dte, yte, naive))
        out.append(res)
        print(f"  {'own-rate baseline':20s} auc={res['auc']:.4f} ll={res['logloss']:.4f} "
              f"top5={res['top5']:.3f}", flush=True)

        zoo = model_zoo()
        if not QUICK:
            zoo["STACK (LR+HGB+ET)"] = stack
        for name, fn in zoo.items():
            t0 = time.time()
            try:
                p = fn(Xtr, ytr, Xte)
            except Exception as e:  # keep the board going if one learner blows up
                print(f"  {name:20s} FAILED: {e}", flush=True)
                continue
            r = {"market": market, "kind": kind, "model": name,
                 "n_train": int(tr.sum()), "n_test": int(te.sum())}
            r.update(evaluate(dte, yte, p))
            r["secs"] = round(time.time() - t0, 1)
            out.append(r)
            print(f"  {name:20s} auc={r['auc']:.4f} ll={r['logloss']:.4f} "
                  f"brier={r['brier']:.4f} cal={r['cal']:.3f} top5={r['top5']:.3f} "
                  f"({r['secs']}s)", flush=True)
    return out


def main():
    rows = []
    b = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    rows += run_group(b, BATTER_FEATURES, list(BATTER_MARKETS), "batter")
    p = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    rows += run_group(p, PITCHER_FEATURES, list(PITCHER_MARKETS), "pitcher")

    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(HERE, "bakeoff_results.csv"), index=False)
    json.dump(rows, open(os.path.join(HERE, "bakeoff_results.json"), "w"), indent=1)
    print("\n===== best model per market (by AUC) =====")
    for m, g in res.groupby("market"):
        best = g.loc[g.auc.idxmax()]
        print(f"{m:8s} {best.model:20s} auc={best.auc:.4f} top5={best.top5:.3f} "
              f"base={best.base:.3f}")


if __name__ == "__main__":
    main()
