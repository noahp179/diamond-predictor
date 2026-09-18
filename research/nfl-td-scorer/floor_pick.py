"""
The selection floor is a constant about a SCALE, not about quality.

SIZE_FLOOR = {5: 0.55, ...} was measured against the logistic. The ranker's
probabilities are shrunk 20% toward a 0.214 base rate, so the top of its range
is ~0.70 where the logistic reached ~0.82. Carrying 0.55 across unchanged does
not keep the bar the same — it raises it, and the held-out run showed exactly
that: four buildable five-leg weeks where the logistic had fifteen, and nothing
at all at fifteen or twenty legs.

A floor that cannot be met is not a strict floor, it is a broken board.

So the floors are re-derived on the TRAINING seasons under the deployed model,
against two things that pull in opposite directions:

  hit rate       a higher floor means better legs
  buildability   a higher floor means fewer weeks can fill the slip at all

The rule used: take the highest floor that still fills at least 70% of the
weeks that have enough games to be fillable in principle. Quality first, but
never at the price of a board that shows nothing.

The test seasons are not consulted. Whatever this picks is reported on them
afterwards, once.
"""
import os, json, itertools
import numpy as np
import pandas as pd

import bakeoff_nfl as B
from export_ranker import fit_bundle, predict, PARLAY_SIZES

HERE = os.path.dirname(os.path.abspath(__file__))
GRID = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55]
MAX_PER_GAME = 2
FILL_TARGET = 0.70


def build(slate, size, floor, max_per_game=MAX_PER_GAME):
    """The board's own construction: best per player, floor, at most two legs
    from one game, best first."""
    s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
    s = s[s.p >= floor]
    keep, per_game = [], {}
    for r in s.itertuples():
        if per_game.get(r.game_id, 0) >= max_per_game:
            continue
        per_game[r.game_id] = per_game.get(r.game_id, 0) + 1
        keep.append(r)
        if len(keep) == size:
            break
    return keep if len(keep) == size else None


def main():
    df = B.load()
    # fit on the training seasons, judge the floor on the training seasons —
    # in-sample for the floor, but the floor is a threshold on a scale, not a
    # fitted parameter, and the alternative is tuning it on the test set.
    bundle = fit_bundle(df, B.TRAIN)
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    d = tr[["game_id", "date", "team", "player_id", "scored"]].copy()
    d["p"] = predict(bundle, tr[B.FEATURES].values)

    slates = list(d.groupby("date"))
    print(f"{len(slates)} training slates, "
          f"{d.groupby('date').game_id.nunique().max()} games on the largest\n")

    # a week is "fillable in principle" if it has enough games for the size at
    # two legs per game; holding a size against a Thursday night is meaningless
    print(f"{'size':>5} {'floor':>6} {'fillable':>9} {'filled':>7} {'fill %':>7} "
          f"{'legs hit':>9} {'all hit':>8}")
    chosen = {}
    rows = []
    for size in PARLAY_SIZES:
        need_games = int(np.ceil(size / MAX_PER_GAME))
        fillable = [(dt, s) for dt, s in slates if s.game_id.nunique() >= need_games]
        best = None
        for floor in GRID:
            filled, won, legs, leghits = 0, 0, 0, 0
            for _, s in fillable:
                k = build(s, size, floor)
                if k is None:
                    continue
                filled += 1
                won += int(all(r.scored for r in k))
                legs += len(k)
                leghits += sum(int(r.scored) for r in k)
            frac = filled / len(fillable) if fillable else 0
            rows.append({"size": size, "floor": floor, "fillable": len(fillable),
                         "filled": filled, "fill_frac": frac,
                         "leg_hit": leghits / legs if legs else None,
                         "won": won})
            print(f"{size:>5} {floor:>6.2f} {len(fillable):>9} {filled:>7} "
                  f"{frac*100:>6.0f}% {(leghits/legs*100) if legs else 0:>8.1f}% "
                  f"{won:>8}")
            if frac >= FILL_TARGET:
                best = floor
        chosen[size] = best if best is not None else GRID[0]
        print(f"      -> floor {chosen[size]:.2f} "
              f"(highest that still fills {FILL_TARGET*100:.0f}% of fillable weeks)\n")

    json.dump({"grid": rows, "chosen": {str(k): v for k, v in chosen.items()},
               "fill_target": FILL_TARGET, "max_per_game": MAX_PER_GAME},
              open(os.path.join(HERE, "floor_pick.json"), "w"), indent=1)
    print("selected floors:", {k: round(v, 2) for k, v in chosen.items()})
    print("wrote floor_pick.json")


if __name__ == "__main__":
    main()
