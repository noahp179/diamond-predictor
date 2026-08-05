"""
Backtest the parlay builder on the held-out 2026 season.

The card in the app takes every prop the model prices at or above a confidence
threshold, collapses overlapping legs onto the hardest one that still clears the
bar (6+ K swallows 5+ K; a home run swallows hits / total bases / RBI / run),
and multiplies the survivors. This measures whether that is honest:

  * leg hit rate      — do legs above the bar actually win at the rate claimed?
  * parlay hit rate   — how often does the whole slip cash?
  * independence gap  — the product of the leg probabilities assumes the legs
                        are independent. They are not: same lineup, same game,
                        same night. This reports predicted vs realised.
  * dedup effect      — same measurement with the overlap rule switched off, so
                        the rule has to justify itself.

Everything runs on the shipped model (src/lib/mlb-props-model.json) applied to
2026 rows it never trained on.

Usage: python3 parlay_backtest.py
"""

import json
import os
from collections import defaultdict

import numpy as np
import pandas as pd

from features import BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES, PITCHER_MARKETS

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = json.load(open(os.path.abspath(
    os.path.join(HERE, "..", "..", "src", "lib", "mlb-props-model.json"))))
TEST_SEASON = 2026
THRESHOLDS = [0.55, 0.60, 0.65, 0.70, 0.75]

# Mirrors IMPLIES in src/lib/mlb-parlay.ts — keep the two in sync.
IMPLIES = {
    "h4": ["h3", "tb4"],
    "h3": ["h2", "tb3"],
    "h2": ["h1", "tb2"],
    "tb5": ["tb4"],
    "tb4": ["tb3"],
    "tb3": ["tb2"],
    "tb2": ["h1"],
    "hr1": ["tb4", "h1", "rbi1", "r1"],
    "k7": ["k6"],
    "k6": ["k5"],
}


def closure(m, seen=None):
    seen = set() if seen is None else seen
    for nxt in IMPLIES.get(m, []):
        if nxt not in seen:
            seen.add(nxt)
            closure(nxt, seen)
    return seen


CLOSURE = {m: closure(m) for m in IMPLIES}


def implies(a, b):
    return a != b and b in CLOSURE.get(a, set())


def predict(df, market, feats):
    """Shipped model probability for every row of `df` on `market`."""
    m = MODEL["markets"][market]
    X = df[m["features"]].values.astype(float)
    z = ((X - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"]) + m["intercept"]
    raw = 1 / (1 + np.exp(-z))
    lg = np.log(np.clip(raw, 1e-9, 1 - 1e-9) / np.clip(1 - raw, 1e-9, 1 - 1e-9))
    return 1 / (1 + np.exp(-(m["plattA"] * lg + m["plattB"])))


def load_candidates():
    """One row per (date, subject, market): predicted probability + outcome."""
    rows = []
    b = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    b = b[b.season == TEST_SEASON]
    for mk in BATTER_MARKETS:
        p = predict(b, mk, BATTER_FEATURES)
        rows.append(pd.DataFrame({
            "date": b.date.values, "gamePk": b.gamePk.values,
            "subject": b.batter_id.values.astype(str), "name": b.name.values,
            "market": mk, "prob": p, "hit": b[f"y_{mk}"].values,
        }))
    p_ = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    p_ = p_[p_.season == TEST_SEASON]
    for mk in PITCHER_MARKETS:
        p = predict(p_, mk, PITCHER_FEATURES)
        rows.append(pd.DataFrame({
            "date": p_.date.values, "gamePk": p_.gamePk.values,
            "subject": "P" + p_.pitcher_id.values.astype(str), "name": p_.name.values,
            "market": mk, "prob": p, "hit": p_[f"y_{mk}"].values,
        }))
    return pd.concat(rows, ignore_index=True)


def build_slip(day, threshold, dedup=True):
    """The app's rule, applied to one day's candidates."""
    q = day[day.prob >= threshold]
    if len(q) == 0:
        return q
    if not dedup:
        return q
    keep = []
    for subj, grp in q.groupby("subject"):
        markets = list(grp.market)
        for r in grp.itertuples():
            # survives unless another qualified leg for this subject guarantees it
            if any(implies(o, r.market) for o in markets):
                continue
            keep.append(r.Index)
    return q.loc[keep]


def summarise(cand, threshold, dedup=True):
    slips = []
    for date, day in cand.groupby("date"):
        s = build_slip(day, threshold, dedup)
        if len(s) == 0:
            continue
        slips.append({
            "date": date, "legs": len(s),
            "pred": float(np.prod(s.prob.values)),
            "won": int(s.hit.all()),
            "leg_hits": int(s.hit.sum()),
            "mean_leg_prob": float(s.prob.mean()),
            "games": s.gamePk.nunique(),
        })
    if not slips:
        return None
    S = pd.DataFrame(slips)
    total_legs = S.legs.sum()
    return {
        "threshold": threshold, "dedup": dedup, "days": len(S),
        "legs_per_day": S.legs.mean(), "total_legs": int(total_legs),
        "leg_hit_rate": S.leg_hits.sum() / total_legs,
        "mean_leg_prob": float((S.mean_leg_prob * S.legs).sum() / total_legs),
        "parlay_pred": S.pred.mean(),
        "parlay_won": S.won.mean(),
        "slips_won": int(S.won.sum()),
        "games_per_slip": S.games.mean(),
    }


def n_leg_analysis(cand, threshold, sizes=(2, 3, 4, 5, 6)):
    """Predicted vs realised for the N most confident legs — the realistic slip.

    Independence says a 3-leg slip at 0.72 each cashes 37% of the time. Legs from
    the same night are correlated, so this measures the real number.
    """
    out = []
    for n in sizes:
        pred, won, cnt = [], 0, 0
        for _, day in cand.groupby("date"):
            s = build_slip(day, threshold).nlargest(n, "prob")
            if len(s) < n:
                continue
            pred.append(float(np.prod(s.prob.values)))
            won += int(s.hit.all())
            cnt += 1
        if cnt >= 20:
            out.append({"legs": n, "slips": cnt, "predicted": float(np.mean(pred)),
                        "realised": won / cnt, "won": won})
    return pd.DataFrame(out)


def main():
    cand = load_candidates()
    print(f"{len(cand):,} candidate legs across {cand.date.nunique()} days "
          f"({TEST_SEASON} hold-out)\n")

    print("=== every leg above the bar (the card's default behaviour) ===")
    print(f"{'thresh':>7} {'days':>5} {'legs/day':>9} {'leg hit':>8} {'mean p':>7} "
          f"{'parlay pred':>12} {'parlay real':>12} {'won':>5}")
    for t in THRESHOLDS:
        r = summarise(cand, t)
        if r:
            print(f"{t:>7.2f} {r['days']:>5} {r['legs_per_day']:>9.1f} "
                  f"{r['leg_hit_rate']:>8.3f} {r['mean_leg_prob']:>7.3f} "
                  f"{r['parlay_pred']:>12.5f} {r['parlay_won']:>12.5f} {r['slips_won']:>5}")

    print("\n=== does the overlap rule matter? (same bar, dedup off) ===")
    print(f"{'thresh':>7} {'dedup':>6} {'legs/day':>9} {'leg hit':>8} {'parlay pred':>12} "
          f"{'parlay real':>12}")
    for t in (0.60, 0.65, 0.70):
        for d in (True, False):
            r = summarise(cand, t, d)
            if r:
                print(f"{t:>7.2f} {str(d):>6} {r['legs_per_day']:>9.1f} "
                      f"{r['leg_hit_rate']:>8.3f} {r['parlay_pred']:>12.6f} "
                      f"{r['parlay_won']:>12.5f}")

    print("\n=== N most confident legs: independence vs reality ===")
    for t in (0.60, 0.65, 0.70):
        d = n_leg_analysis(cand, t)
        if len(d) == 0:
            continue
        print(f"\nthreshold {t:.2f}")
        print(f"{'legs':>5} {'slips':>6} {'predicted':>10} {'realised':>9} {'ratio':>7}")
        for r in d.itertuples():
            print(f"{r.legs:>5} {r.slips:>6} {r.predicted:>10.3f} {r.realised:>9.3f} "
                  f"{r.realised / r.predicted:>7.2f}")

    # Which markets actually make the slip, and how do their legs do?
    print("\n=== leg mix at threshold 0.65 ===")
    legs = pd.concat([build_slip(day, 0.65) for _, day in cand.groupby("date")])
    mix = legs.groupby("market").agg(n=("hit", "size"), hit=("hit", "mean"),
                                     pred=("prob", "mean")).sort_values("n", ascending=False)
    print(mix.round(3).to_string())

    legs.to_csv(os.path.join(HERE, "parlay_legs_65.csv"), index=False)
    print(f"\nsaved -> parlay_legs_65.csv")


if __name__ == "__main__":
    main()
