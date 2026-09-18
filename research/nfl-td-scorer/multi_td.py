"""
Does knowing that a player scored TWICE make a better board?

WHAT THE SHIPPED MODEL THROWS AWAY
-----------------------------------
The label is binary: `scored`, meaning one touchdown or more. On this data
16.3% of the scoring rows are multi-touchdown games, and those games carry
29.4% of every touchdown in the sample. So the label is discarding a third of
the scoring signal, and a three-touchdown afternoon counts for exactly as much
as a one-yard plunge.

That is not obviously wrong. The board sells ANYTIME touchdown — the leg on a
slip pays the same for one as for three — so P(>=1) is the quantity the product
needs, and the binary label is the honest target for it. The question is
whether the extra counts help ESTIMATE that quantity, not whether they should
replace it.

The earlier bakeoff already tried two count-aware formulations and neither beat
the logistic on top-1: Poisson on `td_count` scored 44.9% and an ordinal 0/1/2+
scored 44.9%, against the logistic's own 44.9%. But both were POOLED models,
and the model that actually won was the within-game pairwise ranker — which was
never given the counts. That is the gap this closes.

FIVE WAYS TO USE A COUNT
------------------------
  shipped        scorer vs non-scorer, every pair weighted the same
  weighted       weight each pair by the touchdown DIFFERENCE, so 3-vs-0
                 teaches more than 1-vs-0
  within-pos     also pair a two-touchdown game against a one-touchdown game.
                 The shipped model never compares two scorers, so it has no
                 opinion about which of them was the better call
  both           weighted pairs plus the within-scorer pairs
  oversample     draw the positive side of each pair in proportion to its
                 count, so multi-touchdown games appear more often
  pooled-weight  the control that is not a ranker: ordinary logistic with each
                 positive row weighted by its touchdown count

Every variant is judged on per-game top-1 — of a game's candidates, did the
highest-ranked one score — over 20 pair-sampling seeds, because a 0.5-point
seed spread already sank one apparently-winning model in this project.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

import bakeoff_nfl as B

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDS = list(range(20))
CAP_POS, CAP_NEG = 4, 4


def pairs_for(kind, X, y, cnt, gid, seed):
    """Build the training pairs for one variant.

    Returns (differences, labels, weights). The sign of every pair is
    randomised so a fit with no intercept cannot learn a constant direction.
    """
    rng = np.random.default_rng(seed)
    order = np.argsort(gid, kind="stable")
    Xs, ys, cs = X[order], y[order], cnt[order]
    gs = gid[order]
    starts = np.searchsorted(gs, np.unique(gs))
    bounds = list(starts) + [len(gs)]
    D, L, W = [], [], []

    def add(i, j, w):
        d = Xs[i] - Xs[j]
        if rng.random() < 0.5:
            D.append(d); L.append(1); W.append(w)
        else:
            D.append(-d); L.append(0); W.append(w)

    for a, b in zip(bounds[:-1], bounds[1:]):
        yi = ys[a:b]
        ci = cs[a:b]
        pos = np.flatnonzero(yi == 1) + a
        neg = np.flatnonzero(yi == 0) + a
        if len(pos) == 0 or len(neg) == 0:
            continue

        if kind == "oversample":
            # draw the positive side in proportion to its touchdown count, so a
            # two-touchdown game gets two chances to be the exemplar
            p = cs[pos].astype(float)
            p = p / p.sum()
            take = rng.choice(pos, size=min(len(pos), CAP_POS), replace=False, p=p) \
                if len(pos) > CAP_POS else pos
        else:
            take = pos[: min(len(pos), CAP_POS)]

        for i in take:
            for j in rng.choice(neg, size=min(len(neg), CAP_NEG), replace=False):
                w = 1.0
                if kind in ("weighted", "both"):
                    w = float(cs[i] - cs[j])  # cs[j] is 0 here
                add(i, j, w)

        # pairs BETWEEN two scorers, which the shipped model never sees
        if kind in ("within-pos", "both") and len(pos) > 1:
            for k in range(len(pos)):
                for l in range(k + 1, len(pos)):
                    i, j = pos[k], pos[l]
                    if cs[i] == cs[j]:
                        continue  # a tie teaches nothing about order
                    hi, lo = (i, j) if cs[i] > cs[j] else (j, i)
                    w = float(cs[hi] - cs[lo]) if kind == "both" else 1.0
                    add(hi, lo, w)

    D, L, W = np.asarray(D), np.asarray(L), np.asarray(W)
    W = W / W.mean()  # keep the effective sample size fixed so C means the same
    return D, L, W


def fit_variant(kind, X, y, cnt, gid, seed, C=1.0):
    if kind == "pooled-weight":
        w = np.where(y == 1, np.maximum(cnt, 1), 1.0).astype(float)
        w = w / w.mean()
        m = LogisticRegression(max_iter=3000, C=C).fit(X, y, sample_weight=w)
        return m.predict_proba(X_TE)[:, 1]
    D, L, W = pairs_for(kind, X, y, cnt, gid, seed)
    m = LogisticRegression(max_iter=5000, fit_intercept=False, C=C).fit(D, L, sample_weight=W)
    return X_TE @ m.coef_[0]


def main():
    global X_TE
    df = B.load()
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    Xtr = sc.transform(tr[B.FEATURES].values)
    X_TE = sc.transform(te[B.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values
    cnt = tr.td_count.values.astype(float)
    gid = tr.game_id.values

    print(f"train {len(tr):,} rows · test {len(te):,} rows ({te.game_id.nunique()} games)")
    print(f"multi-TD rows in training: {(cnt >= 2).sum():,} "
          f"({(cnt >= 2).sum() / (ytr == 1).sum() * 100:.1f}% of scorers)\n")

    VARIANTS = ["shipped", "weighted", "within-pos", "both", "oversample", "pooled-weight"]
    print(f"{'variant':<16} {'top1 mean':>10} {'min':>7} {'max':>7} {'sd':>6} "
          f"{'auc':>7} {'pairs':>9}")
    out = {}
    for kind in VARIANTS:
        tops, aucs, npairs = [], [], 0
        seeds = SEEDS if kind != "pooled-weight" else [0]  # deterministic
        for s in seeds:
            score = fit_variant(kind, Xtr, ytr, cnt, gid, s)
            hits, _ = B.per_game_top1(te, score)
            tops.append(float(hits.mean()))
            aucs.append(float(roc_auc_score(yte, score)))
        if kind != "pooled-weight":
            D, L, W = pairs_for(kind, Xtr, ytr, cnt, gid, 0)
            npairs = len(D)
        out[kind] = {"top1": tops, "auc": aucs, "pairs": int(npairs)}
        print(f"{kind:<16} {np.mean(tops)*100:>9.2f}% {min(tops)*100:>6.1f}% "
              f"{max(tops)*100:>6.1f}% {np.std(tops)*100:>5.2f} "
              f"{np.mean(aucs):>7.4f} {npairs:>9,}")

    base = np.mean(out["shipped"]["top1"])
    print(f"\nagainst the shipped ranker ({base*100:.2f}%):")
    for kind in VARIANTS:
        if kind == "shipped":
            continue
        d = (np.mean(out[kind]["top1"]) - base) * 100
        print(f"  {kind:<16} {d:>+6.2f} points")

    json.dump(out, open(os.path.join(HERE, "multi_td.json"), "w"), indent=1)
    print("\nwrote multi_td.json")


if __name__ == "__main__":
    main()
