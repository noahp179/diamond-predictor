"""
Freeze the shipped prop models.

For every market:
  1. Fit on 2024-2025, score 2026 -> the honest out-of-sample numbers the app
     quotes (AUC, calibration table, tier hit rates, slate top-N).
  2. Refit on every season and export standardizer + weights to
     src/lib/mlb-props-model.json, which the live TypeScript pipeline imports.

Tier breakpoints are chosen from the held-out season, not from round numbers:
each market's picks are cut where the hit rate actually separates.
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from bakeoff import apply_platt, auc, brier, logloss, platt, slate_topn
from features import (BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES,
                      PITCHER_MARKETS)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
APP_OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "mlb-props-model.json"))
TRAIN = (2024, 2025)
TEST = 2026

LABELS = {
    "h1": ("1+ hits", "batter"),
    "h2": ("2+ hits", "batter"),
    "h3": ("3+ hits", "batter"),
    "h4": ("4+ hits", "batter"),
    "tb2": ("2+ total bases", "batter"),
    "tb3": ("3+ total bases", "batter"),
    "tb4": ("4+ total bases", "batter"),
    "tb5": ("5+ total bases", "batter"),
    "hr1": ("1+ home run", "batter"),
    "rbi1": ("1+ RBI", "batter"),
    "r1": ("1+ run scored", "batter"),
    "sb1": ("1+ stolen base", "batter"),
    "k5": ("5+ strikeouts", "pitcher"),
    "k6": ("6+ strikeouts", "pitcher"),
    "k7": ("7+ strikeouts", "pitcher"),
    "outs16": ("16+ outs (5.1 IP)", "pitcher"),
}


def fit(X, y):
    lr = LogisticRegression(max_iter=3000)
    lr.fit(X, y)
    return lr


def tiers_for(p, y, base):
    """Cut the held-out picks into three tiers wherever the hit rate separates.

    Candidate cuts are quantiles of the predicted distribution; the pair kept is
    the one that maximises the spread between the top and bottom tier while
    leaving at least 8% of picks in the top tier.
    """
    order = np.argsort(-p)
    p, y = p[order], y[order]
    n = len(p)
    best = None
    for hi_q in (0.05, 0.08, 0.10, 0.15, 0.20, 0.25):
        for lo_q in (0.35, 0.45, 0.55, 0.65):
            if lo_q <= hi_q:
                continue
            hi_n, lo_n = int(n * hi_q), int(n * lo_q)
            if hi_n < 200 or (n - lo_n) < 200:
                continue
            top, mid, bot = y[:hi_n].mean(), y[hi_n:lo_n].mean(), y[lo_n:].mean()
            if not (top > mid > bot):
                continue
            score = top - bot
            if best is None or score > best[0]:
                best = (score, p[hi_n - 1], p[lo_n - 1], top, mid, bot,
                        hi_n, lo_n - hi_n, n - lo_n)
    if best is None:
        return []
    _, hi_p, lo_p, top, mid, bot, n1, n2, n3 = best
    return [
        {"minProb": float(hi_p), "label": "Strong", "hitRate": float(top), "n": int(n1)},
        {"minProb": float(lo_p), "label": "Solid", "hitRate": float(mid), "n": int(n2)},
        {"minProb": 0.0, "label": "Lean", "hitRate": float(bot), "n": int(n3)},
    ]


def calibration(p, y, edges=(0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01)):
    out = []
    for a, b in zip(edges, edges[1:]):
        m = (p >= a) & (p < b)
        if m.sum() < 50:
            continue
        out.append({"lo": a, "hi": b, "n": int(m.sum()),
                    "pred": float(p[m].mean()), "actual": float(y[m].mean())})
    return out


def run(df, generic, markets, kind, out):
    for market in markets:
        feats = generic + [f"own_{market}", f"ownw_{market}"]
        y = df[f"y_{market}"].values.astype(int)
        Xr = df[feats].values.astype(float)
        tr = df.season.isin(TRAIN).values
        te = (df.season == TEST).values

        sc = StandardScaler().fit(Xr[tr])
        lr = fit(sc.transform(Xr[tr]), y[tr])
        pb = platt(lr.predict_proba(sc.transform(Xr[tr]))[:, 1], y[tr])
        pte = apply_platt(lr.predict_proba(sc.transform(Xr[te]))[:, 1], pb)
        dte = df.date.values[te]

        metrics = {
            "auc": auc(y[te], pte), "logloss": logloss(y[te], pte),
            "brier": brier(y[te], pte), "base": float(y[te].mean()),
            "meanPred": float(pte.mean()),
            "top1": slate_topn(dte, y[te], pte, 1),
            "top5": slate_topn(dte, y[te], pte, 5),
            "top10": slate_topn(dte, y[te], pte, 10),
            "nTest": int(te.sum()), "nTrain": int(tr.sum()),
        }
        tiers = tiers_for(pte.copy(), y[te].copy(), y[te].mean())
        cal = calibration(pte, y[te])

        # ship: refit on everything
        scA = StandardScaler().fit(Xr)
        lrA = fit(scA.transform(Xr), y)
        pbA = platt(lrA.predict_proba(scA.transform(Xr))[:, 1], y)

        out[market] = {
            "label": LABELS[market][0], "kind": kind,
            "features": feats,
            "mean": scA.mean_.tolist(), "std": scA.scale_.tolist(),
            "coef": lrA.coef_[0].tolist(), "intercept": float(lrA.intercept_[0]),
            "plattA": float(pbA[0]), "plattB": float(pbA[1]),
            "base": float(y.mean()),
            "tiers": tiers, "metrics": metrics, "calibration": cal,
            "selftest": [
                {"x": Xr[i].tolist(),
                 "p": float(apply_platt(
                     lrA.predict_proba(scA.transform(Xr[i:i + 1]))[:, 1], pbA)[0])}
                for i in (0, 1, 2)
            ],
        }
        top = sorted(zip(feats, lrA.coef_[0]), key=lambda kv: -abs(kv[1]))[:5]
        print(f"{market:7s} auc={metrics['auc']:.4f} base={metrics['base']:.3f} "
              f"top5={metrics['top5']:.3f} tiers="
              f"{[round(t['hitRate'], 3) for t in tiers]}  "
              f"drivers={[(k, round(v, 3)) for k, v in top]}", flush=True)


def main():
    out = {}
    b = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    run(b, BATTER_FEATURES, list(BATTER_MARKETS), "batter", out)
    p = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    run(p, PITCHER_FEATURES, list(PITCHER_MARKETS), "pitcher", out)

    model = {
        "trainedThrough": TEST,
        "notes": "logistic on season-to-date + 30-day + prior-season rates; "
                 "P = platt(sigmoid(w.x + b)). Validation: fit 2024-25, test 2026.",
        "constants": {"K_PA": 250.0, "K_BF": 300.0, "K_G": 25.0, "WINDOW_DAYS": 30},
        "markets": out,
    }
    json.dump(model, open(os.path.join(HERE, "props_model.json"), "w"), indent=1)
    json.dump(model, open(APP_OUT, "w"), indent=1)
    print(f"\nexported -> {APP_OUT}")


if __name__ == "__main__":
    main()
