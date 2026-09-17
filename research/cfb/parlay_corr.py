"""
Why one leg per team, and one per game.

The sweep in parlay.py says a slip capped at one leg per team beats the
independence product, while one that stacks two from the same team falls short
of it. This measures the mechanism directly rather than inferring it from
twenty-odd slips.

For every pair of candidates the board would plausibly pick on the same slate,
compare how often BOTH scored against the product of their two probabilities:

  same team           two backs sharing one goal line. Expect a deficit.
  same game, opposed  a shootout lifts both, a slog sinks both. Expect a surplus.
  different games      the independence assumption. Expect no gap at all — and
                      this is the control that makes the other two believable.
"""
import os, json, itertools
import numpy as np
import pandas as pd

import parlay as P

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOR = 0.40  # the range the slips actually draw from


def main():
    te, lr, sc = P.scored_slates()
    cand = te[te.p >= FLOOR]
    print(f"{len(cand):,} candidates at p>={FLOOR} across {cand.date.nunique()} slates\n")

    buckets = {k: {"n": 0, "both": 0, "product": 0.0} for k in ("same_team", "same_game", "diff")}

    for date, slate in cand.groupby("date"):
        # Keep each player once, best first, and look at the top of the board —
        # a pair neither leg of which would ever be picked tells us nothing.
        s = slate.sort_values("p", ascending=False).drop_duplicates("player_id").head(40)
        rows = list(s.itertuples())
        for a, b in itertools.combinations(rows, 2):
            if a.team == b.team:
                k = "same_team"
            elif a.game_id == b.game_id:
                k = "same_game"
            else:
                k = "diff"
            bk = buckets[k]
            bk["n"] += 1
            bk["both"] += int(a.scored) * int(b.scored)
            bk["product"] += a.p * b.p

    print(f"{'pair type':>22} {'pairs':>9} {'both scored':>12} {'product':>9} {'ratio':>7}")
    out = {}
    for k, label in (
        ("same_team", "same team"),
        ("same_game", "same game, opposed"),
        ("diff", "different games"),
    ):
        b = buckets[k]
        if b["n"] == 0:
            continue
        real = b["both"] / b["n"]
        pred = b["product"] / b["n"]
        out[k] = {"pairs": b["n"], "realised": real, "product": pred, "ratio": real / pred}
        print(
            f"{label:>22} {b['n']:>9,} {real*100:>11.2f}% {pred*100:>8.2f}% "
            f"{real/pred:>7.3f}"
        )

    print(
        "\nreading: ratio below 1 means the pair hits together LESS often than\n"
        "independence implies, so stacking them into one slip overstates it."
    )
    json.dump(out, open(os.path.join(HERE, "parlay_corr.json"), "w"), indent=1)
    print("wrote parlay_corr.json")


if __name__ == "__main__":
    main()
