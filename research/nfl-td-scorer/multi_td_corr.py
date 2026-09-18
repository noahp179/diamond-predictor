"""
Is multi-touchdown concentration WHY two same-team legs are penalised?

The parlay board multiplies a same-team pair by 0.826 and an opposed pair by
0.883, both measured against a 1.015 different-games control. Those numbers
were read off the data, so they are already correct — but "correct and
unexplained" is a worse place to be than "correct and understood", because
nothing tells you when they will stop being correct.

The hypothesis: a team scores about 2.6 touchdowns in a game it scores in, and
the top man takes more of them as the total grows. A player who scores twice
has used up a share of a small pool, so his teammate's chance falls. If that is
the mechanism, then the same-team penalty should be concentrated in exactly the
games where someone doubled up, and near absent where nobody did.

THE TEST THAT DOES NOT WORK
---------------------------
The obvious split — same-team pairs where "someone doubled up" against pairs
where nobody did — is confounded, and badly. Conditioning on a doubling player
guarantees that one of the two scored, so the co-scoring rate is inflated by
construction: that bucket comes out at 1.896x independence, which would say
doubling up HELPS a teammate. It does not; the number is selection, not effect.

THE TEST THAT DOES
------------------
Take ORDERED teammate pairs and condition only on the FIRST player's count,
then ask about the second. P(B scores | A scored once) against
P(B scores | A scored twice or more) never touches B's outcome on the
conditioning side, so the comparison is clean. If concentration crowds
teammates out, the second number is the lower one.
"""
import os, json, itertools
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import bakeoff_nfl as B
from export_ranker import fit_bundle, predict

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOR = 0.30


def main():
    df = B.load()
    bundle = fit_bundle(df, B.TRAIN)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    d = te[["game_id", "date", "team", "player_id", "scored", "td_count"]].copy()
    d["p"] = predict(bundle, te[B.FEATURES].values)

    print(f"{len(d):,} candidate rows across {d.date.nunique()} slates\n")

    # --- the clean conditional: split on A's count, measure B's outcome
    rows = []
    for (gid, team), grp in d.groupby(["game_id", "team"]):
        g = list(grp.itertuples())
        if len(g) < 2:
            continue
        for a, b in itertools.permutations(g, 2):  # ordered: A conditions, B is measured
            rows.append({"a_td": a.td_count, "b_scored": int(b.scored), "b_p": b.p})
    r = pd.DataFrame(rows)

    print("--- P(teammate B scores), conditioned only on A's touchdown count ---")
    print(f"{'A scored':>10} {'pairs':>8} {'B scored':>9} {'B expected':>11} {'ratio':>7}")
    out = {}
    for label, mask in [
        ("0", r.a_td == 0),
        ("exactly 1", r.a_td == 1),
        ("2 or more", r.a_td >= 2),
    ]:
        sub = r[mask]
        if len(sub) < 50:
            continue
        act = sub.b_scored.mean()
        exp = sub.b_p.mean()
        out[label] = {"pairs": int(len(sub)), "actual": float(act),
                      "expected": float(exp), "ratio": float(act / exp)}
        print(f"{label:>10} {len(sub):>8,} {act*100:>8.1f}% {exp*100:>10.1f}% "
              f"{act/exp:>7.3f}")
    print("  'B expected' is the mean probability the board gave B, so the ratio")
    print("  is how B did against what the model already said about him.")

    print("\nThis conditions only on A, so it is a real effect rather than")
    print("selection — and it is actionable in principle, because A's count")
    print("is not known before kickoff but his SCORING RATE is.")

    # The other half of the mechanism: how concentrated is a team's scoring?
    print("\n--- how much of a team's scoring one man takes ---")
    t = d.groupby(["game_id", "team"]).agg(team_td=("td_count", "sum"),
                                           top=("td_count", "max")).reset_index()
    t = t[t.team_td > 0]
    print(f"{'team TDs':>9} {'games':>7} {'top man took':>13} {'share':>7}")
    for k in range(1, 6):
        s = t[t.team_td == k]
        if len(s) < 15:
            continue
        print(f"{k:>9} {len(s):>7,} {s.top.mean():>13.2f} {s.top.mean()/k*100:>6.0f}%")

    json.dump({"conditional": out},
              open(os.path.join(HERE, "multi_td_corr.json"), "w"), indent=1)
    print("\nwrote multi_td_corr.json")


if __name__ == "__main__":
    main()
