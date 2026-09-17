"""
Can the winner actually ship, and did it win by luck?

bakeoff_sig.py says extra trees beats the shipped logistic by 1.9 points of
top-1 accuracy, with a 95% interval clear of zero and the same edge in both
held-out seasons. Two things have to be true before that becomes a
recommendation rather than a result.

SEED STABILITY
An extra-trees fit is randomised twice over — bootstrap rows and random split
points — so a single seed can flatter it. If the edge is a seed, it is nothing.

DEPLOYABILITY
The live board runs the model in TypeScript from a JSON file: sixteen
coefficients, a mean and a standard deviation. A 300-tree forest is not that.
Every node has to be serialised, the page has to walk them on every player of
every game, and the file ships to the browser. So the question is not "is the
forest better" but "is a forest SMALL ENOUGH TO SHIP still better" — the same
question ablate.py asked of two features and answered no.
"""
import os, json, time
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

import features as F
import bakeoff_big as B

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    return tr, te, sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)


def top1(te, score):
    d = te[["game_id", "scored"]].copy()
    d["s"] = score
    return np.array([int(g.loc[g.s.idxmax()].scored) for _, g in d.groupby("game_id")])


def node_count(forest):
    return int(sum(t.tree_.node_count for t in forest.estimators_))


def main():
    tr, te, Xtr, Xte = load()
    ytr = tr.scored.values

    base = LogisticRegression(max_iter=3000, C=1.0).fit(Xtr, ytr)
    base_top1 = top1(te, base.predict_proba(Xte)[:, 1]).mean()
    print(f"shipped logistic: top1 {base_top1*100:.1f}%  (16 coefficients)\n")

    print("=== seed stability: the full 300-tree forest, ten seeds ===")
    seeds = []
    for s in range(10):
        m = ExtraTreesClassifier(
            n_estimators=300, min_samples_leaf=20, random_state=s, n_jobs=-1
        ).fit(Xtr, ytr)
        t = top1(te, m.predict_proba(Xte)[:, 1]).mean()
        seeds.append(t)
        print(f"  seed {s}: top1 {t*100:.2f}%  ({t*100-base_top1*100:+.2f} vs shipped)")
    seeds = np.array(seeds)
    print(f"\n  mean {seeds.mean()*100:.2f}%  sd {seeds.std()*100:.2f}  "
          f"min {seeds.min()*100:.2f}%  max {seeds.max()*100:.2f}%")
    print(f"  seeds beating the shipped model: {(seeds > base_top1).sum()}/10")

    print("\n=== deployable size: how small can the forest get? ===")
    print(f"{'trees':>6} {'leaf':>5} {'depth':>6} {'nodes':>9} {'~JSON':>9} {'top1':>7} {'vs shipped':>11}")
    rows = []
    for n_est, leaf, depth in [
        (300, 20, None), (200, 20, None), (100, 20, None), (50, 20, None),
        (50, 50, None), (30, 50, None), (50, 100, None), (30, 100, None),
        (50, 20, 8), (30, 20, 8), (50, 20, 6), (100, 50, 8), (20, 100, 8),
    ]:
        # averaged over three seeds so the size comparison is not a seed hunt
        ts, nodes = [], []
        for s in range(3):
            m = ExtraTreesClassifier(
                n_estimators=n_est, min_samples_leaf=leaf, max_depth=depth,
                random_state=s, n_jobs=-1,
            ).fit(Xtr, ytr)
            ts.append(top1(te, m.predict_proba(Xte)[:, 1]).mean())
            nodes.append(node_count(m))
        t = float(np.mean(ts))
        nd = int(np.mean(nodes))
        # a serialised node is roughly: feature idx, threshold, two child idxs,
        # value — call it 40 bytes of compact JSON
        kb = nd * 40 / 1024
        rows.append({"trees": n_est, "leaf": leaf, "depth": depth, "nodes": nd,
                     "json_kb": round(kb, 1), "top1": t, "vs_shipped": t - base_top1})
        print(f"{n_est:>6} {leaf:>5} {str(depth):>6} {nd:>9,} {kb:>8.0f}K "
              f"{t*100:>6.1f}% {(t-base_top1)*100:>+10.2f}")

    json.dump({"shipped_top1": float(base_top1),
               "seed_stability": {"seeds": seeds.tolist(), "mean": float(seeds.mean()),
                                  "sd": float(seeds.std()),
                                  "beat_shipped": int((seeds > base_top1).sum())},
               "sizes": rows},
              open(os.path.join(HERE, "bakeoff_deploy.json"), "w"), indent=1)
    print("\nwrote bakeoff_deploy.json")


if __name__ == "__main__":
    main()
