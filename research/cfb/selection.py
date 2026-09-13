"""
How many touchdown picks does a game deserve — one, or two?

A fixed "top 3 per game" board is easy to build and dishonest: in a game
between two run-heavy teams with one workhorse back each, the third name is
filler, and it goes on the board looking exactly like the first. The board
should say how many picks a game actually supports.

So the count is chosen per game. Pick 1 always shows. Pick 2 shows only when it
clears a bar, and this file is about finding where that bar is. The test a
second pick has to pass: shown together with the first, it should hit about as
often as a lead pick does. A second name that hits 40% of the time next to one
that hits 56% is not a second pick, it is a worse pick.

Everything here is measured on 2025 and 2026 — seasons the model never saw.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]


def fit_and_score():
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    tr = df[df.season.isin(TRAIN)]
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(sc.transform(tr[F.FEATURES].values),
                                                      tr.scored.values)
    te = df[df.season.isin(TEST)].copy()
    te["p"] = lr.predict_proba(sc.transform(te[F.FEATURES].values))[:, 1]
    return te, lr, sc


def ranked(te):
    """Per game: the candidates in model order, with the gap to the next one."""
    out = []
    for gid, g in te.groupby("game_id"):
        g = g.sort_values("p", ascending=False).reset_index(drop=True)
        for i in range(min(4, len(g))):
            r = g.loc[i]
            out.append({
                "game_id": gid, "season": r.season, "rank": i + 1,
                "p": r.p, "scored": int(r.scored),
                "p1": g.loc[0, "p"],
                "p2": g.loc[1, "p"] if len(g) > 1 else np.nan,
                "p3": g.loc[2, "p"] if len(g) > 2 else np.nan,
                "gp": r.gp, "carried": int(r.carried),
                "touches": (r.cpg + r.rpg),
            })
    return pd.DataFrame(out)


def main():
    te, lr, sc = fit_and_score()
    rk = ranked(te)
    print(f"held-out seasons {TEST}: {rk.game_id.nunique()} games\n")

    print("hit rate by model rank within a game:")
    for i in (1, 2, 3, 4):
        s = rk[rk["rank"] == i]
        print(f"  pick {i}: {s.scored.mean()*100:5.1f}%   (n={len(s)})  mean p={s.p.mean()*100:.1f}%")

    # --- where does a second pick stop being worth showing?
    print("\npick 2 hit rate, by that pick's own probability:")
    p2 = rk[rk["rank"] == 2].copy()
    for lo, hi in [(0, .20), (.20, .25), (.25, .30), (.30, .35), (.35, .40), (.40, 1.0)]:
        s = p2[(p2.p >= lo) & (p2.p < hi)]
        if len(s) < 20:
            continue
        print(f"  p in [{lo:.2f},{hi:.2f}): {s.scored.mean()*100:5.1f}%  (n={len(s)}, "
              f"{len(s)/len(p2)*100:.0f}% of games)")

    print("\npick 2 hit rate, by how close it is to pick 1 (p2/p1):")
    p2["ratio"] = p2.p / p2.p1
    for lo, hi in [(0, .70), (.70, .80), (.80, .90), (.90, .95), (.95, 1.01)]:
        s = p2[(p2.ratio >= lo) & (p2.ratio < hi)]
        if len(s) < 20:
            continue
        print(f"  ratio [{lo:.2f},{hi:.2f}): {s.scored.mean()*100:5.1f}%  (n={len(s)}, "
              f"{len(s)/len(p2)*100:.0f}% of games)")

    # --- candidate rules, scored on what the board would actually show
    print("\n--- candidate rules for 'how many picks does this game get?' ---")
    p1 = rk[rk["rank"] == 1].set_index("game_id")
    base_p1 = p1.scored.mean()
    print(f"(lead picks hit {base_p1*100:.1f}% — that is the bar a second pick has to match)\n")
    rules = []
    for thr in [0.22, 0.25, 0.28, 0.30, 0.32, 0.35, 0.38, 0.40, 0.45]:
        s = p2[p2.p >= thr]
        if len(s) < 20:
            continue
        n2 = len(s)
        shown = len(p1) + n2
        hits = p1.scored.sum() + s.scored.sum()
        rules.append({
            "rule": f"second pick when p2 >= {thr:.2f}",
            "kind": "absolute", "threshold": thr,
            "two_pick_games": n2, "two_pick_share": n2 / len(p1),
            "pick2_hit": s.scored.mean(),
            "all_picks_hit": hits / shown,
            "picks_per_game": shown / len(p1),
        })
        print(f"  p2 >= {thr:.2f}: two picks in {n2/len(p1)*100:4.1f}% of games, "
              f"pick-2 hits {s.scored.mean()*100:5.1f}%, all shown picks hit "
              f"{hits/shown*100:5.1f}%, {shown/len(p1):.2f} picks/game")

    print()
    for thr in [0.70, 0.75, 0.80, 0.85, 0.90]:
        s = p2[p2.ratio >= thr]
        if len(s) < 20:
            continue
        n2 = len(s)
        shown = len(p1) + n2
        hits = p1.scored.sum() + s.scored.sum()
        rules.append({
            "rule": f"second pick when p2/p1 >= {thr:.2f}",
            "kind": "ratio", "threshold": thr,
            "two_pick_games": n2, "two_pick_share": n2 / len(p1),
            "pick2_hit": s.scored.mean(),
            "all_picks_hit": hits / shown,
            "picks_per_game": shown / len(p1),
        })
        print(f"  p2/p1 >= {thr:.2f}: two picks in {n2/len(p1)*100:4.1f}% of games, "
              f"pick-2 hits {s.scored.mean()*100:5.1f}%, all shown picks hit "
              f"{hits/shown*100:5.1f}%, {shown/len(p1):.2f} picks/game")

    # what a fixed board would have done, for comparison
    print("\nfor comparison — fixed boards:")
    for k in (1, 2, 3):
        s = rk[rk["rank"] <= k]
        print(f"  always {k} pick(s): all shown picks hit {s.scored.mean()*100:5.1f}%, "
              f"{k:.2f} picks/game")

    json.dump({"test_seasons": TEST,
               "games": int(rk.game_id.nunique()),
               "by_rank": {str(i): {"hit": float(rk[rk['rank'] == i].scored.mean()),
                                    "n": int((rk['rank'] == i).sum())} for i in (1, 2, 3, 4)},
               "rules": rules,
               "fixed": {str(k): float(rk[rk['rank'] <= k].scored.mean()) for k in (1, 2, 3)}},
              open(os.path.join(HERE, "selection_metrics.json"), "w"), indent=1)
    print("\nwrote selection_metrics.json")


if __name__ == "__main__":
    main()
