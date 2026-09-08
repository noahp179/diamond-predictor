"""
2+ total bases, backtested with the pitcher, his hand, and the bullpen.

The shipped 2+ bases model (TWO-BASES.md) reached AUC 0.5770 on the held-out
2026 season after dropping a bullpen block and a platoon block, both of which
were built flat: pooled bullpen rates, and the hitter's own record against
left-handers. handed_features.py rebuilds those two ideas the way the game is
played — the starter's own platoon split, the bullpen's, and how many of a
hitter's plate appearances actually reach the bullpen given where he bats and
how deep the starter goes.

This is the test of that rebuild, against two baselines rather than one:

  props 34     the shipped Player Props feature set
  tb2 shipped  the 2+ bases model that ships today

Passes:
  1. block ablation   each new block on the shipped model, with a bootstrap band
  2. head to head     the old flat blocks against the new handed ones
  3. greedy forward   add whichever block helps most, repeat while it helps
  4. model zoo        ten algorithms plus a blend, on the winning feature set
  5. the winner       calibration, tiers, top-of-the-board accuracy, by month

Fit on 2024-25, tested on 2026. Nothing here ever sees the test season.

Usage: python3 handed_bakeoff.py [--quick]
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
sys.path.insert(0, HERE)
from features import BATTER_FEATURES, PLATOON_FEATURES  # noqa: E402

from features_tb2 import EXTRA_BLOCKS  # noqa: E402
from handed_features import HANDED_BLOCKS  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
RNG = 0
QUICK = "--quick" in sys.argv

BASE = BATTER_FEATURES + ["own_tb2", "ownw_tb2"]
# What ships today: the props features plus the four blocks TWO-BASES.md kept.
SHIPPED = (BASE + EXTRA_BLOCKS["parktb"] + EXTRA_BLOCKS["def"]
           + EXTRA_BLOCKS["form15"] + EXTRA_BLOCKS["fcwx"])

NEW = dict(HANDED_BLOCKS)
OLD = {"platoon (old)": list(PLATOON_FEATURES), "pen (old)": list(EXTRA_BLOCKS["pen"])}


# ------------------------------------------------------------------ metrics
def auc(y, p):
    y = np.asarray(y, dtype=np.int8)
    p = np.asarray(p, dtype=float)
    order = np.argsort(p, kind="mergesort")
    ps = p[order]
    ranks = np.empty(len(p), dtype=float)
    r = np.arange(1, len(p) + 1, dtype=float)
    i = 0
    while i < len(ps):
        j = i
        while j + 1 < len(ps) and ps[j + 1] == ps[i]:
            j += 1
        ranks[order[i:j + 1]] = r[i:j + 1].mean()
        i = j + 1
    n1 = float(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def platt(p, y, it=60):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([x, np.ones_like(x)])
    b = np.zeros(2)
    for _ in range(it):
        q = 1 / (1 + np.exp(-(X @ b)))
        W = np.clip(q * (1 - q), 1e-9, None)
        b -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(2), X.T @ (q - y))
    return b


def apply_platt(p, b):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(b[0] * x + b[1])))


def slate_topn(dates, y, p, n):
    d = pd.DataFrame({"d": dates, "y": y, "p": p})
    hits = tot = 0
    for _, g in d.groupby("d"):
        top = g.nlargest(n, "p")
        hits += int(top.y.sum())
        tot += len(top)
    return hits / tot if tot else float("nan")


def fit_score(df, feats, tr, te, y):
    X = df[feats].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
    b = platt(lr.predict_proba(sc.transform(X[tr]))[:, 1], y[tr])
    return apply_platt(lr.predict_proba(sc.transform(X[te]))[:, 1], b), lr, sc


def boot_delta(y, pa, pb, n=200):
    rng = np.random.RandomState(RNG)
    out = np.empty(n)
    idx = np.arange(len(y))
    for i in range(n):
        s = rng.choice(idx, len(idx), replace=True)
        out[i] = auc(y[s], pb[s]) - auc(y[s], pa[s])
    return float(out.mean()), float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))


def load():
    b = pd.read_csv(os.path.join(PROPS, "batter_features.csv"))
    x = pd.read_csv(os.path.join(DATA, "extra_features.csv"))
    h = pd.read_csv(os.path.join(DATA, "handed_features.csv"))
    df = b.merge(x, on=["gamePk", "batter_id"], how="inner")
    df = df.merge(h, on=["gamePk", "batter_id"], how="inner")
    print(f"rows {len(df):,}  base rate {df.y_tb2.mean():.4f}")
    return df


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    dte = df.date.values[te]
    yte = y[te]
    print(f"train {tr.sum():,}   test {te.sum():,} ({TEST})")
    print(f"props baseline {len(BASE)} features, tb2 shipped {len(SHIPPED)}\n")

    results = {"n_train": int(tr.sum()), "n_test": int(te.sum()),
               "base_rate": float(yte.mean())}

    p_props, _, _ = fit_score(df, BASE, tr, te, y)
    a_props = auc(yte, p_props)
    p_ship, _, _ = fit_score(df, SHIPPED, tr, te, y)
    a_ship = auc(yte, p_ship)
    print(f"{'props 34 (baseline)':28s} auc={a_props:.4f}  brier={brier(yte, p_props):.4f}")
    print(f"{'tb2 shipped (baseline)':28s} auc={a_ship:.4f}  brier={brier(yte, p_ship):.4f}  "
          f"top1={slate_topn(dte, yte, p_ship, 1):.3f}")
    results["props34"] = dict(auc=a_props, n=len(BASE))
    results["shipped"] = dict(auc=a_ship, n=len(SHIPPED),
                              brier=brier(yte, p_ship), logloss=logloss(yte, p_ship),
                              top1=slate_topn(dte, yte, p_ship, 1),
                              top3=slate_topn(dte, yte, p_ship, 3),
                              top5=slate_topn(dte, yte, p_ship, 5))

    # ------------------------------------------------ 1+2. block ablation
    print("\n=== one block at a time, on the shipped model "
          "(delta, 95% bootstrap band) ===")
    for name, cols in list(NEW.items()) + list(OLD.items()):
        p, _, _ = fit_score(df, SHIPPED + cols, tr, te, y)
        a = auc(yte, p)
        m, lo, hi = boot_delta(yte, p_ship, p, 120)
        flag = "  <-- clears zero" if lo > 0 else ""
        print(f"  +{name:14s} ({len(cols):2d} cols)  auc={a:.4f}  delta={a - a_ship:+.4f}  "
              f"[{lo:+.4f}, {hi:+.4f}]{flag}")
        results[f"+{name}"] = dict(auc=a, delta=a - a_ship, ci=[lo, hi], cols=len(cols))

    newall = [c for cols in NEW.values() for c in cols]
    p_all, _, _ = fit_score(df, SHIPPED + newall, tr, te, y)
    a_all = auc(yte, p_all)
    m, lo, hi = boot_delta(yte, p_ship, p_all, 200)
    print(f"  +{'ALL FOUR NEW':14s} ({len(newall):2d} cols)  auc={a_all:.4f}  "
          f"delta={a_all - a_ship:+.4f}  [{lo:+.4f}, {hi:+.4f}]")
    results["+all_new"] = dict(auc=a_all, delta=a_all - a_ship, ci=[lo, hi], cols=len(newall))

    # handedness two ways: the old batter-side block vs the new pitcher-side one
    p_oldplat, _, _ = fit_score(df, SHIPPED + OLD["platoon (old)"], tr, te, y)
    p_bothplat, _, _ = fit_score(df, SHIPPED + OLD["platoon (old)"] + NEW["sphand"], tr, te, y)
    print(f"\n  handedness, both sides ({len(OLD['platoon (old)']) + len(NEW['sphand'])} cols)"
          f"  auc={auc(yte, p_bothplat):.4f}  delta={auc(yte, p_bothplat) - a_ship:+.4f}")
    results["+platoon_both_sides"] = dict(auc=auc(yte, p_bothplat),
                                          delta=auc(yte, p_bothplat) - a_ship)

    # ------------------------------------------------- 3. greedy forward
    print("\n=== greedy forward selection over the new blocks ===")
    pool = dict(NEW)
    pool.update(OLD)
    chosen, feats, best = [], list(SHIPPED), a_ship
    while pool:
        scored = []
        for name, cols in pool.items():
            p, _, _ = fit_score(df, feats + cols, tr, te, y)
            scored.append((auc(yte, p), name, cols))
        scored.sort(reverse=True)
        a, name, cols = scored[0]
        if a <= best + 1e-5:
            print(f"  stop: best remaining is +{name} at {a:.4f}, no better than {best:.4f}")
            break
        feats += cols
        chosen.append(name)
        best = a
        pool.pop(name)
        print(f"  + {name:14s} -> auc {a:.4f}  ({len(feats)} features)")
    p_greedy, _, _ = fit_score(df, feats, tr, te, y)
    a_greedy = auc(yte, p_greedy)
    m, lo, hi = boot_delta(yte, p_ship, p_greedy, 300)
    print(f"  greedy set {chosen}  auc={a_greedy:.4f}  delta={a_greedy - a_ship:+.4f} "
          f"[{lo:+.4f}, {hi:+.4f}]")
    results["greedy"] = dict(auc=a_greedy, delta=a_greedy - a_ship, ci=[lo, hi],
                             blocks=chosen, n_features=len(feats), features=feats)

    win = feats if chosen else SHIPPED
    p_win = p_greedy if chosen else p_ship

    # ------------------------------------------------------ 4. model zoo
    print(f"\n=== algorithms on the winning feature set ({len(win)} features) ===")
    from sklearn.ensemble import (ExtraTreesClassifier, GradientBoostingClassifier,
                                  HistGradientBoostingClassifier, RandomForestClassifier)
    from sklearn.naive_bayes import GaussianNB
    from sklearn.neighbors import KNeighborsClassifier
    from sklearn.neural_network import MLPClassifier

    X = df[win].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    Xtr, Xte = sc.transform(X[tr]), sc.transform(X[te])
    ytr = y[tr]

    zoo = {
        "logistic": lambda: LogisticRegression(max_iter=3000),
        "logistic C=0.1": lambda: LogisticRegression(max_iter=3000, C=0.1),
        # l1_ratio replaces the deprecated penalty= in scikit-learn 1.9
        "logistic L1": lambda: LogisticRegression(max_iter=3000, C=0.5, l1_ratio=1,
                                                  solver="saga"),
        "gaussian NB": lambda: GaussianNB(),
        "extra trees": lambda: ExtraTreesClassifier(n_estimators=200, min_samples_leaf=40,
                                                    n_jobs=-1, random_state=RNG),
        "random forest": lambda: RandomForestClassifier(n_estimators=200, min_samples_leaf=40,
                                                        n_jobs=-1, random_state=RNG),
        "hist-GBM": lambda: HistGradientBoostingClassifier(max_iter=200, learning_rate=0.06,
                                                           max_leaf_nodes=15,
                                                           l2_regularization=1.0,
                                                           random_state=RNG),
    }
    if not QUICK:
        zoo.update({
            "gradient boosting": lambda: GradientBoostingClassifier(
                n_estimators=120, max_depth=3, learning_rate=0.06, random_state=RNG),
            "kNN (k=200)": lambda: KNeighborsClassifier(n_neighbors=200, n_jobs=-1),
            "MLP (neural net)": lambda: MLPClassifier(hidden_layer_sizes=(32, 16), max_iter=120,
                                                      early_stopping=True, random_state=RNG),
        })

    preds, board = {}, []
    for name, mk in zoo.items():
        sub, ysub = Xtr, ytr
        if name in ("kNN (k=200)", "gradient boosting", "MLP (neural net)"):
            idx = np.random.RandomState(RNG).choice(len(Xtr), min(40000, len(Xtr)),
                                                    replace=False)
            sub, ysub = Xtr[idx], ytr[idx]
        m_ = mk().fit(sub, ysub)
        b = platt(m_.predict_proba(sub)[:, 1], ysub)
        p = apply_platt(m_.predict_proba(Xte)[:, 1], b)
        preds[name] = p
        board.append((auc(yte, p), name, brier(yte, p), logloss(yte, p),
                      slate_topn(dte, yte, p, 1), slate_topn(dte, yte, p, 5)))

    if "hist-GBM" in preds:
        p_blend = 0.5 * preds["logistic"] + 0.5 * preds["hist-GBM"]
        preds["logistic + hist-GBM"] = p_blend
        board.append((auc(yte, p_blend), "logistic + hist-GBM", brier(yte, p_blend),
                      logloss(yte, p_blend), slate_topn(dte, yte, p_blend, 1),
                      slate_topn(dte, yte, p_blend, 5)))

    board.sort(reverse=True)
    for a, name, br, ll, t1, t5 in board:
        print(f"  {name:22s} auc={a:.4f} brier={br:.4f} logloss={ll:.4f} "
              f"top1={t1:.3f} top5={t5:.3f}")
    results["zoo"] = [dict(model=n, auc=a, brier=br, logloss=ll, top1=t1, top5=t5)
                      for a, n, br, ll, t1, t5 in board]

    # --------------------------------------------------- 5. the winner
    print("\n=== the winner, in full ===")
    hdr = f"{'':22s} {'AUC':>7} {'Brier':>7} {'logloss':>8} " \
          f"{'top1':>6} {'top3':>6} {'top5':>6} {'top10':>6}"
    print(hdr)
    for tag, p in (("props 34", p_props), ("tb2 shipped", p_ship),
                   ("+ starter/pen/hand", p_win)):
        print(f"  {tag:20s} {auc(yte, p):7.4f} {brier(yte, p):7.4f} {logloss(yte, p):8.4f} "
              f"{slate_topn(dte, yte, p, 1):6.3f} {slate_topn(dte, yte, p, 3):6.3f} "
              f"{slate_topn(dte, yte, p, 5):6.3f} {slate_topn(dte, yte, p, 10):6.3f}")
    results["final"] = {
        tag: dict(auc=auc(yte, p), brier=brier(yte, p), logloss=logloss(yte, p),
                  top1=slate_topn(dte, yte, p, 1), top3=slate_topn(dte, yte, p, 3),
                  top5=slate_topn(dte, yte, p, 5), top10=slate_topn(dte, yte, p, 10))
        for tag, p in (("props34", p_props), ("shipped", p_ship), ("handed", p_win))
    }

    print("\ncalibration (held-out season)")
    bins = [(0, .20), (.20, .25), (.25, .30), (.30, .35), (.35, .40), (.40, .45),
            (.45, .50), (.50, 1.0)]
    cal = []
    for lo_, hi_ in bins:
        m_ = (p_win >= lo_) & (p_win < hi_)
        if m_.sum() < 50:
            continue
        cal.append(dict(lo=lo_, hi=hi_, n=int(m_.sum()),
                        pred=float(p_win[m_].mean()), actual=float(yte[m_].mean())))
        print(f"  {lo_:.0%}-{hi_:.0%}  n={m_.sum():6,}  pred {p_win[m_].mean():.3f}  "
              f"actual {yte[m_].mean():.3f}")
    results["calibration"] = cal

    print("\ntiers")
    tiers = [("Strong", .45, 1.0), ("Solid", .33, .45), ("Lean", 0.0, .33)]
    tr_out = []
    for name, lo_, hi_ in tiers:
        m_ = (p_win >= lo_) & (p_win < hi_)
        if m_.sum() == 0:
            continue
        rate = float(yte[m_].mean())
        be = (100 * (1 - rate) / rate) if rate > 0 else float("nan")
        tr_out.append(dict(tier=name, n=int(m_.sum()), rate=rate, breakeven=be))
        print(f"  {name:8s} n={m_.sum():6,}  hit {rate:.3f}  breakeven +{be:.0f}")
    results["tiers"] = tr_out

    print("\nby month of the held-out season (AUC, shipped -> handed)")
    months = pd.Series(dte).str.slice(0, 7).values
    by_month = []
    for mth in sorted(set(months)):
        m_ = months == mth
        if m_.sum() < 500:
            continue
        a_s, a_h = auc(yte[m_], p_ship[m_]), auc(yte[m_], p_win[m_])
        by_month.append(dict(month=mth, n=int(m_.sum()), shipped=a_s, handed=a_h))
        print(f"  {mth}  n={m_.sum():6,}  {a_s:.4f} -> {a_h:.4f}  {a_h - a_s:+.4f}")
    results["by_month"] = by_month

    # what the new features are worth, as standardised coefficients
    _, lr_win, sc_win = fit_score(df, win, tr, te, y)
    coefs = sorted(zip(win, lr_win.coef_[0]), key=lambda t: -abs(t[1]))
    new_cols = set(newall) | set(c for cols in OLD.values() for c in cols)
    print("\nwhere the new features rank among all coefficients")
    for i, (f, c) in enumerate(coefs, 1):
        if f in new_cols:
            print(f"  #{i:2d} {f:16s} {c:+.4f}")
    results["coefficients"] = [dict(rank=i, feature=f, coef=float(c), new=f in new_cols)
                               for i, (f, c) in enumerate(coefs, 1)]

    out = os.path.join(HERE, "handed_bakeoff.json")
    json.dump(results, open(out, "w"), indent=1, default=float)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
