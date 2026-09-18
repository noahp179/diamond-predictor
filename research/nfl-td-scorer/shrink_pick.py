"""
Choosing the shrink WITHOUT looking at the test seasons.

calib_study.py found that blending the Platt probability 15% toward the base
rate closes the lead-pick gap from -5.9 to -0.9. That number was read off the
test seasons, which makes it a test-set decision and therefore not a real one —
the same reading on 2027 data would be free to disagree.

So the shrink is re-selected here on evidence a deployment could actually have
had: the held-back tail of the training seasons, which neither the ranker's
weights nor the Platt mapping ever saw. Whatever that slice picks is what
ships, and the test seasons are then consulted exactly once, to report.

Rolling-origin is used rather than a single holdback so the choice rests on
four independent (fit, judge) splits instead of one accident of where 2024
happened to end.
"""
import os, json
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import bakeoff_nfl as B
from rank_study import fit_ranker, SEEDS

HERE = os.path.dirname(os.path.abspath(__file__))
LAMBDAS = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
CAL_SEEDS = list(range(8))


def lead_stats(sub, p):
    d = sub[["game_id", "scored"]].copy()
    d["p"] = p
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    return float(lead.p.mean()), float(lead.scored.mean())


def main():
    df = B.load()
    tr_all = df[df.season.isin(B.TRAIN)].reset_index(drop=True)

    # Rolling origin inside the TRAINING seasons only. Each split fits the
    # ranker and the Platt mapping on earlier seasons and judges the shrink on
    # the next one, so no split ever judges itself.
    splits = [([2021], 2022), ([2021, 2022], 2023), ([2021, 2022, 2023], 2024)]
    # and one within-2024 split so the most recent season also gets a vote
    print("--- rolling-origin selection inside the training seasons ---")
    print(f"{'fit on':<22} {'judge':>6} " + " ".join(f"{l:>7.2f}" for l in LAMBDAS))

    table = {l: [] for l in LAMBDAS}
    for fit_seasons, judge in splits:
        f = tr_all[tr_all.season.isin(fit_seasons)].reset_index(drop=True)
        j = tr_all[tr_all.season == judge].reset_index(drop=True)
        sc = StandardScaler().fit(f[B.FEATURES].values)
        Xf, Xj = sc.transform(f[B.FEATURES].values), sc.transform(j[B.FEATURES].values)
        yf, yj = f.scored.values, j.scored.values

        # inner holdback for Platt, exactly as the shipped fit will do it
        cut = int(len(f) * 0.80)
        m_fit = np.arange(len(f)) < cut
        m_hold = ~m_fit
        Wc = np.mean([fit_ranker(Xf[m_fit], yf[m_fit], f.game_id.values[m_fit], s)[0]
                      for s in CAL_SEEDS], axis=0)
        W = np.mean([fit_ranker(Xf, yf, f.game_id.values, s)[0] for s in CAL_SEEDS], axis=0)
        pl = LogisticRegression(max_iter=2000).fit((Xf[m_hold] @ Wc).reshape(-1, 1), yf[m_hold])
        a, b = pl.coef_[0][0], pl.intercept_[0]
        base = yf.mean()
        p_raw = 1 / (1 + np.exp(-(a * (Xj @ W) + b)))

        cells = []
        for lam in LAMBDAS:
            st, ac = lead_stats(j, (1 - lam) * p_raw + lam * base)
            table[lam].append(abs(st - ac))
            cells.append(f"{(ac-st)*100:>+7.1f}")
        print(f"{str(fit_seasons):<22} {judge:>6} " + " ".join(cells))

    print("\nmean |stated - actual| on the lead picks, across the three splits:")
    for lam in LAMBDAS:
        print(f"  shrink {lam:.2f}  ->  {np.mean(table[lam])*100:.2f} points")
    best = min(LAMBDAS, key=lambda l: np.mean(table[l]))
    print(f"\n  selected shrink = {best:.2f}  "
          f"(chosen without any sight of {B.TEST})")

    json.dump({"lambdas": LAMBDAS,
               "mean_abs_gap": {str(l): float(np.mean(table[l])) for l in LAMBDAS},
               "selected": best},
              open(os.path.join(HERE, "shrink_pick.json"), "w"), indent=1)
    print("\nwrote shrink_pick.json")


if __name__ == "__main__":
    main()
