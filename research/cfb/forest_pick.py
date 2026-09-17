"""
Which forest, exactly?

bakeoff_deploy.py compared sizes over three seeds and the numbers bounced —
50 trees at depth 8 scored +0.29 while 30 trees at the same depth scored +0.94,
which cannot both be information. An extra-trees fit is randomised twice over
(bootstrap rows, random split thresholds), so choosing a configuration on three
seeds is choosing noise.

Eight seeds per configuration here, with the spread reported, so the pick is
made on something that would survive being re-run. Also compares extra trees
against a random forest at matched size, since the bakeoff's single-seed result
had them 0.9 apart.

Size matters but not as much as the earlier note implied: this model runs
server-side, so the file is bundled into the serverless function rather than
shipped to a browser. A few megabytes is affordable; thirty is not, and it
would make every cold start parse it.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss

import features as F
import bakeoff_big as B
from bakeoff_big import ece

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDS = 8
# One node serialises as: feature index (int8), threshold (float32),
# left child (int32), right child (int32), value (float32) = 17 bytes packed.
BYTES_PER_NODE = 17


def main():
    df = pd.read_csv(os.path.join(HERE, "data", "features.csv"))
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    Xtr, Xte = sc.transform(tr[F.FEATURES].values), sc.transform(te[F.FEATURES].values)
    ytr, yte = tr.scored.values, te.scored.values
    gt = te[["game_id", "scored"]].copy()

    def top1(p):
        d = gt.copy()
        d["s"] = p
        return np.array([int(g.loc[g.s.idxmax()].scored) for _, g in d.groupby("game_id")])

    base = top1(LogisticRegression(max_iter=4000, C=1.0).fit(Xtr, ytr).predict_proba(Xte)[:, 1]).mean()
    print(f"shipped logistic: {base*100:.2f}% top-1\n")

    configs = [
        ("extra", 300, 20, None), ("extra", 300, 50, None),
        ("extra", 200, 20, None), ("extra", 150, 20, None),
        ("extra", 100, 20, None), ("extra", 100, 50, None),
        ("extra", 60, 20, None), ("extra", 60, 50, None),
        ("extra", 100, 20, 12), ("extra", 100, 20, 10),
        ("extra", 60, 20, 10), ("extra", 100, 100, None),
        ("forest", 300, 20, None), ("forest", 100, 20, None),
    ]
    print(f"{'kind':>7} {'trees':>6} {'leaf':>5} {'depth':>6} {'nodes':>9} {'size':>8} "
          f"{'top1':>7} {'vs lr':>7} {'sd':>5} {'auc':>7} {'ece':>7}")
    rows = []
    for kind, n_est, leaf, depth in configs:
        ts, aucs, eces, nodes = [], [], [], []
        for s in range(SEEDS):
            Cls = ExtraTreesClassifier if kind == "extra" else RandomForestClassifier
            m = Cls(n_estimators=n_est, min_samples_leaf=leaf, max_depth=depth,
                    random_state=s, n_jobs=-1).fit(Xtr, ytr)
            p = m.predict_proba(Xte)[:, 1]
            ts.append(top1(p).mean())
            aucs.append(roc_auc_score(yte, p))
            eces.append(ece(yte, p))
            nodes.append(sum(t.tree_.node_count for t in m.estimators_))
        nd = int(np.mean(nodes))
        mb = nd * BYTES_PER_NODE / 1024 / 1024
        r = {"kind": kind, "trees": n_est, "leaf": leaf, "depth": depth, "nodes": nd,
             "mb": round(mb, 2), "top1": float(np.mean(ts)), "top1_sd": float(np.std(ts)),
             "vs_lr": float(np.mean(ts) - base), "auc": float(np.mean(aucs)),
             "ece": float(np.mean(eces))}
        rows.append(r)
        size = f"{mb*1024:.0f}K" if mb < 1 else f"{mb:.1f}M"
        print(f"{kind:>7} {n_est:>6} {leaf:>5} {str(depth):>6} {nd:>9,} {size:>8} "
              f"{r['top1']*100:>6.2f}% {r['vs_lr']*100:>+6.2f} {r['top1_sd']*100:>5.2f} "
              f"{r['auc']:>7.4f} {r['ece']:>7.4f}")

    print("\n=== best accuracy per size budget ===")
    for budget, label in ((0.5, "under 500K"), (2.0, "under 2M"), (99.0, "any size")):
        ok = [r for r in rows if r["mb"] <= budget]
        if not ok:
            continue
        b = max(ok, key=lambda r: r["top1"])
        print(f"  {label:<12} {b['kind']} {b['trees']}/{b['leaf']}/{b['depth']}: "
              f"{b['top1']*100:.2f}% ({b['vs_lr']*100:+.2f}), {b['mb']:.2f}MB, sd {b['top1_sd']*100:.2f}")

    json.dump({"shipped_top1": float(base), "seeds": SEEDS, "configs": rows},
              open(os.path.join(HERE, "forest_pick.json"), "w"), indent=1)
    print("\nwrote forest_pick.json")


if __name__ == "__main__":
    main()
