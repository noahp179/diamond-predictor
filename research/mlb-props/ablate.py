"""
Where does the prop signal actually come from?

Drops one feature group at a time from the shipped logistic and re-runs the
2026 hold-out, so each group's contribution is measured, not assumed.
"""

import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from bakeoff import auc
from features import (BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES,
                      PITCHER_MARKETS)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TRAIN, TEST = (2024, 2025), 2026

BATTER_GROUPS = {
    "season rates": ["h_pa", "tb_pa", "hr_pa", "rbi_pa", "r_pa", "bb_pa", "k_pa", "sb_pa", "iso"],
    "last 30 days": ["w_h_pa", "w_tb_pa", "w_hr_pa", "w_pa_pg", "w_g"],
    "prior season": ["py_h_pa", "py_tb_pa", "py_hr_pa", "py_pa", "py_known"],
    "lineup slot": ["slot"],
    "playing time": ["pa_pg", "gp"],
    "park + home": ["park", "is_home"],
    "team context": ["team_r_pg", "opp_r_allowed_pg"],
    "opposing starter": ["sp_k_bf", "sp_h_bf", "sp_hr_bf", "sp_bb_bf", "sp_bf_start", "sp_known"],
    "own prop rate": ["__own__"],
}
PITCHER_GROUPS = {
    "season rates": ["k_bf", "h_bf", "bb_bf", "hr_bf"],
    "workload": ["bf_start", "outs_start", "k_start", "gs"],
    "last 30 days": ["w_k_bf", "w_bf_start", "w_k_start", "w_gs"],
    "prior season": ["py_k_bf", "py_bf_start", "py_known"],
    "rest + home + park": ["days_rest", "is_home", "park"],
    "opposing lineup": ["opp_k_pa", "opp_h_pa", "opp_r_pg", "team_r_pg"],
    "own prop rate": ["__own__"],
}


def fit_auc(df, feats, market):
    y = df[f"y_{market}"].values.astype(int)
    X = df[feats].values.astype(float)
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    sc = StandardScaler().fit(X[tr])
    lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
    return auc(y[te], lr.predict_proba(sc.transform(X[te]))[:, 1])


def run(df, generic, markets, groups, kind, rows):
    for market in markets:
        own = [f"own_{market}", f"ownw_{market}"]
        full = generic + own
        base = fit_auc(df, full, market)
        rows.append({"kind": kind, "market": market, "dropped": "(nothing — full model)",
                     "auc": base, "delta": 0.0})
        print(f"\n{kind} · {market}: full AUC {base:.4f}")
        for gname, cols in groups.items():
            drop = own if cols == ["__own__"] else cols
            feats = [f for f in full if f not in drop]
            a = fit_auc(df, feats, market)
            rows.append({"kind": kind, "market": market, "dropped": gname,
                         "auc": a, "delta": a - base})
            print(f"   without {gname:20s} {a:.4f}  ({a - base:+.4f})")


def main():
    rows = []
    b = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    run(b, BATTER_FEATURES, list(BATTER_MARKETS), BATTER_GROUPS, "batter", rows)
    p = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    run(p, PITCHER_FEATURES, list(PITCHER_MARKETS), PITCHER_GROUPS, "pitcher", rows)
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(HERE, "ablation_results.csv"), index=False)

    print("\n===== mean AUC cost of removing each group =====")
    for kind, g in df[df.delta != 0].groupby("kind"):
        print(f"\n{kind}:")
        s = g.groupby("dropped").delta.mean().sort_values()
        for name, v in s.items():
            print(f"  {name:22s} {v:+.4f}")


if __name__ == "__main__":
    main()
