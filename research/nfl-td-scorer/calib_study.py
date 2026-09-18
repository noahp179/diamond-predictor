"""
The lead picks say 55.1% and hit 49.2%. Whose fault is that?

Six points of overstatement on the one number the board puts in large type is
not something to ship past. But "the ranker is over-confident" is only a
finding if the model it replaces is not. Three questions, in order:

  1. does the SHIPPED logistic overstate its leads by the same amount?
     If so this is a property of the feature set, not of the ranker.
  2. is it the LINK or the DRIFT? Fit the calibrator on the test seasons
     themselves — an oracle no deployment can have — and see whether the gap
     closes. If it survives an oracle fit, the logistic link is the wrong shape
     in the tail and a richer calibrator fixes it. If the oracle closes it, the
     2025-26 seasons simply score differently from 2021-24 and no calibrator
     fitted in the past can know that.
  3. can a richer but still MONOTONE calibrator do better? Monotone matters:
     anything that reorders would change the picks, and anything that quantises
     creates ties that `idxmax` breaks by row order — the trap that produced a
     fake +1.4 points on the college board.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import log_loss, brier_score_loss

import bakeoff_nfl as B
from rank_study import fit_ranker, SEEDS

HERE = os.path.dirname(os.path.abspath(__file__))


def lead_gap(te, p):
    d = te[["game_id", "scored"]].copy()
    d["p"] = p
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    return float(lead.p.mean()), float(lead.scored.mean()), len(lead)


def main():
    df = B.load()
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    Xtr, Xte = sc.transform(tr[B.FEATURES].values), sc.transform(te[B.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values
    gtr = tr.game_id.values
    out = {}

    # ------------------------------------------------ 1. the shipped baseline
    lg = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, ytr)
    p_log = lg.predict_proba(Xte)[:, 1]
    s_log, a_log, n = lead_gap(te, p_log)
    print("--- is overstatement specific to the ranker? ---")
    print(f"  shipped logistic  lead picks: stated {s_log*100:.1f}%  "
          f"actual {a_log*100:.1f}%  ({(a_log-s_log)*100:+.1f})")

    # the ranker, seed-averaged, with Platt from a held-back training slice
    cut = int(len(tr) * 0.80)
    fit_m = np.arange(len(tr)) < cut
    hold_m = ~fit_m
    Wc = np.mean([fit_ranker(Xtr[fit_m], ytr[fit_m], gtr[fit_m], s)[0] for s in SEEDS], axis=0)
    W = np.mean([fit_ranker(Xtr, ytr, gtr, s)[0] for s in SEEDS], axis=0)
    s_hold = (Xtr[hold_m] @ Wc).reshape(-1, 1)
    pl = LogisticRegression(max_iter=2000).fit(s_hold, ytr[hold_m])
    a, b = float(pl.coef_[0][0]), float(pl.intercept_[0])
    s_te = Xte @ W
    p_rank = 1 / (1 + np.exp(-(a * s_te + b)))
    s_r, a_r, _ = lead_gap(te, p_rank)
    print(f"  pairwise ranker   lead picks: stated {s_r*100:.1f}%  "
          f"actual {a_r*100:.1f}%  ({(a_r-s_r)*100:+.1f})")
    print(f"  -> the ranker hits {(a_r-a_log)*100:+.1f} points more often and "
          f"overstates by {abs(a_r-s_r)-abs(a_log-s_log):+.1f} points more")
    out["shipped_lead"] = {"stated": s_log, "actual": a_log}
    out["rank_lead_platt"] = {"stated": s_r, "actual": a_r}

    # ------------------------------------------------ 2. link or drift?
    print("\n--- link or drift? fit the calibrator ON the test seasons (oracle) ---")
    pl_o = LogisticRegression(max_iter=2000).fit(s_te.reshape(-1, 1), yte)
    p_or = pl_o.predict_proba(s_te.reshape(-1, 1))[:, 1]
    s_o, a_o, _ = lead_gap(te, p_or)
    print(f"  oracle Platt      lead picks: stated {s_o*100:.1f}%  "
          f"actual {a_o*100:.1f}%  ({(a_o-s_o)*100:+.1f})")
    print("  an oracle fit that STILL overstates means the logistic link is the")
    print("  wrong shape in the tail; a gap that closes means season drift.")
    out["oracle_lead"] = {"stated": s_o, "actual": a_o}

    # ------------------------------------------------ 3. richer monotone links
    print("\n--- richer monotone calibrators, all fitted on the held-back slice ---")
    print(f"{'calibrator':<28} {'ece':>7} {'logloss':>9} {'lead stated':>12} "
          f"{'lead actual':>12} {'gap':>7} {'distinct':>9}")
    cands = {}

    cands["platt (linear in s)"] = (
        np.column_stack([s_hold[:, 0]]), np.column_stack([s_te]))
    # a quadratic in the score has more freedom in the tail; it is only
    # admissible if it stays monotone over the observed score range, which is
    # checked below rather than assumed.
    cands["platt + s^2"] = (
        np.column_stack([s_hold[:, 0], s_hold[:, 0] ** 2]),
        np.column_stack([s_te, s_te ** 2]))
    cands["platt + s^2 + s^3"] = (
        np.column_stack([s_hold[:, 0], s_hold[:, 0] ** 2, s_hold[:, 0] ** 3]),
        np.column_stack([s_te, s_te ** 2, s_te ** 3]))

    rows = []
    for name, (Hf, Tf) in cands.items():
        m = LogisticRegression(max_iter=4000).fit(Hf, ytr[hold_m])
        p = m.predict_proba(Tf)[:, 1]
        # monotonicity over the actual test score range
        grid = np.linspace(s_te.min(), s_te.max(), 2000)
        gfeat = np.column_stack([grid ** (k + 1) for k in range(Hf.shape[1])])
        pg = m.predict_proba(gfeat)[:, 1]
        mono = bool(np.all(np.diff(pg) >= -1e-12))
        st, ac, _ = lead_gap(te, p)
        rows.append({"name": name, "ece": float(B.ece(yte, p)),
                     "logloss": float(log_loss(yte, p)),
                     "stated": st, "actual": ac, "monotone": mono,
                     "distinct": int(len(np.unique(np.round(p, 6)))),
                     "coef": [float(c) for c in m.coef_[0]],
                     "intercept": float(m.intercept_[0])})
        print(f"{name:<28} {B.ece(yte, p):>7.4f} {log_loss(yte, p):>9.4f} "
              f"{st*100:>11.1f}% {ac*100:>11.1f}% {(ac-st)*100:>+6.1f} "
              f"{len(np.unique(np.round(p,6))):>9,}"
              f"{'' if mono else '   NOT MONOTONE'}")
    out["calibrators"] = rows

    # a shrink toward the base rate: the blunt honest fix for tail bravado
    print("\n--- shrink the Platt probability toward the base rate ---")
    base = ytr.mean()
    print(f"{'shrink':>8} {'ece':>8} {'lead stated':>12} {'lead actual':>12} {'gap':>7}")
    shrinks = []
    for lam in [0.0, 0.05, 0.10, 0.15, 0.20]:
        p = (1 - lam) * p_rank + lam * base
        st, ac, _ = lead_gap(te, p)
        shrinks.append({"lam": lam, "ece": float(B.ece(yte, p)),
                        "stated": st, "actual": ac})
        print(f"{lam:>8.2f} {B.ece(yte, p):>8.4f} {st*100:>11.1f}% "
              f"{ac*100:>11.1f}% {(ac-st)*100:>+6.1f}")
    print("  (shrinking is monotone and cannot change a single pick — it only")
    print("   changes what the board CLAIMS, which is the part that was wrong)")
    out["shrink"] = shrinks

    json.dump(out, open(os.path.join(HERE, "calib_study.json"), "w"), indent=1)
    print("\nwrote calib_study.json")


if __name__ == "__main__":
    main()
