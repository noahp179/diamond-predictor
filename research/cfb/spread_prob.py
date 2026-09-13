"""
Turning a college point spread into a win probability.

The Best Odds page prices the market's own view next to the model's. For the
NFL that is easy: ESPN quotes a moneyline on every game and it devigs into a
probability. College does not cooperate — when a team is favoured by 40 the
book simply takes the moneyline down, and ESPN returns "OFF". On the 2026-09-19
slate 16 of 71 games had any line at all, and 14 of those had a usable
moneyline.

The spread, though, is quoted whenever anything is. So the market probability
for college is read off the spread instead, through the standard normal model:

    P(favourite wins) = Phi(|spread| / sigma)

sigma is the spread of actual margins around the expected one, and it is
measurable rather than assumed. This fits it on real results, using the tuned
Elo's expected margin as the stand-in for a closing spread (the same quantity a
spread estimates), and checks the fit is calibrated out of sample.
"""
import json, math
from statistics import NormalDist

import elo_backtest as E

by_season, fbs = E.load()
TRAIN, TEST = [2021, 2022, 2023, 2024], [2025, 2026]
ELO_PER_POINT = 25.0  # rating points per point of spread — the standard scale


def margins(seasons):
    """(expected margin, actual margin) for every game, point-in-time."""
    elo = E.Elo(40, 55, 0.60)
    out = []
    first = min(seasons) - 2
    for s in range(first, max(seasons) + 1):
        if s not in by_season:
            continue
        if s > first:
            elo.carry_season()
        for g in by_season[s]:
            h, a = E.team_key(g["home"], fbs), E.team_key(g["away"], fbs)
            hs, as_ = g["home"]["score"], g["away"]["score"]
            if hs == as_:
                continue
            if s in seasons:
                d = elo.rating(h) - elo.rating(a) + (0 if g["neutral"] else 55)
                out.append((d / ELO_PER_POINT, hs - as_))
            elo.update(h, a, hs, as_, g["neutral"])
    return out


tr = margins(TRAIN)
sigma = math.sqrt(sum((act - exp) ** 2 for exp, act in tr) / len(tr))
print(f"fitted on {TRAIN}: n={len(tr)}  sigma={sigma:.2f} points")

te = margins(TEST)
nd = NormalDist()
print(f"\nheld out {TEST}: n={len(te)} — is Phi(expected margin / sigma) calibrated?")
print(f"{'predicted band':>16} {'n':>6} {'predicted':>10} {'actual':>8}")
buckets = {}
for exp, act in te:
    p = nd.cdf(exp / sigma)
    pp = p if p >= .5 else 1 - p
    won = (act > 0) == (p >= .5)
    b = min(9, int(pp * 10))
    n, sp, w = buckets.get(b, (0, 0.0, 0))
    buckets[b] = (n + 1, sp + pp, w + (1 if won else 0))
rows = []
for b in sorted(buckets):
    n, sp, w = buckets[b]
    print(f"{b*10:>11}-{b*10+10:<4} {n:>6} {sp/n*100:>9.1f}% {w/n*100:>7.1f}%")
    rows.append({"band": f"{b*10}-{b*10+10}", "n": n, "pred": sp / n, "actual": w / n})
ll = -sum(math.log(max(1e-12, nd.cdf(e / sigma) if a > 0 else 1 - nd.cdf(e / sigma)))
          for e, a in te) / len(te)
print(f"\nlog loss {ll:.4f}   (a few reference spreads below)")
for s in (3, 7, 10, 14, 21, 28, 35):
    print(f"  favourite by {s:>2}: {nd.cdf(s/sigma)*100:.1f}%")
json.dump({"sigma": sigma, "elo_per_point": ELO_PER_POINT, "train": TRAIN, "test": TEST,
           "n_train": len(tr), "n_test": len(te), "logloss": ll, "calibration": rows},
          open("spread_prob.json", "w"), indent=1)
print("\nwrote spread_prob.json")
