"""
Freeze the match-outcome model the site actually runs, per league.

WHY THIS IS NOT "TAKE THE BAKE-OFF WINNER PER LEAGUE"
-----------------------------------------------------
The bake-off ranks ~40 algorithms on held-out seasons. Picking each league's
top row would be selection on the test set: with forty candidates and ~1,100
test matches, the winner's margin is comfortably inside the noise, and the
"best" family differs between leagues for no reason a model can act on.

So the shipped family is pre-specified ONCE, for every league:

    elo_gd — Elo with a goal-difference K multiplier, mapped to H/D/A by a
             multinomial logistic on the single rating-gap signal.

It was chosen on three grounds that are not test-set rank:
  1. It is self-contained arithmetic over results only. No shots feed, no
     sklearn at runtime, no third-party model — the site can replay it from
     ESPN's scoreboard alone, which is the same thing espn.server.ts already
     does for NBA and NFL.
  2. It was already the strongest of that self-contained class in the earlier
     Premier League work, ahead of every goal-process model (Poisson,
     Dixon-Coles, bivariate Poisson, Skellam) and every other rating system
     (Glicko, pi-rating, Massey, Colley, Davidson, Kalman).
  3. The families above it in the table are either tree ensembles, which need
     a fitted sklearn object per league and overfit a 380-match season, or
     shot-process models, which need a per-match shots feed the live site does
     not have.

Its rank in each league's own bake-off is reported below, honestly, including
where it is beaten — the point is that the choice was made before looking.

The Elo constants (K=20, HFA=+60, carry=0.80, exponent 0.6) are likewise frozen
from the earlier work and NOT re-tuned per league. Only the calibration — the
map from rating gap to three probabilities — is fitted per league, on training
seasons only, because that is where the leagues genuinely differ: draw rates
run from 23.9% (Premier League) to 27.4% (Serie A), and a shared calibration
would be mis-fitted at both ends.

Outputs results/<league>_match_model.json, consumed by src/lib/soccer.server.ts.

Usage: python3 ship_soccer.py --league epl     (or --all)
"""

import argparse
import json
import math
import os
import warnings
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from leagues import LEAGUES, ROLLING_TEST, get as get_league

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
CLASSES = ["H", "D", "A"]

# Frozen Elo constants — identical for every league, see the module docstring.
ELO_INIT = 1500.0
ELO_K = 20.0
ELO_HFA = 60.0          # rating points added to the home side
ELO_GD_EXP = 0.6        # K multiplier is (|goal difference| + 1) ** this
SEASON_CARRY = 0.80     # ratings pulled back toward the mean between seasons


def rps(y, P):
    """Ranked probability score over the ordered outcome H > D > A."""
    idx = {c: i for i, c in enumerate(CLASSES)}
    Y = np.zeros_like(P)
    for i, c in enumerate(y):
        Y[i, idx[c]] = 1.0
    cp, cy = np.cumsum(P, 1)[:, :-1], np.cumsum(Y, 1)[:, :-1]
    return float(np.mean(np.sum((cp - cy) ** 2, 1)))


def mlogloss(y, P):
    idx = {c: i for i, c in enumerate(CLASSES)}
    p = np.clip([P[i, idx[c]] for i, c in enumerate(y)], 1e-12, 1)
    return float(-np.mean(np.log(p)))


def brier(y, P):
    idx = {c: i for i, c in enumerate(CLASSES)}
    Y = np.zeros_like(P)
    for i, c in enumerate(y):
        Y[i, idx[c]] = 1.0
    return float(np.mean(np.sum((P - Y) ** 2, 1)))


def accuracy(y, P):
    pred = [CLASSES[i] for i in np.argmax(P, 1)]
    return float(np.mean([a == b for a, b in zip(pred, y)]))


def walk(df):
    """Chronological replay. The signal for a match uses only earlier matches."""
    elo = defaultdict(lambda: ELO_INIT)
    season = None
    sig = np.zeros(len(df))

    for i, m in enumerate(df.itertuples()):
        if season is not None and m.season != season:
            for t in list(elo):
                elo[t] = ELO_INIT + SEASON_CARRY * (elo[t] - ELO_INIT)
        season = m.season

        h, a = m.home_id, m.away_id
        sig[i] = (elo[h] + ELO_HFA) - elo[a]          # recorded BEFORE the update

        gd = m.home_goals - m.away_goals
        res = 1.0 if gd > 0 else (0.5 if gd == 0 else 0.0)
        e = 1 / (1 + 10 ** (-((elo[h] + ELO_HFA) - elo[a]) / 400))
        d = ELO_K * ((abs(gd) + 1) ** ELO_GD_EXP) * (res - e)
        elo[h] += d
        elo[a] -= d

    return sig, dict(elo)


def fit_and_score(df, sig):
    """Calibrate on pre-test seasons, score the pooled held-out seasons."""
    train = df.season < ROLLING_TEST[0]
    test = df.season.isin(ROLLING_TEST)
    lr = LogisticRegression(max_iter=2000).fit(sig[train.values].reshape(-1, 1),
                                               df.result[train].values)
    order = [list(lr.classes_).index(c) for c in CLASSES]
    P = lr.predict_proba(sig[test.values].reshape(-1, 1))[:, order]
    y = df.result[test].values
    return lr, order, P, y


def ship(slug):
    league = get_league(slug)
    data = os.path.join(HERE, "data", league.slug)
    df = (pd.read_csv(os.path.join(data, "matches.csv"))
          .sort_values(["date", "matchId"]).reset_index(drop=True))

    sig, final_elo = walk(df)
    lr, order, P, y = fit_and_score(df, sig)

    metrics = dict(rps=rps(y, P), logloss=mlogloss(y, P),
                   brier=brier(y, P), acc=accuracy(y, P), n=int(len(y)))

    # Where this pre-specified family landed in the league's own bake-off.
    rank, of, gap = None, None, None
    bo = os.path.join(RESULTS, f"{league.slug}_bakeoff.csv")
    if os.path.exists(bo):
        B = pd.read_csv(bo).sort_values("rps").reset_index(drop=True)
        hit = B.index[B.model == "elo_gd"]
        if len(hit):
            rank, of = int(hit[0]) + 1, int(len(B))
            gap = float(B.rps.iloc[hit[0]] - B.rps.iloc[0])

    model = dict(
        league=league.slug, name=league.name, country=league.country,
        espn=league.espn,
        algorithm="elo_gd",
        elo=dict(init=ELO_INIT, k=ELO_K, hfa=ELO_HFA,
                 gdExp=ELO_GD_EXP, carry=SEASON_CARRY),
        # softmax(coef * gap + intercept) over [H, D, A]
        calibration=dict(coef=[float(lr.coef_[i][0]) for i in order],
                         intercept=[float(lr.intercept_[i]) for i in order]),
        backtest=dict(**metrics, seasons=ROLLING_TEST,
                      trainedThrough=int(ROLLING_TEST[0] - 1),
                      bakeoffRank=rank, bakeoffOf=of, rpsBehindBest=gap),
        priors=dict(home=float((df.result == "H").mean()),
                    draw=float((df.result == "D").mean()),
                    away=float((df.result == "A").mean()),
                    goals=float((df.home_goals + df.away_goals).mean())),
    )
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, f"{league.slug}_match_model.json"), "w") as fh:
        json.dump(model, fh, indent=1)
    return model


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--league", choices=[lg.slug for lg in LEAGUES])
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    slugs = [lg.slug for lg in LEAGUES] if args.all else [args.league or "epl"]

    rows = []
    for slug in slugs:
        m = ship(slug)
        rows.append(m)
        print(f"{m['name']:16s} shipped -> results/{slug}_match_model.json")

    print("\n" + "=" * 96)
    print("SHIPPED MATCH MODEL (elo_gd, pre-specified for every league) — pooled "
          f"{ROLLING_TEST[0]}-{ROLLING_TEST[-1] + 1}")
    print("=" * 96)
    print(f"{'league':16} {'matches':>8} {'RPS':>8} {'logloss':>9} {'acc':>7} {'brier':>8} "
          f"{'draw%':>7}  bake-off rank")
    for m in rows:
        b, p = m["backtest"], m["priors"]
        rk = (f"{b['bakeoffRank']}/{b['bakeoffOf']} (+{b['rpsBehindBest']:.4f} RPS)"
              if b["bakeoffRank"] else "—")
        print(f"{m['name']:16} {b['n']:>8,} {b['rps']:>8.4f} {b['logloss']:>9.4f} "
              f"{b['acc']:>7.1%} {b['brier']:>8.4f} {p['draw']:>7.1%}  {rk}")


if __name__ == "__main__":
    main()
