"""
What the 2+ bases CARD claims, measured on the season the model never saw.

The model file already carries top1 and top3 — the best hitter in a game, and
the mean over the three the card shows. It does not carry the number a reader
who takes the whole card actually experiences: did ANY of the three get two
bases. That is a game-level question and it is much higher than either, so a
live ledger compared against top3 alone would look like it was underperforming
a claim nobody made.

Written for the forward ledger to be measured against. Same held-out split as
final_tb2.py: the model was fitted through 2025, so 2026 is the test season.
"""
import os, json
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "mlb-tb2-model.json"))
SHOWN = 3  # names the card leads with, per game


def score(df, m):
    X = df[m["features"]].values.astype(float)
    z = (X - np.array(m["mean"])) / np.array(m["std"])
    lg = z @ np.array(m["coef"]) + m["intercept"]
    p = 1 / (1 + np.exp(-lg))
    s = np.log(p / (1 - p))
    return 1 / (1 + np.exp(-(m["plattA"] * s + m["plattB"])))


def main():
    m = json.load(open(MODEL))
    import sys
    sys.path.insert(0, HERE)
    from bakeoff_tb2 import load  # noqa: E402

    df = load()
    df = df[df.season == 2026].copy()
    df["p"] = score(df, m)
    df["y"] = df.y_tb2.astype(int)

    df = df.sort_values(["gamePk", "p"], ascending=[True, False])
    df["rank_in_game"] = df.groupby("gamePk").cumcount() + 1
    shown = df[df.rank_in_game <= SHOWN]

    lead = shown[shown.rank_in_game == 1]
    per_game = shown.groupby("gamePk").y.max()

    claim = {
        "leadHit": float(lead.y.mean()),
        "anyHit": float(shown.y.mean()),
        "gameHit": float(per_game.mean()),
        "base": float(df.y.mean()),
        "games": int(df.gamePk.nunique()),
        "picks": int(len(shown)),
        "batterGames": int(len(df)),
        "byRank": {
            str(r): float(shown[shown.rank_in_game == r].y.mean()) for r in range(1, SHOWN + 1)
        },
        "season": 2026,
    }
    print(json.dumps(claim, indent=1))
    json.dump(claim, open(os.path.join(HERE, "board_claim_tb2.json"), "w"), indent=1)
    print("\nwrote board_claim_tb2.json")


if __name__ == "__main__":
    main()
