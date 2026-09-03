"""
Why do so many of the top picks come from the same lineup?

A game card shows the three most likely hitters in that game, and about a third
of the time all three are from one side. Chance alone would do that 21% of the
time (2 * C(9,3) / C(18,3)), so the board really is clustered. This asks whether
it is clustered *correctly*.

The mechanism is not a mystery. Sixteen of the model's forty-four features are
identical for all nine hitters in a lineup — the park, the temperature, the
opposing starter, the opponent's staff, home or away, the team's own run rate.
Those sixteen move all nine projections together. So the question is not whether
team context leaks into the ranking (it must, and should) but whether the model
gives it *more* weight than the outcomes justify.

Three tests:
  1. variance decomposition — how much of the projection is the lineup, and how
     much is the hitter, versus how much of the actual outcome is each
  2. calibration at team level — when the model says a lineup averages 40%, does
     that lineup average 40%
  3. does a same-team sweep of a game card do worse than a split one

Usage: python3 team_concentration.py
"""

import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bakeoff_tb2 import BASE, load  # noqa: E402
from features_tb2 import EXTRA_BLOCKS  # noqa: E402
from final_tb2 import fit  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
SERVABLE = (BASE + EXTRA_BLOCKS["parktb"] + EXTRA_BLOCKS["def"]
            + EXTRA_BLOCKS["form15"] + EXTRA_BLOCKS["fcwx"])

# Features that are the same number for every hitter in a lineup that night.
SHARED = ["is_home", "park", "team_r_pg", "opp_r_allowed_pg",
          "sp_k_bf", "sp_h_bf", "sp_hr_bf", "sp_bb_bf", "sp_bf_start", "sp_known",
          "park_tb", "def_tb_pa", "def_xbh_pa", "def_known", "temp_fc"]


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    p = fit(df, SERVABLE, tr, te, y)

    d = df[te].copy()
    d["p"] = p
    d["y"] = y[te]
    print(f"held-out rows {len(d):,}   base rate {d.y.mean():.4f}\n")

    shared = [f for f in SHARED if f in SERVABLE]
    print(f"features identical for all nine hitters in a lineup: "
          f"{len(shared)} of {len(SERVABLE)}")

    # ------------------------------------------------- 1. how much is the team
    g = d.groupby(["gamePk", "team_id"])
    team_mean_p = g.p.transform("mean")
    within_p = d.p - team_mean_p
    var_between = float(np.var(team_mean_p))
    var_within = float(np.var(within_p))
    print(f"\n1. WHERE THE PROJECTION COMES FROM")
    print(f"   between lineups  {var_between / (var_between + var_within):6.1%}"
          f"   (sd {np.sqrt(var_between)*100:.2f} points)")
    print(f"   within a lineup  {var_within / (var_between + var_within):6.1%}"
          f"   (sd {np.sqrt(var_within)*100:.2f} points)")

    # A tempting next step is to compare the model's between-lineup spread with
    # the spread of the actual team-game hit rates. It does not work: nine
    # hitters facing the same pitcher on the same night share whatever that
    # night turned out to be, and that shared luck is not predictable lineup
    # quality. Subtracting only binomial noise leaves it in and makes the model
    # look under-spread by a factor of three. The honest version of the same
    # question is the calibration below — bucket lineups by what the model
    # said and see what they did — which needs no assumption about where the
    # rest of the variance comes from.

    # ------------------------------------- 2. is the team-level number honest
    tg = g.agg(p=("p", "mean"), y=("y", "mean"), n=("y", "size")).reset_index()
    tg = tg[tg.n >= 8]
    print(f"\n2. TEAM-LEVEL CALIBRATION  ({len(tg):,} lineup-games)")
    tg["bucket"] = pd.qcut(tg.p, 6, labels=False)
    tab = tg.groupby("bucket").agg(n=("y", "size"), pred=("p", "mean"),
                                   actual=("y", "mean"))
    for _, r in tab.iterrows():
        flag = "" if abs(r.pred - r.actual) < 0.02 else "  <--"
        print(f"   predicted {r.pred*100:5.1f}%   actual {r.actual*100:5.1f}%"
              f"   (n={int(r.n)}){flag}")
    print(f"   mean |error| across buckets: "
          f"{float((tab.pred - tab.actual).abs().mean())*100:.2f} points")
    pr = (tab.pred.max() - tab.pred.min()) * 100
    ar = (tab.actual.max() - tab.actual.min()) * 100
    print(f"   the model spreads lineups over {pr:.1f} points; they actually "
          f"spread over {ar:.1f}. Ratio {pr / ar:.2f} — "
          f"{'over' if pr / ar > 1.15 else 'under' if pr / ar < 0.85 else 'not over or under'}"
          f"-weighting the lineup.")

    # ------------------------------ 3. does a same-team sweep actually deliver
    print(f"\n3. GAME CARDS: DOES A ONE-SIDED TOP THREE DELIVER?")
    rows = []
    for gpk, gg in d.groupby("gamePk"):
        if gg.team_id.nunique() != 2 or len(gg) < 12:
            continue
        top3 = gg.nlargest(3, "p")
        rows.append(dict(gamePk=gpk, swept=int(top3.team_id.nunique() == 1),
                         pred=float(top3.p.mean()), actual=float(top3.y.mean()),
                         hits=int(top3.y.sum())))
    r = pd.DataFrame(rows)
    print(f"   {len(r):,} game cards, {r.swept.mean():.1%} show one side sweeping "
          f"the top three (chance alone: 20.6%)")
    for swept, lab in ((1, "one-sided"), (0, "split")):
        s = r[r.swept == swept]
        print(f"   {lab:10s} n={len(s):4d}  predicted {s.pred.mean()*100:.1f}%  "
              f"actual {s.actual.mean()*100:.1f}%  "
              f"({s.actual.mean() - s.pred.mean():+.3f})")
    # all three landing together is the risk a stack carries
    for swept, lab in ((1, "one-sided"), (0, "split")):
        s = r[r.swept == swept]
        print(f"   {lab:10s} all three hit {(s.hits == 3).mean():.1%}   "
              f"none hit {(s.hits == 0).mean():.1%}")


if __name__ == "__main__":
    main()
