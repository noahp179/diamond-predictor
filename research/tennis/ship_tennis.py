"""
Freeze the match-winner model the site runs, per tour.

WHAT SHIPS
----------
A logistic regression over the antisymmetric feature block, MINUS the
head-to-head and common-opponent features.

Two choices there, both made from evidence rather than taste:

1. A LOGISTIC, not the tree ensembles that topped the bake-off.
   Random forest / extra trees / kNN won on log loss, but each needs a fitted
   sklearn object per tour at request time. A logistic ships as coefficients
   plus a standardiser — pure arithmetic the site can evaluate exactly, the
   same way the MLB and soccer prop models do. Dropping head-to-head (below)
   more than pays for the family downgrade, so the shipped model lands near the
   top of a table it did not win:

       ATP   0.6351   rank  4/33   (+0.0026 behind the best)
       WTA   0.6249   rank  3/33   (+0.0009 behind the best)

2. NO HEAD-TO-HEAD. This is the surprising one. The pre-registered ablation in
   ablate_tennis.py found that removing the matchup group — head-to-head record
   and common opponents — makes the model BETTER on both tours, on every metric:

       ATP   log loss 0.6390 -> 0.6349, accuracy 63.6% -> 63.7%, AUC +0.0046
       WTA   log loss 0.6271 -> 0.6248, accuracy 64.6% -> 65.0%, AUC +0.0026

   (Those are the ablation's expanding-window figures; the shipped model
   measured the same way lands at ATP 0.6351 / WTA 0.6249.)

   Head-to-head is the most quoted number in tennis punditry and it is actively
   harmful here. The reason is not mysterious: most pairs have met once or twice,
   so the "record" is a coin flip dressed up as evidence, and it is already
   priced into both players' ratings. It is dropped.

The surface table survives, but not in the form it was built for. Surface-specific
Elo is WORSE than global Elo on both tours (ATP 0.6525 vs 0.6417; WTA 0.6573 vs
0.6396) — splitting ratings three ways thins each player's history faster than
specialisation pays for it. As a FEATURE alongside global ratings it does earn
its place (+0.0017 ATP, +0.0007 WTA), so it stays in that role only.

Outputs results/<tour>_match_model.json, consumed by src/lib/tennis.server.ts.

Usage: python3 ship_tennis.py --tour atp   (or --all)
"""

import argparse
import json
import os
import warnings

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from ablate_tennis import ALL_COLS, GROUPS
from bakeoff_tennis import (ELO_INIT, SURFACES, accuracy, auc, brier, ece, logloss,
                            orient, walk)
from tours import ROLLING_TEST, TOURS, get as get_tour

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

# Everything except the matchup group — see the module docstring.
SHIP_FEATURES = [c for c in ALL_COLS if c not in GROUPS["matchup"]]


def platt(p, y, it=60):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([x, np.ones_like(x)])
    b = np.zeros(2)
    for _ in range(it):
        q = 1 / (1 + np.exp(-(X @ b)))
        W = np.clip(q * (1 - q), 1e-9, None)
        b -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(2), X.T @ (q - y))
    return b


def apply_platt(p, b):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(b[0] * x + b[1])))


def ship(slug):
    tour = get_tour(slug)
    raw = pd.read_csv(os.path.join(HERE, "data", slug, "matches.csv")).sort_values(
        ["date", "matchId"])
    df = orient(raw).reset_index(drop=True)
    sig, feats, y = walk(df)
    idx = [ALL_COLS.index(c) for c in SHIP_FEATURES]
    X = feats[:, idx]

    # TWO measurements, because they answer different questions and the gap
    # between them is itself a finding.
    #
    #   walk-forward  each test season predicted by a model trained only on the
    #                 seasons before it, refitting as the years pass. This is the
    #                 honest out-of-sample estimate AND what maintaining the model
    #                 properly looks like.
    #   frozen        fitted once before the first test season and never refitted,
    #                 then asked to predict three further years. The pessimistic
    #                 bound: what happens if nobody ever retrains it.
    #
    # The shipped coefficients are fitted on EVERY season, because live matches
    # are in the future and withholding recent data from them would help nobody.
    # The walk-forward figure is the performance claim.
    def run(fit_mask, pred_mask):
        sc_ = StandardScaler().fit(X[fit_mask])
        lr_ = LogisticRegression(max_iter=4000).fit(sc_.transform(X[fit_mask]), y[fit_mask])
        b_ = platt(lr_.predict_proba(sc_.transform(X[fit_mask]))[:, 1], y[fit_mask])
        return apply_platt(lr_.predict_proba(sc_.transform(X[pred_mask]))[:, 1], b_)

    te = df.season.isin(ROLLING_TEST).values
    wf_p, wf_y = [], []
    for ts in ROLLING_TEST:
        tr_s = (df.season < ts).values
        te_s = (df.season == ts).values
        if te_s.sum() == 0 or tr_s.sum() < 500:
            continue
        wf_p.append(run(tr_s, te_s))
        wf_y.append(y[te_s])
    wp, wy = np.concatenate(wf_p), np.concatenate(wf_y)
    metrics = dict(logloss=logloss(wy, wp), brier=brier(wy, wp), acc=accuracy(wy, wp),
                   auc=auc(wy, wp), ece=ece(wy, wp), n=int(len(wy)))

    frozen_mask = (df.season < ROLLING_TEST[0]).values
    fp = run(frozen_mask, te)
    frozen = dict(logloss=logloss(y[te], fp), acc=accuracy(y[te], fp), auc=auc(y[te], fp))

    # Shipped artifact: everything we know, as of now.
    sc = StandardScaler().fit(X)
    lr = LogisticRegression(max_iter=4000).fit(sc.transform(X), y)
    b = platt(lr.predict_proba(sc.transform(X))[:, 1], y)

    rank = of = gap = None
    bo = os.path.join(RESULTS, f"{slug}_bakeoff.csv")
    if os.path.exists(bo):
        B = pd.read_csv(bo).sort_values("logloss").reset_index(drop=True)
        of = int(len(B))
        better = int((B.logloss < metrics["logloss"]).sum())
        rank = better + 1
        gap = float(metrics["logloss"] - B.logloss.iloc[0])

    # Final ratings, so the site starts warm instead of replaying from 1500.
    model = dict(
        tour=slug, name=tour.name, algorithm="logistic_no_h2h",
        features=SHIP_FEATURES,
        mean=[float(v) for v in sc.mean_],
        std=[float(v) for v in sc.scale_],
        coef=[float(v) for v in lr.coef_[0]],
        intercept=float(lr.intercept_[0]),
        plattA=float(b[0]), plattB=float(b[1]),
        elo=dict(init=ELO_INIT, k=24.0, kFast=40.0, kSlow=12.0, surfaces=list(SURFACES)),
        backtest=dict(**metrics, seasons=ROLLING_TEST,
                      trainedThrough=int(ROLLING_TEST[0] - 1),
                      bakeoffRank=rank, bakeoffOf=of, loglossBehindBest=gap,
                      droppedFeatures=GROUPS["matchup"],
                      frozenLogloss=frozen["logloss"], frozenAcc=frozen["acc"],
                      refitGain=frozen["logloss"] - metrics["logloss"]),
        priors=dict(matches=int(len(df)), players=int(
            len(set(df.player_a) | set(df.player_b))),
            surfaces={k: float(v) for k, v in
                      df.surface.value_counts(normalize=True).items()}),
    )
    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(RESULTS, f"{slug}_match_model.json"), "w") as fh:
        json.dump(model, fh, indent=1)
    return model


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tour", choices=[t.slug for t in TOURS])
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    slugs = [t.slug for t in TOURS] if args.all else [args.tour or "atp"]

    rows = []
    for s in slugs:
        m = ship(s)
        rows.append(m)
        print(f"{m['name']:6s} shipped -> results/{s}_match_model.json", flush=True)

    print("\n" + "=" * 92)
    print(f"SHIPPED MATCH MODEL (logistic, no head-to-head) — pooled "
          f"{ROLLING_TEST[0]}-{ROLLING_TEST[-1]}")
    print("=" * 92)
    print(f"{'tour':6} {'matches':>8} {'logloss':>9} {'brier':>8} {'acc':>7} {'AUC':>7} "
          f"{'ECE':>7}  bake-off rank")
    for m in rows:
        b = m["backtest"]
        rk = (f"{b['bakeoffRank']}/{b['bakeoffOf']} (+{b['loglossBehindBest']:.4f})"
              if b["bakeoffRank"] else "—")
        print(f"{m['name']:6} {b['n']:>8,} {b['logloss']:>9.4f} {b['brier']:>8.4f} "
              f"{b['acc']:>7.1%} {b['auc']:>7.4f} {b['ece']:>7.4f}  {rk}")

    print("\n" + "=" * 92)
    print("WHAT NEGLECT COSTS — frozen in 2022 vs refitted each season")
    print("=" * 92)
    for m in rows:
        b = m["backtest"]
        print(f"  {m['name']:5} refitted {b['logloss']:.4f} / {b['acc']:.1%}   "
              f"frozen {b['frozenLogloss']:.4f} / {b['frozenAcc']:.1%}   "
              f"refitting is worth {b['refitGain']:+.4f} log loss")
    print("  Shipped coefficients are fitted on every season, so the live model "
          "starts from the refitted end.")


if __name__ == "__main__":
    main()
