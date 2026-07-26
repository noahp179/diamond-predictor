"""
Show what one week of output looks like: for each game, the top player(s) most
likely to score a TD, with the model's likelihood and a confidence score, plus
what actually happened. Uses the shippable model (logistic + market).
"""
import sys
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.isotonic import IsotonicRegression
import market as mk, bakeoff as bo

SEASON, WEEK = 2024, int(sys.argv[1]) if len(sys.argv) > 1 else 10
FE = bo.FEATURES + mk.MKT

f = mk.merged_with_market()
tr = f[f.season.isin([2021, 2022, 2023])]
model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)).fit(tr[FE], tr.scored)
iso = IsotonicRegression(out_of_bounds="clip").fit(model.predict_proba(tr[FE])[:, 1], tr.scored.values)

wk = f[(f.season == SEASON) & (f.week == WEEK)].copy()
wk["p"] = iso.transform(model.predict_proba(wk[FE])[:, 1])


def confidence(g):
    p = g["p"].values
    p1, p2 = p[0], (p[1] if len(p) > 1 else 0)
    sep = min(1, max(0, ((p1 - p2) / (p1 + 1e-9)) / 0.5))
    mat = min(1, g.iloc[0]["games_hist"] / 6)
    vol = min(1, g.iloc[0]["proj_touches"] / 18)
    return round(100 * (0.45 * sep + 0.30 * mat + 0.25 * vol))


print(f"\n  NFL {SEASON} — WEEK {WEEK}: most likely touchdown scorers (model: logistic + market)\n")
print(f"  {'GAME':<14}{'PICK':<22}{'LIKELIHOOD':>11}{'CONF':>6}   RESULT")
print("  " + "-" * 68)
for gid, g in wk.groupby("game_id"):
    g = g.sort_values("p", ascending=False).reset_index(drop=True)
    away, home = gid.split("_")[2], gid.split("_")[3]
    matchup = f"{away}@{home}"
    for i in range(min(2, len(g))):
        r = g.iloc[i]
        conf = confidence(g) if i == 0 else confidence(g.iloc[[1, 0]] if len(g) > 1 else g)
        res = "TD  ✓" if r["scored"] == 1 else "no    "
        tag = "①" if i == 0 else "②"
        gm = matchup if i == 0 else ""
        print(f"  {gm:<14}{tag} {r['player'][:19]:<20}{r['p']*100:>9.0f}%{conf:>6}   {res}")
    print()

# week accuracy summary
top1 = top2 = ngames = 0
for gid, g in wk.groupby("game_id"):
    g = g.sort_values("p", ascending=False)
    sc = set(g.loc[g.scored == 1, "player_id"])
    ngames += 1
    top1 += int(g.iloc[0].player_id in sc)
    top2 += int(any(pid in sc for pid in g.iloc[:2].player_id))
print(f"  Week {WEEK} scoreboard: top-1 hit {top1}/{ngames} = {top1/ngames:.0%}   "
      f"top-2 hit {top2}/{ngames} = {top2/ngames:.0%}")
