"""
Ablations: which features actually earn their place, and does surface help at all?

The bake-off produced an uncomfortable result — surface-specific Elo is WORSE
than global Elo on both tours, and the surface/global blend is no better than
global alone. That kills surface as a rating SPLIT, but it does not settle
whether surface helps as a FEATURE inside a model that also sees global form.
Those are different questions and this script answers the second one.

Method: refit the shipped model family (a logistic over the antisymmetric
feature block) with one group of features removed at a time, on the same
walk-forward split as the bake-off. A group earns its place if removing it makes
log loss worse. Anything that does not is reported as not earning it — including
the surface block, if that is how it falls.

Groups are declared before the run, so this is a pre-registered ablation rather
than a search for a flattering subset.

Usage: python3 ablate_tennis.py --tour atp
"""

import argparse
import os
import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from bakeoff_tennis import SIGNALS, logloss, brier, accuracy, auc, orient, walk
from tours import ROLLING_TEST, add_tour_arg, get as get_tour

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

# The extra non-signal columns walk() appends, in order.
EXTRA = ["bestOf", "drawSize", "roundId"]
ALL_COLS = SIGNALS + EXTRA

# Pre-registered groups. Every column belongs to exactly one.
GROUPS = {
    "surface": ["elo_surface", "elo_blend", "surface_winrate"],
    "elo_family": ["elo", "elo_fast", "elo_slow", "elo_games"],
    "other_ratings": ["glicko", "bradley_terry"],
    "form": ["winrate", "form_last10", "games_won_ratio", "streak"],
    "matchup": ["head_to_head", "common_opponents"],
    "seeding": ["seed_diff"],
    "physical": ["fatigue", "rest_days"],
    "experience": ["experience"],
    "context": EXTRA,
}


def fit_score(feats, y, df, cols):
    idx = [ALL_COLS.index(c) for c in cols]
    P, Y = [], []
    for ts in ROLLING_TEST:
        tr = (df.season < ts).values
        te = (df.season == ts).values
        if te.sum() == 0 or tr.sum() < 500:
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000))
        m.fit(feats[tr][:, idx], y[tr])
        P.append(m.predict_proba(feats[te][:, idx])[:, 1])
        Y.append(y[te])
    p, yy = np.concatenate(P), np.concatenate(Y)
    return dict(logloss=logloss(yy, p), brier=brier(yy, p),
                acc=accuracy(yy, p), auc=auc(yy, p))


def main():
    ap = add_tour_arg(argparse.ArgumentParser(description=__doc__))
    tour = get_tour(ap.parse_args().tour)
    os.makedirs(RESULTS, exist_ok=True)

    raw = pd.read_csv(os.path.join(HERE, "data", tour.slug, "matches.csv")).sort_values(
        ["date", "matchId"])
    df = orient(raw).reset_index(drop=True)
    print(f"{tour.name}: {len(df):,} matches — walking forward ...", flush=True)
    sig, feats, y = walk(df)

    full = fit_score(feats, y, df, ALL_COLS)
    rows = [dict(group="(full model)", n_cols=len(ALL_COLS), **full, delta=0.0)]
    for g, cols in GROUPS.items():
        keep = [c for c in ALL_COLS if c not in cols]
        s = fit_score(feats, y, df, keep)
        rows.append(dict(group=f"drop {g}", n_cols=len(keep), **s,
                         delta=s["logloss"] - full["logloss"]))

    # And the reverse for surface: surface features ALONE, to see if they carry
    # anything at all once separated from the global ratings.
    only = fit_score(feats, y, df, GROUPS["surface"])
    rows.append(dict(group="(surface features only)", n_cols=3, **only,
                     delta=only["logloss"] - full["logloss"]))

    R = pd.DataFrame(rows)
    R.insert(0, "tour", tour.slug)
    R.to_csv(os.path.join(RESULTS, f"{tour.slug}_ablation.csv"), index=False)

    print("\n" + "=" * 84)
    print(f"{tour.name} FEATURE ABLATION — positive delta means the group EARNS its place")
    print("=" * 84)
    print(f"{'group':26} {'cols':>5} {'logloss':>9} {'acc':>7} {'AUC':>7} {'delta':>9}")
    for r in R.itertuples():
        mark = ""
        if r.group.startswith("drop"):
            mark = "  earns it" if r.delta > 0.0005 else ("  no effect" if r.delta > -0.0005
                                                          else "  HURTS the model")
        print(f"{r.group:26} {r.n_cols:>5} {r.logloss:>9.4f} {r.acc:>7.1%} {r.auc:>7.4f} "
              f"{r.delta:>+9.4f}{mark}")
    print(f"\nsaved -> results/{tour.slug}_ablation.csv")


if __name__ == "__main__":
    main()
