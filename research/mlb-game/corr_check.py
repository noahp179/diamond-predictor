"""Why averaging the models barely moves the needle: they all say the same thing.

Correlation of the calibrated probabilities across the rating families on the
pooled 2023-2026 test seasons. Signals only (no ML), so this runs in a couple of
minutes.
"""
import os
import numpy as np, pandas as pd
import bakeoff_mlb as B
from bakeoff_v2 import shipped_elo_probs, logit

HERE = os.path.dirname(os.path.abspath(__file__))
df = pd.read_csv(os.path.join(HERE, "data", "games.csv"))
df["home_win"] = (df.home_score > df.away_score).astype(int)
df = df.sort_values(["date", "gamePk"]).reset_index(drop=True)
B.LG_RUNS = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))
sigs, _ = B.walk(df)
sigs["shipped_elo"] = shipped_elo_probs(df)

COLS = ["shipped_elo", "elo_margin_of_victory", "elo_plus_pitcher", "elo_basic", "glicko",
        "massey", "colley", "bradley_terry", "kalman_state_space", "bayes_hierarchical",
        "dixon_coles", "win_pct_log5", "run_differential"]
tr = sigs.season.isin([2021, 2022]).values
te = sigs.season.isin([2023, 2024, 2025, 2026]).values
y = sigs.home_win.values
P = {c: B.platt(sigs[c].values[tr], y[tr], sigs[c].values[te]) for c in COLS}
L = pd.DataFrame({c: logit(v) for c, v in P.items()})
C = L.corr()
print(f"pairwise correlation of model log-odds, {te.sum():,} test games\n")
print(C.round(2).to_string())
off = C.values[np.triu_indices(len(COLS), 1)]
print(f"\nmean pairwise correlation: {off.mean():.3f}   min {off.min():.3f}   max {off.max():.3f}")
print(f"effective independent models (1/mean corr proxy): {1/off.mean():.1f} of {len(COLS)}")
