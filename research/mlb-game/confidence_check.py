"""
Does the shipped model's confidence mean anything?

The Best Odds page now leads with "model confidence" — the Elo pick, ranked by
how sure the model is, with the price ignored. This checks that ranking against
reality: replay the shipped Elo (mlb-sim.ts constants) over 2021-2026, calibrate
on 2021-2022, then bucket every 2023-2026 pick by confidence and count how often
it actually won.

Also reports the top-N-per-day hit rate, which is exactly what the page shows.
"""

import os

import numpy as np
import pandas as pd

from bakeoff_v2 import shipped_elo_probs
import bakeoff_mlb as B

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CALIB = [2021, 2022]
TEST = [2023, 2024, 2025, 2026]


def main():
    df = pd.read_csv(os.path.join(DATA, "games.csv"))
    df["home_win"] = (df.home_score > df.away_score).astype(int)
    df = df.sort_values(["date", "gamePk"]).reset_index(drop=True)
    df["elo_p"] = shipped_elo_probs(df)

    tr, te = df[df.season.isin(CALIB)], df[df.season.isin(TEST)]
    p_te = B.platt(tr.elo_p.values, tr.home_win.values, te.elo_p.values)

    te = te.assign(p=p_te)
    # The pick is the favoured side; confidence is its win probability.
    te = te.assign(
        pick_home=te.p >= 0.5,
        conf=np.maximum(te.p, 1 - te.p),
    )
    te = te.assign(hit=np.where(te.pick_home, te.home_win == 1, te.home_win == 0))

    print(f"{len(te):,} games, {TEST[0]}-{TEST[-1]}   overall pick accuracy "
          f"{te.hit.mean():.3f}   (always-home {te.home_win.mean():.3f})")
    print(f"\n{'confidence':>14}  {'n':>6}  {'predicted':>9}  {'actual':>7}  {'breakeven price':>15}")
    edges = [0.50, 0.53, 0.56, 0.59, 0.62, 0.65, 1.01]
    for lo, hi in zip(edges, edges[1:]):
        m = (te.conf >= lo) & (te.conf < hi)
        if m.sum() < 50:
            continue
        act = te.hit[m].mean()
        price = f"-{round(100 * act / (1 - act))}" if act > 0.5 else f"+{round(100 * (1 - act) / act)}"
        print(f"{lo:>7.2f}-{hi:<6.2f} {m.sum():>6,}  {te.p[m].pipe(lambda s: np.maximum(s, 1 - s)).mean():>9.3f}"
              f"  {act:>7.3f}  {price:>15}")

    # What the page actually shows: the day's N most confident picks.
    print(f"\n{'picks/day':>10}  {'n':>6}  {'hit rate':>9}")
    for n in (1, 2, 3, 5):
        hits = tot = 0
        for _, g in te.groupby("date"):
            top = g.nlargest(n, "conf")
            hits += int(top.hit.sum())
            tot += len(top)
        print(f"{n:>10}  {tot:>6,}  {hits / tot:>9.3f}")

    # Season by season, so one lucky year cannot carry the number.
    print(f"\n{'season':>7}  {'games':>6}  {'top-3/day':>10}  {'all picks':>10}")
    for s, g in te.groupby("season"):
        hits = tot = 0
        for _, d in g.groupby("date"):
            top = d.nlargest(3, "conf")
            hits += int(top.hit.sum())
            tot += len(top)
        print(f"{s:>7}  {len(g):>6,}  {hits / tot:>10.3f}  {g.hit.mean():>10.3f}")


if __name__ == "__main__":
    main()
