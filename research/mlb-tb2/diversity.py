"""
Would the board be more accurate if it stopped stacking one lineup?

team_concentration.py established that the clustering is structural and that
the team-level numbers are honest. This asks the follow-up: if you *forced* the
picks apart — one per team, one per game, at most two per team — do you end up
with a better set of bets, or just a worse one that looks more varied?

Two different questions hide inside "more accurate", and they have different
answers, so both are measured:

  hit rate     do the picks land more often? Forcing diversity means passing
               over a higher-rated hitter for a lower-rated one, so this can
               only go down. The question is by how much.
  calibration  is the number more trustworthy? If concentrated picks are
               systematically over-stated — because nine hitters share a
               pitcher and a night — then diversity buys reliability even
               while costing hit rate. This is the question that matters.

And because these are usually bet as a set, the spread matters too: how often
does a whole card of N go 0-for-N, and how often does it sweep.

Usage: python3 diversity.py
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
SIZES = (3, 5, 10)


def pick(day, n, cap_team=None, cap_game=None):
    """The n best-rated hitters on a slate, subject to a per-team or per-game cap."""
    out = []
    seen_team, seen_game = {}, {}
    for r in day.sort_values("p", ascending=False).itertuples():
        if cap_team is not None and seen_team.get(r.team_id, 0) >= cap_team:
            continue
        if cap_game is not None and seen_game.get(r.gamePk, 0) >= cap_game:
            continue
        out.append(r.Index)
        seen_team[r.team_id] = seen_team.get(r.team_id, 0) + 1
        seen_game[r.gamePk] = seen_game.get(r.gamePk, 0) + 1
        if len(out) == n:
            break
    return out


STRATEGIES = {
    "top N, no constraint (ships)": dict(cap_team=None, cap_game=None),
    "at most 2 per team": dict(cap_team=2, cap_game=None),
    "one per team": dict(cap_team=1, cap_game=None),
    "at most 2 per game": dict(cap_team=None, cap_game=2),
    "one per game": dict(cap_team=None, cap_game=1),
}


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    p = fit(df, SERVABLE, tr, te, y)
    d = df[te].copy().reset_index(drop=True)
    d["p"] = p
    d["y"] = y[te]
    days = list(d.groupby("date"))
    print(f"held-out slates {len(days)}   rows {len(d):,}   base rate {d.y.mean():.4f}")

    for n in SIZES:
        print(f"\n{'='*78}\nPICKING {n} HITTERS A DAY\n{'='*78}")
        # Every strategy must be graded on the SAME slates, or the comparison is
        # partly a comparison of which days each one could fill. A one-per-game
        # rule needs n games, so a short slate drops out for everybody.
        picks_by = {name: {} for name in STRATEGIES}
        for date, day in days:
            got = {}
            for name, kw in STRATEGIES.items():
                idx = pick(day, n, **kw)
                if len(idx) < n:
                    break
                got[name] = idx
            if len(got) == len(STRATEGIES):
                for name, idx in got.items():
                    picks_by[name][date] = idx
        common = sorted(picks_by[next(iter(STRATEGIES))])
        print(f"{len(common)} slates every strategy can fill\n")
        print(f"{'strategy':30s} {'predicted':>10s} {'actual':>8s} {'gap':>7s} "
              f"{'teams':>6s} {'0-for-N':>8s} {'swept':>7s}")
        rows = []
        for name in STRATEGIES:
            preds, acts, nteams, busts, sweeps = [], [], [], [], []
            for date in common:
                sel = d.loc[picks_by[name][date]]
                preds.append(sel.p.mean())
                acts.append(sel.y.mean())
                nteams.append(sel.team_id.nunique())
                hits = int(sel.y.sum())
                busts.append(hits == 0)
                sweeps.append(hits == n)
            pr, ac = float(np.mean(preds)), float(np.mean(acts))
            rows.append(dict(strategy=name, pred=pr, actual=ac, gap=ac - pr,
                             per_slate=acts, bust=float(np.mean(busts))))
            print(f"{name:30s} {pr*100:9.1f}% {ac*100:7.1f}% {(ac-pr)*100:+6.1f} "
                  f"{np.mean(nteams):6.1f} {np.mean(busts)*100:7.1f}% "
                  f"{np.mean(sweeps)*100:6.1f}%")

        # Paired over slates, because the same day's weather and pitching
        # matchups drive every strategy at once. A one-point difference on ~150
        # slates is well inside the noise, so the band is what decides.
        base = rows[0]
        print(f"\n  vs the unconstrained board (paired bootstrap over slates, 95%):")
        for r in rows[1:]:
            diffs = np.array(r["per_slate"]) - np.array(base["per_slate"])
            rng = np.random.default_rng(0)
            boot = np.array([rng.choice(diffs, len(diffs), replace=True).mean()
                             for _ in range(3000)])
            lo, hi = np.percentile(boot, [2.5, 97.5]) * 100
            verdict = ("BETTER" if lo > 0 else "WORSE" if hi < 0
                       else "no measurable difference")
            print(f"    {r['strategy']:26s} {diffs.mean()*100:+5.1f} pts "
                  f"[{lo:+5.1f}, {hi:+5.1f}]  {verdict}")

    # Is the gap between predicted and actual driven by how concentrated the
    # slate's picks are? That is the sharpest form of the question.
    print(f"\n{'='*78}\nDOES CONCENTRATION ITSELF COST ACCURACY?\n{'='*78}")
    recs = []
    for _, day in days:
        idx = pick(day, 10)
        if len(idx) < 10:
            continue
        sel = d.loc[idx]
        recs.append(dict(teams=sel.team_id.nunique(), pred=sel.p.mean(),
                         actual=sel.y.mean()))
    r = pd.DataFrame(recs)
    r["band"] = pd.cut(r.teams, [0, 5, 6, 7, 20],
                       labels=["<=5 teams", "6 teams", "7 teams", "8+ teams"])
    t = r.groupby("band", observed=True).agg(n=("pred", "size"), pred=("pred", "mean"),
                                             actual=("actual", "mean"))
    print("  a 10-pick board, split by how many teams it drew from:")
    for band, row in t.iterrows():
        print(f"    {str(band):10s} n={int(row.n):3d}  predicted {row.pred*100:.1f}%  "
              f"actual {row.actual*100:.1f}%  gap {(row.actual-row.pred)*100:+.1f}")
    if len(r) > 30:
        c = float(np.corrcoef(r.teams, r.actual - r.pred)[0, 1])
        print(f"\n  correlation between 'more teams' and 'beat the projection': {c:+.3f}")
        print("  positive would mean spreading out makes the number more honest;"
              "\n  near zero means concentration is not what drives the error.")


if __name__ == "__main__":
    main()
