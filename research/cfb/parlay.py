"""
How often does a touchdown parlay actually hit?

The board prices one pick at a time. A parlay asks a different and much harder
question — every leg, same day — and the answer is not the product of the leg
probabilities unless the legs are independent. Touchdown legs are not:

  same team    two backs share one goal line. If one scores, the other's chance
               of scoring goes DOWN. Negative correlation.
  same game    a 45-point shootout lifts everyone in it; a 10-7 slog sinks
               everyone. Positive correlation.

Those pull in opposite directions and there is no arguing about which wins from
first principles, so this measures it: build the slip every real Saturday of the
held-out seasons, then compare how often it actually hit against what the
independence product said it would.

Everything is scored on 2025 and 2026, seasons the model was never fitted on.
"""
import os, json, itertools
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]
SIZES = [5, 10, 15, 20]


def scored_slates():
    """Every held-out slate, with a model probability on every candidate."""
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(TRAIN)]
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(
        sc.transform(tr[F.FEATURES].values), tr.scored.values
    )
    te = df[df.season.isin(TEST)].copy()
    te["p"] = lr.predict_proba(sc.transform(te[F.FEATURES].values))[:, 1]
    return te, lr, sc


def build(slate, size, floor, max_per_game, max_per_team):
    """One slip, by the construction the app will use.

    Candidates are taken best-first. A player appears once; a game and a team
    contribute at most their cap. Returns None when the slate cannot fill the
    slip, which is itself a result worth counting — a rule that only fills on
    huge Saturdays is not a rule that works.
    """
    cand = slate[slate.p >= floor].sort_values("p", ascending=False)
    legs = []
    per_game, per_team, seen = {}, {}, set()
    for r in cand.itertuples():
        if r.player_id in seen:
            continue
        if per_game.get(r.game_id, 0) >= max_per_game:
            continue
        if per_team.get(r.team, 0) >= max_per_team:
            continue
        seen.add(r.player_id)
        per_game[r.game_id] = per_game.get(r.game_id, 0) + 1
        per_team[r.team] = per_team.get(r.team, 0) + 1
        legs.append(r)
        if len(legs) == size:
            break
    if len(legs) < size:
        return None
    return legs


def evaluate(te, size, floor, max_per_game, max_per_team):
    slips = 0
    attempted = 0
    hits = 0
    predicted = 0.0
    leg_n = 0
    leg_hits = 0
    for _, slate in te.groupby("date"):
        attempted += 1
        legs = build(slate, size, floor, max_per_game, max_per_team)
        if legs is None:
            continue
        slips += 1
        probs = [l.p for l in legs]
        outcomes = [int(l.scored) for l in legs]
        predicted += float(np.prod(probs))
        hits += int(all(outcomes))
        leg_n += len(legs)
        leg_hits += sum(outcomes)
    return {
        "size": size,
        "floor": floor,
        "max_per_game": max_per_game,
        "max_per_team": max_per_team,
        "slates": attempted,
        "filled": slips,
        "fill_rate": slips / attempted if attempted else 0.0,
        "hits": hits,
        "realised": hits / slips if slips else float("nan"),
        "predicted": predicted / slips if slips else float("nan"),
        "leg_hit_rate": leg_hits / leg_n if leg_n else float("nan"),
    }


def main():
    te, lr, sc = scored_slates()
    print(f"held-out slates: {te.date.nunique()} dates, {len(te):,} candidates\n")

    # ---- does the same-game / same-team cap matter?
    print("=== construction sweep ===")
    print(
        f"{'size':>4} {'floor':>6} {'/game':>6} {'/team':>6} {'filled':>12} "
        f"{'realised':>9} {'product':>9} {'ratio':>7} {'leg hit':>8}"
    )
    rows = []
    for size in SIZES:
        for floor in (0.35, 0.45, 0.50, 0.55):
            for mpg, mpt in ((1, 1), (2, 1), (2, 2), (99, 99)):
                r = evaluate(te, size, floor, mpg, mpt)
                if r["filled"] < 8:  # too few slips to say anything
                    continue
                ratio = (
                    r["realised"] / r["predicted"]
                    if r["predicted"] and r["predicted"] > 0
                    else float("nan")
                )
                r["ratio"] = ratio
                rows.append(r)
                print(
                    f"{size:>4} {floor:>6.2f} {mpg:>6} {mpt:>6} "
                    f"{r['filled']:>4}/{r['slates']:<7} "
                    f"{r['realised']*100:>8.1f}% {r['predicted']*100:>8.2f}% "
                    f"{ratio:>7.2f} {r['leg_hit_rate']*100:>7.1f}%"
                )
        print()

    # ---- the headline question: is the product right, high, or low?
    print("=== is the independence product honest? ===")
    print("pooling every construction with 20+ filled slips, by size:")
    for size in SIZES:
        sub = [r for r in rows if r["size"] == size and r["filled"] >= 20]
        if not sub:
            print(f"  {size:>2} legs: too few slips to pool")
            continue
        real = sum(r["hits"] for r in sub) / sum(r["filled"] for r in sub)
        pred = sum(r["predicted"] * r["filled"] for r in sub) / sum(r["filled"] for r in sub)
        print(
            f"  {size:>2} legs: realised {real*100:6.2f}%  product {pred*100:6.2f}%  "
            f"ratio {real/pred if pred else float('nan'):.2f}  "
            f"({sum(r['hits'] for r in sub)} hits in {sum(r['filled'] for r in sub)} slips)"
        )

    json.dump(rows, open(os.path.join(HERE, "parlay_metrics.json"), "w"), indent=1)
    pd.DataFrame(rows).to_csv(os.path.join(HERE, "parlay_results.csv"), index=False)
    print("\nwrote parlay_metrics.json / parlay_results.csv")


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------- the ruling
#
# One leg per game. It wins outright on identical slates (18 hits against 15
# across 220 paired slips) and, more importantly, it is the only construction
# whose stated probability is honest: 1.02x the independence product against
# 0.82x when two legs share a game.
#
# parlay_corr.py says why. Two opposed players in one game score together only
# 0.754x as often as independence implies, against a 0.964x control for players
# in different games — college football is decided by blowouts, and in a blowout
# one side's skill players score and the other's do not. Two players on the SAME
# team come in at 0.954x, statistically indistinguishable from the control, so
# the goal-line-competition effect everyone expects is not the one that matters.
#
# One leg per game removes both, and since a team plays one game a day it caps
# teams at one for free.
#
# The floor only bites at five legs, where being choosier measurably helps
# (21.4% at a 0.35 floor rising to 31.6% at 0.55). By ten legs a full Saturday's
# top twenty picks all clear 0.55 anyway, so the floor stops mattering and the
# slip is simply the best N the board has.

FINAL_RULES = {5: 0.55, 10: 0.45, 15: 0.45, 20: 0.45}


def final():
    """The definitive numbers for the shipped construction."""
    te, lr, sc = scored_slates()
    games_per = te.groupby("date").game_id.nunique()
    out = {}
    print("\n=== shipped construction: one leg per game ===")
    print(f"{'size':>4} {'floor':>6} {'slips':>10} {'product':>9} {'one in':>9} {'observed':>18} {'leg hit':>8}")
    for size, floor in FINAL_RULES.items():
        elig = set(games_per[games_per >= size].index)
        n = h = 0
        pred = 0.0
        ln = lh = 0
        for d, slate in te.groupby("date"):
            if d not in elig:
                continue
            legs = build(slate, size, floor, 1, 99)
            if legs is None:
                continue
            n += 1
            h += int(all(int(l.scored) for l in legs))
            pred += float(np.prod([l.p for l in legs]))
            ln += size
            lh += sum(int(l.scored) for l in legs)
        if n == 0:
            continue
        product = pred / n
        out[str(size)] = {
            "floor": floor,
            "slips": n,
            "eligible_slates": len(elig),
            "product": product,
            "one_in": 1 / product if product else None,
            "hits": h,
            "observed": h / n,
            "expected_hits": product * n,
            "leg_hit_rate": lh / ln,
        }
        print(
            f"{size:>4} {floor:>6.2f} {n:>10} {product*100:>8.3f}% "
            f"{1/product if product else float('nan'):>9.0f} "
            f"{h:>3} in {n:<3} (exp {product*n:>4.2f}) {lh/ln*100:>7.1f}%"
        )
    print(
        "\nReading the zeroes: at ten legs and up the product predicts fewer than\n"
        "one winning slip across the whole held-out period, so observing none is\n"
        "what should happen. It is not evidence the model is wrong, and it is not\n"
        "evidence the slip is viable either — there is simply no sample."
    )
    json.dump(out, open(os.path.join(HERE, "parlay_final.json"), "w"), indent=1)
    print("wrote parlay_final.json")
    return out
