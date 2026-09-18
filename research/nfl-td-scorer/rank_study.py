"""
The pairwise ranker, interrogated.

WHY THIS MODEL AND NOT THE HEADLINE WINNER
-------------------------------------------
bakeoff_nfl.py's top line was hist gradient boosting at 49.5%. The seed sweep
in bakeoff_nfl_sig.py showed that number is the MAXIMUM of ten seeds; the mean
is 45.3%, barely over the shipped logistic's 44.9%. Reporting 49.5% would have
been reporting a random_state.

The within-game pairwise ranker was the only one of twenty-four whose
slate-clustered 95% interval excluded zero (+3.7, [+0.9, +6.6]). It also took
the best 5-leg parlay rate. But it has its own RNG — it SAMPLES the scorer /
non-scorer pairs it trains on — so the same suspicion applies and is tested
here first.

WHY IT SHOULD WIN, MECHANICALLY
--------------------------------
Both it and the shipped logistic are linear: a weight vector against the same
eighteen features. The only difference is which direction they fit.

  logistic    maximises the likelihood of `scored` across all 20,379 training
              rows pooled together. It is rewarded for separating a workhorse
              back from a third-string receiver — a comparison the board never
              makes, because those two are never on the same card together.

  ranker      trains on the DIFFERENCE between two players IN THE SAME GAME,
              one who scored and one who did not, with no intercept. Every
              training example is the exact comparison the card makes.

So the ranker should be worse at global ordering and better within a game. That
is precisely what the bakeoff shows — its AUC is the lower of the two (0.6745
vs 0.6875) while its top-1 is the higher. A model giving up the metric nobody
reads to win the one on the screen is the intended trade, not an anomaly.

WHAT IS STILL MISSING
---------------------
A ranker emits an unbounded score, and the board sells confidence per leg. So
the score is turned into a probability with Platt scaling fitted on a held-back
slice of training seasons — monotone, so it cannot reorder the picks, and
continuous, so it cannot collapse distinct scores into ties the way isotonic
did on the college board.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import bakeoff_nfl as B

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDS = list(range(20))


def build_pairs(X, y, gid, seed, cap_pos=4, cap_neg=4):
    """Every training example is one scorer minus one non-scorer from the SAME
    game. Sign is randomised so the fit cannot learn a constant direction, and
    the per-game cap stops a five-touchdown rout from supplying a tenth of the
    training set."""
    rng = np.random.default_rng(seed)
    order = np.argsort(gid, kind="stable")
    Xs, ys, gs = X[order], y[order], gid[order]
    starts = np.searchsorted(gs, np.unique(gs))
    bounds = list(starts) + [len(gs)]
    diffs, labels = [], []
    for a, b in zip(bounds[:-1], bounds[1:]):
        yi = ys[a:b]
        pos = np.flatnonzero(yi == 1) + a
        neg = np.flatnonzero(yi == 0) + a
        if len(pos) == 0 or len(neg) == 0:
            continue
        for i in pos[: min(len(pos), cap_pos)]:
            for j in rng.choice(neg, size=min(len(neg), cap_neg), replace=False):
                d = Xs[i] - Xs[j]
                if rng.random() < 0.5:
                    diffs.append(d); labels.append(1)
                else:
                    diffs.append(-d); labels.append(0)
    return np.asarray(diffs), np.asarray(labels)


def fit_ranker(X, y, gid, seed, C=1.0, cap_pos=4, cap_neg=4):
    D, L = build_pairs(X, y, gid, seed, cap_pos, cap_neg)
    m = LogisticRegression(max_iter=5000, fit_intercept=False, C=C).fit(D, L)
    return m.coef_[0], len(D)


def main():
    df = B.load()
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    Xtr = sc.transform(tr[B.FEATURES].values)
    Xte = sc.transform(te[B.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values
    gtr = tr.game_id.values

    out = {}

    # -------------------------------------------------- 1. seed stability
    print("--- seed stability of the pair sampling (20 seeds) ---")
    vals = []
    for s in SEEDS:
        w, _ = fit_ranker(Xtr, ytr, gtr, s)
        hits, _ = B.per_game_top1(te, Xte @ w)
        vals.append(float(hits.mean()))
    print(f"  top1  mean {np.mean(vals)*100:5.2f}%  min {min(vals)*100:5.1f}%  "
          f"max {max(vals)*100:5.1f}%  sd {np.std(vals)*100:.2f}")
    out["seed_sweep"] = vals

    # a seed-averaged weight vector: the honest thing to ship, since no single
    # seed's sample is privileged
    W = np.mean([fit_ranker(Xtr, ytr, gtr, s)[0] for s in SEEDS], axis=0)
    hits, _ = B.per_game_top1(te, Xte @ W)
    print(f"  seed-averaged weights: top1 {hits.mean()*100:.2f}%")
    out["seed_averaged_top1"] = float(hits.mean())

    # -------------------------------------------------- 2. hyperparameters
    print("\n--- pair cap and regularisation (mean of 5 seeds each) ---")
    print(f"{'cap_pos':>8} {'cap_neg':>8} {'C':>6} {'pairs':>9} {'top1':>8}")
    grid = []
    for cap_pos, cap_neg in [(2, 2), (4, 4), (4, 8), (8, 8), (99, 4), (99, 99)]:
        for C in [0.1, 1.0, 10.0]:
            vs, npairs = [], 0
            for s in range(5):
                w, npairs = fit_ranker(Xtr, ytr, gtr, s, C, cap_pos, cap_neg)
                h, _ = B.per_game_top1(te, Xte @ w)
                vs.append(float(h.mean()))
            grid.append({"cap_pos": cap_pos, "cap_neg": cap_neg, "C": C,
                         "pairs": int(npairs), "top1": float(np.mean(vs))})
            print(f"{cap_pos:>8} {cap_neg:>8} {C:>6} {npairs:>9,} "
                  f"{np.mean(vs)*100:>7.2f}%")
    out["grid"] = grid
    best = max(grid, key=lambda g: g["top1"])
    print(f"\n  best: cap_pos={best['cap_pos']} cap_neg={best['cap_neg']} "
          f"C={best['C']} -> {best['top1']*100:.2f}%")

    # -------------------------------------------------- 3. calibration
    # Platt fitted on a HELD-BACK slice of the training seasons: the ranker
    # never sees those games, so the mapping is not fitted on its own fit.
    print("\n--- calibration: turning the score into a stated probability ---")
    cut = np.quantile(tr.index.values, 0.80)
    fit_m = tr.index.values <= cut
    hold_m = ~fit_m
    Wc = np.mean([fit_ranker(Xtr[fit_m], ytr[fit_m], gtr[fit_m], s)[0]
                  for s in SEEDS], axis=0)
    s_hold = (Xtr[hold_m] @ Wc).reshape(-1, 1)
    platt = LogisticRegression(max_iter=2000).fit(s_hold, ytr[hold_m])
    a, b = float(platt.coef_[0][0]), float(platt.intercept_[0])
    print(f"  platt a={a:.5f} b={b:.5f} (fitted on {hold_m.sum():,} held-back rows)")

    s_te = Xte @ W
    p_te = 1.0 / (1.0 + np.exp(-(a * s_te + b)))
    print(f"  test: auc {roc_auc_score(yte, p_te):.4f}  "
          f"logloss {log_loss(yte, p_te):.4f}  "
          f"brier {brier_score_loss(yte, p_te):.4f}  "
          f"ece {B.ece(yte, p_te):.4f}")
    print(f"  probability range {p_te.min():.3f} .. {p_te.max():.3f}  "
          f"({len(np.unique(np.round(p_te, 6))):,} distinct)")

    # does the stated number happen? the only calibration test that matters
    print("\n  stated vs actual, by decile of stated probability:")
    qs = pd.qcut(p_te, 10, duplicates="drop")
    tab = pd.DataFrame({"p": p_te, "y": yte, "q": qs}).groupby("q", observed=True).agg(
        n=("y", "size"), stated=("p", "mean"), actual=("y", "mean"))
    for _, r in tab.iterrows():
        print(f"    n={int(r.n):>4}  stated {r.stated*100:>5.1f}%  "
              f"actual {r.actual*100:>5.1f}%  ({(r.actual-r.stated)*100:>+5.1f})")

    # and on the picks the board would actually publish
    d = te[["game_id", "scored"]].copy()
    d["p"] = p_te
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    print(f"\n  lead picks only: stated {lead.p.mean()*100:.1f}%  "
          f"actual {lead.scored.mean()*100:.1f}%  (n={len(lead)})")

    out["platt"] = {"a": a, "b": b}
    out["calibrated"] = {
        "auc": float(roc_auc_score(yte, p_te)),
        "logloss": float(log_loss(yte, p_te)),
        "brier": float(brier_score_loss(yte, p_te)),
        "ece": float(B.ece(yte, p_te)),
        "lead_stated": float(lead.p.mean()), "lead_actual": float(lead.scored.mean()),
    }
    json.dump(out, open(os.path.join(HERE, "rank_study.json"), "w"), indent=1)
    print("\nwrote rank_study.json")


if __name__ == "__main__":
    main()
