"""
Selective-conviction analysis for MLB — the lever MODEL-BAKEOFF.md identified for
NBA/NFL ("pick fewer, hit more"), now measured for baseball.
"""
import os, warnings
import numpy as np
import pandas as pd
import bakeoff_mlb as B

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE, "data", "games.csv"))
B.LG_RUNS = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))

sigs, _ = B.walk(df)
tr = sigs[sigs.season.isin({2021, 2022, 2023})]
te = sigs[sigs.season == 2024]
ytr, yte = tr.home_win.values, te.home_win.values

models = ["elo_plus_pitcher", "elo_margin_of_victory", "dixon_coles"]
P = {m: B.platt(tr[m].values, ytr, te[m].values) for m in models}

print(f"MLB selective conviction — 2024 test season ({len(yte):,} games)\n")
for m in models:
    p = P[m]
    conf = np.maximum(p, 1 - p)
    right = ((p >= 0.5) == (yte == 1))
    print(m)
    print(f"  {'threshold':>10} {'coverage':>10} {'games':>7} {'win rate':>10}")
    for t in (0.50, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65):
        msk = conf >= t
        if msk.sum() >= 30:
            print(f"  {t:>10.0%} {msk.mean():>10.1%} {msk.sum():>7d} {right[msk].mean():>10.1%}")
    print()

# agreement filter: Elo and the run-scoring model pointing the same way
pe, pdc = P["elo_plus_pitcher"], P["dixon_coles"]
agree = ((pe >= .5) == (pdc >= .5))
right_e = ((pe >= .5) == (yte == 1))
conf_e = np.maximum(pe, 1 - pe)
print("agreement filter (Elo+pitcher and Dixon-Coles agree)")
print(f"  {'extra conf':>11} {'coverage':>10} {'games':>7} {'win rate':>10}")
for t in (0.50, 0.55, 0.58, 0.60):
    msk = agree & (conf_e >= t)
    if msk.sum() >= 30:
        print(f"  {t:>11.0%} {msk.mean():>10.1%} {msk.sum():>7d} {right_e[msk].mean():>10.1%}")
