"""
Team run-scoring bake-off: which model best picks the night's biggest offences?

Three binary markets (the over on a 3.5 / 4.5 / 5.5 team total) plus a runs
regression used purely for ranking. Fit on 2024-2025, tested on 2026 — a season
none of these models has seen.

Two benchmarks worth beating sit alongside the machine-learning zoo:

  base_r_pg   the team's season-to-date runs per game, and nothing else. If a
              model cannot beat "who has been scoring", it is not adding value.
  poisson     the textbook run-environment estimate — team R/G x opponent RA/G
              / league R/G, adjusted for park, evaluated as a Poisson tail.
              This is what a sharp bettor does on a napkin.

Usage: python3 bakeoff_team.py [--quick]
"""

import os
import sys

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.linear_model import LinearRegression, LogisticRegression, PoissonRegressor
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from bakeoff import (apply_platt, auc, brier, evaluate, logloss, model_zoo,  # noqa: E402
                     platt, slate_topn, stack)

from features_team import TEAM_FEATURES, TEAM_MARKETS  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
LG_R = 4.42


def poisson_lambda(df):
    """Napkin run estimate: team R/G x opp RA/G / league R/G, park-adjusted."""
    return (df.r_pg.values * df.opp_ra_pg.values / LG_R) * df.park.values


def main():
    df = pd.read_csv(os.path.join(DATA, "team_features.csv"))
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    X = df[TEAM_FEATURES].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    Xtr, Xte = sc.transform(X[tr]), sc.transform(X[te])
    dte = df.date.values[te]
    lam = poisson_lambda(df)

    print(f"train {tr.sum():,} team-games   test {te.sum():,} ({TEST})\n")

    rows = []
    for market, (fn, _) in TEAM_MARKETS.items():
        y = df[f"y_{market}"].values.astype(int)
        line = int(market[1:])
        print(f"=== {market}: team scores {line}+ runs   "
              f"(base {y[te].mean():.3f}) ===", flush=True)

        cands = {}
        # -- benchmarks -------------------------------------------------
        b = platt(np.clip(df.r_pg.values[tr] / 12.0, 1e-4, 1 - 1e-4), y[tr])
        cands["base_r_pg"] = apply_platt(np.clip(df.r_pg.values[te] / 12.0, 1e-4, 1 - 1e-4), b)
        praw = 1.0 - poisson.cdf(line - 1, lam)
        b = platt(np.clip(praw[tr], 1e-4, 1 - 1e-4), y[tr])
        cands["poisson_napkin"] = apply_platt(np.clip(praw[te], 1e-4, 1 - 1e-4), b)

        # -- the zoo ----------------------------------------------------
        for name, run in model_zoo().items():
            try:
                cands[name] = run(Xtr, y[tr], Xte)
            except Exception as e:  # pragma: no cover - diagnostic only
                print(f"  {name}: FAILED {e}")
        try:
            cands["STACK"] = stack(Xtr, y[tr], Xte)
        except Exception as e:  # pragma: no cover
            print(f"  STACK: FAILED {e}")

        for name, p in cands.items():
            m = evaluate(dte, y[te], p)
            m.update(market=market, model=name,
                     top3=slate_topn(dte, y[te], p, 3),
                     top1=slate_topn(dte, y[te], p, 1))
            rows.append(m)
        board = sorted([r for r in rows if r["market"] == market],
                       key=lambda r: -r["auc"])
        for r in board:
            print(f"  {r['model']:20s} auc={r['auc']:.4f} brier={r['brier']:.4f} "
                  f"top1={r['top1']:.3f} top3={r['top3']:.3f} top5={r['top5']:.3f} "
                  f"cal={r['cal']:.3f}/{r['base']:.3f}", flush=True)
        print()

    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(HERE, "bakeoff_team.csv"), index=False)

    print("=== mean AUC across the three markets ===")
    mean = res.groupby("model").auc.mean().sort_values(ascending=False)
    for k, v in mean.items():
        print(f"  {k:20s} {v:.4f}")

    # ---------------------------------------------------------- ranking
    # The app's real question is not "will they clear 4.5" but "who scores most
    # tonight", so score the runs regression as a ranker too.
    print("\n=== expected-runs regression (ranking the slate) ===")
    runs = df.runs.values.astype(float)
    for name, mk in (("linear", LinearRegression), ("poisson_glm", PoissonRegressor)):
        m = mk().fit(Xtr, runs[tr])
        pred = m.predict(Xte)
        rho = float(pd.Series(pred).corr(pd.Series(runs[te]), method="spearman"))
        d = pd.DataFrame({"d": dte, "p": pred, "r": runs[te]})
        tops = {n: d.groupby("d", group_keys=False).apply(
            lambda g: g.nlargest(n, "p").r.mean()).mean() for n in (1, 3, 5)}
        print(f"  {name:12s} spearman={rho:.4f} rmse={np.sqrt(np.mean((pred-runs[te])**2)):.3f} "
              f"top1 runs={tops[1]:.2f} top3={tops[3]:.2f} top5={tops[5]:.2f} "
              f"(slate mean {runs[te].mean():.2f})")
    napkin_rho = float(pd.Series(lam[te]).corr(pd.Series(runs[te]), method="spearman"))
    print(f"  {'poisson_napkin':12s} spearman={napkin_rho:.4f}")


if __name__ == "__main__":
    main()
