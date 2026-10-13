"""
Tune the cross-league Elo's constants on 2014-15 through 2016-17 only.

The objective is the mean RPS over every European match in those seasons — all
three competitions and their qualifiers, about 2,100 matches — with the 1X2
calibration refitted in-sample for each candidate. The test seasons (2017-18
onwards) are never read, so nothing reported by backtest_ucl.py was used to
choose a constant here.

Coordinate descent, two passes. Writes results/tuned_params.json.
"""

import json
import os

from common import DEFAULT, HERE, fit_mnl, load_matches, mnl_predict, pre_match_ratings, rps
import numpy as np

GRID = {
    "k": [10, 14, 18, 22, 26, 32],
    "eu_mult": [1.0, 1.25, 1.5, 2.0, 2.5],
    "hfa": [40, 55, 70, 85],
    "gd_exp": [0.3, 0.5, 0.7, 0.9],
    "carry": [0.6, 0.7, 0.8, 0.9, 1.0],
    "promo": [-40, 0, 40, 80],
    "euro_prior": [1200, 1250, 1300, 1350, 1400],
}


def objective(m, params, mask):
    rh, ra, _, _ = pre_match_ratings(m, params)
    X = np.c_[(rh - ra)[mask] / 400, (~m.neutral.values[mask]).astype(float)]
    y = m.res.values[mask]
    W, b = fit_mnl(X, y)
    return float(rps(mnl_predict(W, b, X), y).mean())


def main():
    m = load_matches()
    mask = m.europe.values & m.season.between(2014, 2016).values
    best = dict(DEFAULT)
    score = objective(m, best, mask)
    print(f"start {score:.5f}")
    for rnd in range(2):
        for key, values in GRID.items():
            for v in values:
                cand = dict(best, **{key: v})
                s = objective(m, cand, mask)
                if s < score - 1e-6:
                    best, score = cand, s
            print(f"pass {rnd + 1} {key:>10} = {best[key]:<6} rps {score:.5f}")
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    with open(os.path.join(HERE, "results", "tuned_params.json"), "w") as f:
        json.dump(dict(params=best, rps=score, n=int(mask.sum()),
                       seasons=[2014, 2015, 2016]), f, indent=2)
    print(best)


if __name__ == "__main__":
    main()
