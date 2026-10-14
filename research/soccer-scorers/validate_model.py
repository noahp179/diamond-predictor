"""
Reproduce the research pipeline's held-out numbers for the shipped goal1 model.

research/soccer/props_soccer.py trains on <= 2023-24, picks on 2024-25 and
confirms on 2025-26, and stores the confirmation AUC / n / top-1 / top-5 in the
shipped model file (src/lib/soccer-props-model.json). This script feeds OUR
fetch (data/player_matches.csv.gz) through that file's own build() -- imported,
not copied -- in the CSV layout research/soccer/fetch_soccer.py writes, applies
the SHIPPED coefficients and Platt terms, and compares.

If the numbers agree, our data is the data the model was built on, and the
"model" column of the backtest can be trusted to be the shipped model. The
research features differ from the live site's in three ways (career-long player
totals since 2021-22 instead of this season's; this match's slot position and
formation place instead of the last-seen; same-day earlier matches included),
so the main backtest uses the live port in features.py; this is a check.

Writes data/research_style_preds.csv.gz (research-style model_p for every row
build() produces) and prints the comparison.

Usage: python3 validate_model.py
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(HERE, "data")
sys.path.insert(0, os.path.join(ROOT, "research", "soccer"))
import props_soccer  # noqa: E402

PROPS = json.load(open(os.path.join(ROOT, "src", "lib", "soccer-props-model.json")))
DOMESTIC = {"eng.1": "epl", "esp.1": "laliga", "ger.1": "bundesliga", "ita.1": "seriea", "fra.1": "ligue1"}


def compat(pm, md, comp, slug):
    """Write research/soccer's CSV layout for one league under data/compat/<slug>/."""
    d = os.path.join(DATA, "compat", slug)
    os.makedirs(d, exist_ok=True)
    p = pm[(pm.comp == comp) & (pm.season <= 2025)].copy()
    m = md[(md.comp == comp) & (md.season <= 2025)].copy()
    p["mins_est"] = np.where(p.starter == 1, np.where(p.subbed_out == 1, 65.0, 90.0),
                             np.where(p.subbed_in == 1, 25.0, 0.0))
    for k in ("saves", "shotsFaced", "goalsConceded", "subIns", "foulsSuffered"):
        if k not in p:
            p[k] = 0.0
    p["matchId"] = p.matchId.astype(np.int64)
    m["matchId"] = m.matchId.astype(np.int64)
    p.to_csv(os.path.join(d, "player_matches.csv"), index=False)
    m.rename(columns={"hg": "home_goals", "ag": "away_goals"})[
        ["matchId", "date", "season", "home_id", "away_id", "home_goals", "away_goals"]].to_csv(
        os.path.join(d, "matches.csv"), index=False)
    return d


def apply(mk, X):
    z = mk["intercept"] + ((X - np.array(mk["mean"])) / np.where(np.array(mk["std"]) == 0, 1,
                                                                 np.array(mk["std"]))) @ np.array(mk["coef"])
    raw = 1 / (1 + np.exp(-z))
    c = np.clip(raw, 1e-9, 1 - 1e-9)
    lg = np.log(c / (1 - c))
    return 1 / (1 + np.exp(-(mk["plattA"] * lg + mk["plattB"])))


def main():
    pm = pd.read_csv(os.path.join(DATA, "player_matches.csv.gz"), keep_default_na=False, na_values=[""],
                     dtype={"matchId": str, "team_id": str, "opp_id": str, "player_id": str})
    md = pd.read_csv(os.path.join(DATA, "matches.csv"), dtype={"matchId": str})
    out = []
    print(f"{'league':<11} {'n ours':>7} {'n shipped':>9} {'AUC ours':>9} {'AUC shipped':>11} "
          f"{'top1 ours':>9} {'top1 shp':>8} {'top5 ours':>9} {'top5 shp':>8}")
    for comp, slug in DOMESTIC.items():
        d = compat(pm, md, comp, slug)
        df = props_soccer.build(d)
        mk = PROPS[slug]["markets"]["goal1"]
        p = apply(mk, df[mk["features"]].values.astype(float))
        df["model_p_research"] = p
        con = df.season == 2025
        y = df.y_goal1.values
        top1 = props_soccer.slate_topn(df.date.values[con], y[con], p[con], 1)
        top5 = props_soccer.slate_topn(df.date.values[con], y[con], p[con], 5)
        print(f"{slug:<11} {con.sum():>7} {mk['n']:>9} {roc_auc_score(y[con], p[con]):>9.4f} {mk['auc']:>11.4f} "
              f"{top1:>9.3f} {mk['top1']:>8.3f} {top5:>9.3f} {mk['top5']:>8.3f}")
        out.append(df[["matchId", "player_id", "season", "date", "model_p_research", "y_goal1"]].assign(league=slug))
    R = pd.concat(out)
    R.to_csv(os.path.join(DATA, "research_style_preds.csv.gz"), index=False, compression="gzip")


if __name__ == "__main__":
    main()
