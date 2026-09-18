"""
Three follow-ups to multi_td.py.

1. ARE THE GAPS REAL? Every count-aware variant lost, but -0.35 points over 301
   games is four games and could be nothing. Slate-clustered paired bootstrap,
   the same test that sank hist gradient boosting earlier in this project.

2. WHY DOES COUNT INFORMATION HURT TOP-1 WHILE HELPING AUC? The two metrics
   moved in opposite directions, monotonically, across six variants. If the
   explanation is "count-weighting learns who racks up touchdowns rather than
   who gets one", then the variants should be measurably better at ranking
   multi-touchdown games and worse at the single pick — which is testable
   rather than a story.

3. CAN 2+ TOUCHDOWNS BE PREDICTED AT ALL? It is a separate market that pays
   far more, and the board currently has no opinion on it. Worth knowing
   whether the same features support it or whether it is mostly noise.
"""
import os, json
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss

import bakeoff_nfl as B
import multi_td as M

HERE = os.path.dirname(os.path.abspath(__file__))
BOOTSTRAPS = 4000
RNG = np.random.default_rng(11)


def main():
    df = B.load()
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    Xtr = sc.transform(tr[B.FEATURES].values)
    Xte = sc.transform(te[B.FEATURES].values)
    M.X_TE = Xte
    ytr, yte = tr.scored.values, te.scored.values
    cnt_tr, cnt_te = tr.td_count.values.astype(float), te.td_count.values.astype(float)
    gid = tr.game_id.values

    gmeta = te.groupby("game_id").agg(date=("date", "first")).sort_index()
    slate_of = gmeta.date.values
    slates = np.unique(slate_of)
    slate_idx = {s: np.flatnonzero(slate_of == s) for s in slates}

    # ---------------------------------------------------- 1. significance
    # Seed-averaged weights per variant: the honest comparison, since no single
    # pair sample is privileged and averaging removes the sampling jitter.
    print("--- are the losses real? paired bootstrap, resampling whole slates ---")
    hits = {}
    for kind in ["shipped", "weighted", "within-pos", "both", "oversample"]:
        Ws = []
        for s in M.SEEDS:
            D, L, W = M.pairs_for(kind, Xtr, ytr, cnt_tr, gid, s)
            m = LogisticRegression(max_iter=5000, fit_intercept=False, C=1.0)
            m.fit(D, L, sample_weight=W)
            Ws.append(m.coef_[0])
        h, _ = B.per_game_top1(te, Xte @ np.mean(Ws, axis=0))
        hits[kind] = h
    w = np.where(ytr == 1, np.maximum(cnt_tr, 1), 1.0).astype(float)
    pm = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, ytr, sample_weight=w / w.mean())
    hits["pooled-weight"], _ = B.per_game_top1(te, pm.predict_proba(Xte)[:, 1])

    base = hits["shipped"]
    print(f"{'variant':<16} {'top1':>7} {'diff':>7} {'95% CI':>18} {'P(worse)':>9}")
    sig = {}
    for kind, h in hits.items():
        d = np.empty(BOOTSTRAPS)
        for k in range(BOOTSTRAPS):
            pick = RNG.choice(slates, size=len(slates), replace=True)
            idx = np.concatenate([slate_idx[s] for s in pick])
            d[k] = h[idx].mean() - base[idx].mean()
        lo, hi = np.percentile(d, [2.5, 97.5])
        sig[kind] = {"top1": float(h.mean()), "diff": float(d.mean()),
                     "lo": float(lo), "hi": float(hi), "p_worse": float((d < 0).mean())}
        star = "  *" if hi < 0 else ""
        print(f"{kind:<16} {h.mean()*100:>6.1f}% {d.mean()*100:>+6.1f} "
              f"[{lo*100:>+5.1f},{hi*100:>+5.1f}]{'':>3} {(d<0).mean():>8.2f}{star}")
    print("\n  * = 95% interval excludes zero, so the loss is real and not sampling noise")

    # ------------------------------------- 2. what did the variants learn?
    # If count-weighting teaches "who racks up touchdowns" rather than "who gets
    # one", then it should rank MULTI-touchdown games better than the shipped
    # model while picking the single scorer worse.
    print("\n--- what the count actually taught them ---")
    print(f"{'variant':<16} {'auc >=1 TD':>11} {'auc >=2 TD':>11} {'top1':>7}")
    learned = {}
    for kind, h in hits.items():
        if kind == "pooled-weight":
            score = pm.predict_proba(Xte)[:, 1]
        else:
            Ws = []
            for s in M.SEEDS:
                D, L, W = M.pairs_for(kind, Xtr, ytr, cnt_tr, gid, s)
                m = LogisticRegression(max_iter=5000, fit_intercept=False, C=1.0)
                m.fit(D, L, sample_weight=W)
                Ws.append(m.coef_[0])
            score = Xte @ np.mean(Ws, axis=0)
        a1 = roc_auc_score(yte, score)
        a2 = roc_auc_score((cnt_te >= 2).astype(int), score)
        learned[kind] = {"auc1": float(a1), "auc2": float(a2), "top1": float(h.mean())}
        print(f"{kind:<16} {a1:>11.4f} {a2:>11.4f} {h.mean()*100:>6.1f}%")
    print("  a variant that gains on the >=2 column while losing the top1 column")
    print("  is answering 'who scores a lot', which is not what the card asks")

    # ------------------------------------------- 3. is 2+ TD predictable?
    print("\n--- can 2+ touchdowns be predicted with these features? ---")
    y2_tr, y2_te = (cnt_tr >= 2).astype(int), (cnt_te >= 2).astype(int)
    print(f"  base rate: train {y2_tr.mean()*100:.2f}%, test {y2_te.mean()*100:.2f}%")
    m2 = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, y2_tr)
    p2 = m2.predict_proba(Xte)[:, 1]
    print(f"  direct 2+ model:  auc {roc_auc_score(y2_te, p2):.4f}  "
          f"logloss {log_loss(y2_te, p2):.4f}  ece {B.ece(y2_te, p2):.4f}")
    print(f"  max stated probability: {p2.max()*100:.1f}% "
          f"(a market nobody can offer a confident pick in)")
    # how good is the best 2+ pick per game?
    d = te[["game_id", "scored"]].copy()
    d["p2"] = p2
    d["two"] = y2_te
    lead = d.loc[d.groupby("game_id").p2.idxmax()]
    print(f"  top 2+ pick per game: stated {lead.p2.mean()*100:.1f}%  "
          f"actual {lead.two.mean()*100:.1f}%  ({int(lead.two.sum())}/{len(lead)} games)")

    json.dump({"significance": sig, "learned": learned,
               "two_plus": {"auc": float(roc_auc_score(y2_te, p2)),
                            "base_test": float(y2_te.mean()),
                            "max_p": float(p2.max()),
                            "lead_stated": float(lead.p2.mean()),
                            "lead_actual": float(lead.two.mean())}},
              open(os.path.join(HERE, "multi_td_sig.json"), "w"), indent=1)
    print("\nwrote multi_td_sig.json")


if __name__ == "__main__":
    main()
