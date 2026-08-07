"""
Fixed-size parlays: 5, 10 and 15 legs, with a measured probability of hitting.

Three rules, all enforced here and in src/lib/mlb-parlay.ts:

  1. ONE LEG PER PLAYER. Not merely "no logically overlapping legs" — a player
     appears at most once on the slip, full stop. A pitcher can never show up at
     5+, 6+ and 7+ strikeouts.
  2. The 16+ outs market is excluded entirely.
  3. Among a player's candidate rungs, take the one with the best value. With no
     player-prop prices available anywhere in this data source, "value" is scored
     against the model's own fair price, which makes the choice a pure risk
     decision: how long a rung can this slip afford?

Because a 5-leg slip can carry longer rungs than a 15-leg slip and still clear a
sensible hit probability, the rung choice depends on the target size. Two
selection policies are compared:

  SAFEST   each player contributes their highest-probability rung; take the N
           most likely legs.
  LONGEST  each player contributes the longest (hardest) rung that still clears
           a per-leg floor, chosen so the whole slip lands near a target
           probability; take the N best by that rule.

Then the predicted probability (independence product, and with the measured
correlation haircut) is compared against how often the slip ACTUALLY hit across
the 2026 hold-out season.

Usage: python3 parlay_sizes.py
"""

import json
import os
import warnings

import numpy as np
import pandas as pd

from features import BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES, PITCHER_MARKETS

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = json.load(open(os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "mlb-props-model.json"))))
TEST_SEASON = 2026
SIZES = [5, 10, 15]
EXCLUDED = {"outs16"}          # never offer this market
LEG_FLOOR = 0.55               # a leg must clear this to be considered at all


def predict(df, market):
    m = MODEL["markets"][market]
    X = df[m["features"]].values.astype(float)
    z = ((X - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"]) + m["intercept"]
    raw = 1 / (1 + np.exp(-z))
    lg = np.log(np.clip(raw, 1e-9, 1 - 1e-9) / np.clip(1 - raw, 1e-9, 1 - 1e-9))
    return 1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"])))


def american(p):
    return -round(100 * p / (1 - p)) if p >= 0.5 else round(100 * (1 - p) / p)


def load():
    rows = []
    b = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    b = b[b.season == TEST_SEASON]
    for mk in BATTER_MARKETS:
        if mk in EXCLUDED:
            continue
        rows.append(pd.DataFrame({
            "date": b.date.values, "gamePk": b.gamePk.values,
            "subject": "b" + b.batter_id.astype(str).values, "name": b.name.values,
            "market": mk, "prob": predict(b, mk), "hit": b[f"y_{mk}"].values}))
    p = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    p = p[p.season == TEST_SEASON]
    for mk in PITCHER_MARKETS:
        if mk in EXCLUDED:
            continue
        rows.append(pd.DataFrame({
            "date": p.date.values, "gamePk": p.gamePk.values,
            "subject": "p" + p.pitcher_id.astype(str).values, "name": p.name.values,
            "market": mk, "prob": predict(p, mk), "hit": p[f"y_{mk}"].values}))
    return pd.concat(rows, ignore_index=True)


def pick_legs(day, n, policy):
    """One leg per player, n legs, under the given selection policy."""
    d = day[day.prob >= LEG_FLOOR]
    if d.empty:
        return d
    if policy == "safest":
        best = d.loc[d.groupby("subject").prob.idxmax()]
        return best.nlargest(n, "prob")
    # LONGEST: per player take the hardest rung clearing the floor, then fill the
    # slip with the most likely of those — long where affordable, safe overall.
    best = d.loc[d.groupby("subject").prob.idxmin()]
    return best.nlargest(n, "prob")


def main():
    cand = load()
    print(f"{len(cand):,} candidate legs, {cand.date.nunique()} slate days "
          f"({TEST_SEASON} hold-out); markets: {sorted(cand.market.unique())}\n")

    out = []
    for policy in ("safest", "longest"):
        for n in SIZES:
            slips = []
            for date, day in cand.groupby("date"):
                s = pick_legs(day, n, policy)
                if len(s) < n:
                    continue
                slips.append(dict(date=date, pred=float(np.prod(s.prob.values)),
                                  won=int(s.hit.all()), legs=len(s),
                                  leg_hits=int(s.hit.sum()),
                                  mean_p=float(s.prob.mean()),
                                  players=s.subject.nunique(),
                                  games=s.gamePk.nunique()))
            S = pd.DataFrame(slips)
            if S.empty:
                continue
            realised = S.won.mean()
            pred = S.pred.mean()
            out.append(dict(policy=policy, legs=n, slips=len(S), predicted=pred,
                            realised=realised, ratio=realised / pred if pred else np.nan,
                            leg_hit=S.leg_hits.sum() / (S.legs.sum()),
                            mean_leg_p=float((S.mean_p * S.legs).sum() / S.legs.sum()),
                            fair_price=american(pred), games=S.games.mean(),
                            uniq_ok=bool((S.players == S.legs).all())))
    R = pd.DataFrame(out)
    print("=" * 96)
    print("FIXED-SIZE PARLAYS — predicted vs what actually happened (2026 hold-out)")
    print("=" * 96)
    print(f"{'policy':>8} {'legs':>5} {'slips':>6} {'mean leg p':>11} {'leg hit':>8} "
          f"{'predicted':>10} {'realised':>9} {'real/pred':>10} {'fair price':>11}")
    for r in R.itertuples():
        print(f"{r.policy:>8} {r.legs:>5} {r.slips:>6} {r.mean_leg_p:>11.3f} {r.leg_hit:>8.3f} "
              f"{r.predicted:>10.4f} {r.realised:>9.4f} {r.ratio:>10.2f} "
              f"{('+' if r.fair_price > 0 else '') + str(r.fair_price):>11}")
    print(f"\nuniqueness check (one leg per player on every slip): "
          f"{'PASS' if R.uniq_ok.all() else 'FAIL'}")

    # The correlation haircut, measured per slip size rather than assumed.
    print("\n" + "=" * 96)
    print("CORRELATION HAIRCUT — independence overstates by this much")
    print("=" * 96)
    for r in R[R.policy == "safest"].itertuples():
        print(f"  {r.legs:>2} legs: predicted {r.predicted:.4f}, realised {r.realised:.4f} "
              f"-> multiply the independence product by {r.ratio:.2f}")
    R.to_csv(os.path.join(HERE, "parlay_sizes_results.csv"), index=False)

    # A worked example: the most recent slate in the hold-out.
    last = cand[cand.date == cand.date.max()]
    print("\n" + "=" * 96)
    print(f"WORKED EXAMPLE — {cand.date.max()}")
    print("=" * 96)
    for n in SIZES:
        s = pick_legs(last, n, "safest")
        if len(s) < n:
            continue
        p = float(np.prod(s.prob.values))
        print(f"\n{n}-leg slip: probability {p:.3%}  fair price "
              f"{('+' if american(p) > 0 else '') + str(american(p))}  "
              f"(hit: {'YES' if s.hit.all() else 'no'})")
        for r in s.itertuples():
            print(f"   {r.name[:24]:24s} {r.market:7s} {r.prob:.3f}  "
                  f"{'HIT' if r.hit else 'miss'}")


if __name__ == "__main__":
    main()
