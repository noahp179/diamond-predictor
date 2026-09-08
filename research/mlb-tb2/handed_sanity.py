"""
Is there anything in the handed features at all?

A block that adds nothing to a fitted model has two possible explanations: the
effect is not there, or it is there and the model already had it. This separates
them, using the held-out season only and no model at all:

  1. the raw hit rate by platoon matchup, and by how much of a hitter's night is
     against the bullpen — if the effect exists, it is visible here
  2. each new feature's own AUC, alone, against 2+ total bases
  3. how much of each new feature is already inside the shipped model, as the R^2
     of regressing it on the 46 features that ship

Usage: python3 handed_sanity.py
"""

import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
sys.path.insert(0, HERE)
from features import BATTER_FEATURES  # noqa: E402

from features_tb2 import EXTRA_BLOCKS  # noqa: E402
from handed_bakeoff import auc  # noqa: E402
from handed_features import HANDED_BLOCKS, HANDED_FEATURES  # noqa: E402

SHIPPED = (BATTER_FEATURES + ["own_tb2", "ownw_tb2"] + EXTRA_BLOCKS["parktb"]
           + EXTRA_BLOCKS["def"] + EXTRA_BLOCKS["form15"] + EXTRA_BLOCKS["fcwx"])


def main():
    b = pd.read_csv(os.path.join(PROPS, "batter_features.csv"))
    x = pd.read_csv(os.path.join(DATA, "extra_features.csv"))
    h = pd.read_csv(os.path.join(DATA, "handed_features.csv"))
    df = b.merge(x, on=["gamePk", "batter_id"]).merge(h, on=["gamePk", "batter_id"])
    te = df[df.season == 2026].copy()
    y = te.y_tb2.values.astype(int)
    out = {}
    print(f"held-out rows {len(te):,}  base rate {y.mean():.4f}\n")

    # ------------------------------------------------- 1. the raw effects
    print("=== raw hit rate by platoon matchup (no model) ===")
    grp = []
    for tag, m in (("platoon edge (opposite hands)", te.platoon_edge == 1),
                   ("same hand", te.same_hand == 1),
                   ("switch hitter", te.bats_switch == 1)):
        grp.append(dict(split=tag, n=int(m.sum()), rate=float(y[m.values].mean())))
        print(f"  {tag:30s} n={m.sum():6,}  {y[m.values].mean():.4f}")
    out["platoon_raw"] = grp

    print("\n=== raw hit rate by the starter's own split (quintiles of sp_tb_pa_h) ===")
    q = pd.qcut(te.sp_tb_pa_h, 5, labels=False, duplicates="drop")
    rows = []
    for i in sorted(set(q.dropna())):
        m = (q == i).values
        rows.append(dict(quintile=int(i) + 1, n=int(m.sum()),
                         mean=float(te.sp_tb_pa_h[m].mean()), rate=float(y[m].mean())))
        print(f"  Q{int(i) + 1}  sp_tb_pa_h {te.sp_tb_pa_h[m].mean():.4f}  "
              f"n={m.sum():6,}  hit {y[m].mean():.4f}")
    out["sp_split_raw"] = rows

    print("\n=== raw hit rate by bullpen exposure (quintiles of pen_share) ===")
    q = pd.qcut(te.pen_share, 5, labels=False, duplicates="drop")
    rows = []
    for i in sorted(set(q.dropna())):
        m = (q == i).values
        rows.append(dict(quintile=int(i) + 1, n=int(m.sum()),
                         mean=float(te.pen_share[m].mean()), rate=float(y[m].mean())))
        print(f"  Q{int(i) + 1}  pen_share {te.pen_share[m].mean():.4f}  "
              f"n={m.sum():6,}  hit {y[m].mean():.4f}")
    out["pen_share_raw"] = rows

    print("\n=== a good bullpen vs a bad one, holding exposure high ===")
    hi = te[te.pen_share > te.pen_share.median()]
    yh = hi.y_tb2.values.astype(int)
    q = pd.qcut(hi.pen_tb_pa_h, 4, labels=False, duplicates="drop")
    rows = []
    for i in sorted(set(q.dropna())):
        m = (q == i).values
        rows.append(dict(quartile=int(i) + 1, n=int(m.sum()),
                         mean=float(hi.pen_tb_pa_h[m].mean()), rate=float(yh[m].mean())))
        print(f"  Q{int(i) + 1}  pen_tb_pa_h {hi.pen_tb_pa_h[m].mean():.4f}  "
              f"n={m.sum():6,}  hit {yh[m].mean():.4f}")
    out["pen_quality_raw"] = rows

    # ------------------------------------------ 2. each feature on its own
    print("\n=== each new feature's own AUC (0.5 = nothing) ===")
    solo = []
    for f in HANDED_FEATURES:
        v = te[f].values.astype(float)
        a = auc(y, v)
        solo.append(dict(feature=f, auc=a))
    for r in sorted(solo, key=lambda r: -abs(r["auc"] - 0.5)):
        print(f"  {r['feature']:16s} {r['auc']:.4f}  ({abs(r['auc'] - 0.5):.4f} from nothing)")
    out["solo_auc"] = solo

    # ------------------------------- 3. how much the shipped model already has
    print("\n=== how much of each new feature the shipped model already contains ===")
    from sklearn.linear_model import LinearRegression
    from sklearn.preprocessing import StandardScaler
    X = df[SHIPPED].values.astype(float)
    sc = StandardScaler().fit(X)
    Xs = sc.transform(X)
    r2 = []
    for name, cols in HANDED_BLOCKS.items():
        for f in cols:
            t = df[f].values.astype(float)
            if t.std() == 0:
                continue
            m = LinearRegression().fit(Xs, t)
            score = float(m.score(Xs, t))
            r2.append(dict(block=name, feature=f, r2=score))
            print(f"  {name:8s} {f:16s} R2={score:.3f}")
    out["explained_by_shipped"] = r2

    json.dump(out, open(os.path.join(HERE, "handed_sanity.json"), "w"), indent=1,
              default=float)
    print(f"\nwrote {os.path.join(HERE, 'handed_sanity.json')}")


if __name__ == "__main__":
    main()
