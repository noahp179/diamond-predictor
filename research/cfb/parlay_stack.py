"""
What does stacking a game actually cost, and can it be priced instead of banned?

parlay.py settled on one leg per game because that is the construction whose
stated probability is honest. But one leg per game is a restriction on the
product, not a law: a reader who wants three legs out of a 70-point shootout
should be able to have them, so long as the number next to the slip is not a
lie.

So: measure the cost per stacked pair, and then correct for it.

Two measurements, because they answer different halves of the question:

  pair level   for every pair of candidates on a slate, how often did both
               score against the product of their probabilities — split by
               whether they shared a game, and whether they were opposed. Big
               sample, and it gives a per-pair factor.

  slip level   build real slips at each per-game cap and compare realised
               against product. Small sample, but it is the thing being
               corrected, so it is the check on the pair-level factor.
"""
import os, json, itertools, math
import numpy as np
import pandas as pd

import parlay as P

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [5, 10, 15, 20]


def pair_factors(te, floor=0.40, top=40):
    """Per-pair realised/product, by relationship. The control is pairs from
    different games: any global miscalibration shows up there too, so the
    same-game numbers are read RELATIVE to it rather than against 1.0."""
    cand = te[te.p >= floor]
    b = {k: {"n": 0, "both": 0, "prod": 0.0} for k in ("same_team", "opposed", "diff")}
    for _, slate in cand.groupby("date"):
        s = slate.sort_values("p", ascending=False).drop_duplicates("player_id").head(top)
        for x, y in itertools.combinations(list(s.itertuples()), 2):
            k = "same_team" if x.team == y.team else "opposed" if x.game_id == y.game_id else "diff"
            b[k]["n"] += 1
            b[k]["both"] += int(x.scored) * int(y.scored)
            b[k]["prod"] += x.p * y.p
    out = {}
    for k, v in b.items():
        if v["n"] == 0:
            continue
        out[k] = {"pairs": v["n"], "realised": v["both"] / v["n"], "product": v["prod"] / v["n"]}
        out[k]["ratio"] = out[k]["realised"] / out[k]["product"]
    control = out["diff"]["ratio"]
    for k in out:
        out[k]["vs_control"] = out[k]["ratio"] / control
    return out, control


def build_capped(slate, size, floor, cap):
    """Same construction as the app: best first, one per player, `cap` per game,
    relaxing the floor only if the slip cannot otherwise be filled."""
    by = slate.sort_values("p", ascending=False)
    legs, per_game, seen = [], {}, set()
    for min_p in (floor, 0.0):
        for r in by.itertuples():
            if len(legs) == size:
                break
            if r.p < min_p or r.player_id in seen:
                continue
            if per_game.get(r.game_id, 0) >= cap:
                continue
            seen.add(r.player_id)
            per_game[r.game_id] = per_game.get(r.game_id, 0) + 1
            legs.append(r)
        if len(legs) == size:
            break
    return legs if len(legs) == size else None


def stacked_pairs(legs):
    """Same-game pairs in a slip, split by whether they are opposed."""
    same_team = opposed = 0
    for x, y in itertools.combinations(legs, 2):
        if x.game_id != y.game_id:
            continue
        if x.team == y.team:
            same_team += 1
        else:
            opposed += 1
    return same_team, opposed


def main():
    te, lr, sc = P.scored_slates()

    print("=== pair level ===")
    pf, control = pair_factors(te)
    print(f"{'relationship':>18} {'pairs':>8} {'realised':>9} {'product':>9} {'ratio':>7} {'vs control':>11}")
    for k, label in (("same_team", "same team"), ("opposed", "same game, opposed"), ("diff", "different games")):
        if k not in pf:
            continue
        v = pf[k]
        print(
            f"{label:>18} {v['pairs']:>8,} {v['realised']*100:>8.2f}% {v['product']*100:>8.2f}% "
            f"{v['ratio']:>7.3f} {v['vs_control']:>11.3f}"
        )
    print(f"\ncontrol (different games) = {control:.4f}; same-game factors are read against it")

    print("\n=== slip level, by per-game cap ===")
    print(f"{'size':>4} {'cap':>4} {'slips':>7} {'realised':>9} {'product':>9} {'ratio':>7} {'stacked pairs/slip':>19}")
    rows = []
    games_per = te.groupby("date").game_id.nunique()
    for size in SIZES:
        elig = set(games_per[games_per >= 3].index)
        for cap in (1, 2, 3, 99):
            n = h = 0
            prod = 0.0
            st = op = 0
            for d, slate in te.groupby("date"):
                if d not in elig:
                    continue
                legs = build_capped(slate, size, P.FINAL_RULES.get(size, 0.45), cap)
                if legs is None:
                    continue
                n += 1
                h += int(all(int(l.scored) for l in legs))
                prod += float(np.prod([l.p for l in legs]))
                a, b = stacked_pairs(legs)
                st += a
                op += b
            if n < 8:
                continue
            ratio = (h / n) / (prod / n) if prod else float("nan")
            rows.append({"size": size, "cap": cap, "slips": n, "hits": h,
                         "realised": h / n, "product": prod / n, "ratio": ratio,
                         "same_team_pairs": st / n, "opposed_pairs": op / n})
            print(
                f"{size:>4} {cap:>4} {n:>7} {h/n*100:>8.2f}% {prod/n*100:>8.3f}% {ratio:>7.2f} "
                f"{st/n:>8.1f} team {op/n:>5.1f} opp"
            )

    # ---- the correction, fitted from the pair factors
    print("\n=== the correction ===")
    f_team = pf["same_team"]["vs_control"]
    f_opp = pf["opposed"]["vs_control"]
    print(f"per same-team pair:        x{f_team:.3f}")
    print(f"per opposed pair:          x{f_opp:.3f}")
    print(
        "\nApplied per stacked pair, so a slip with one opposed pair is worth\n"
        f"{f_opp:.2f} of its product, and three opposed pairs {f_opp**3:.2f}."
    )
    # honesty check: does the pair-level correction predict the slip-level ratio?
    print("\ndoes it reproduce the slip-level ratios?")
    print(f"{'size':>4} {'cap':>4} {'measured':>9} {'predicted':>10}")
    for r in rows:
        pred = (f_team ** r["same_team_pairs"]) * (f_opp ** r["opposed_pairs"])
        print(f"{r['size']:>4} {r['cap']:>4} {r['ratio']:>9.2f} {pred:>10.2f}")
        r["predicted_ratio"] = pred

    json.dump(
        {"pair_factors": pf, "control": control, "slips": rows,
         "correction": {"same_team": f_team, "opposed": f_opp}},
        open(os.path.join(HERE, "parlay_stack.json"), "w"), indent=1,
    )
    print("\nwrote parlay_stack.json")


if __name__ == "__main__":
    main()
