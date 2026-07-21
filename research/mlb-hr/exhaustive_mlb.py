"""
MLB home-run-hitter model + exhaustive backtest — the MLB analog of the NFL
TD-scorer expedition.

Question: entering a game, which batter(s) are most likely to hit a home run?

Features (leak-free, built by a chronological walk that carries a batter's and
pitcher's history across seasons, so power is stable from opening day):
  batter  : career HR/PA (shrunk), isolated power, recent-form HR/PA (EWMA),
            recent PA/game, lineup slot, games of history
  matchup : opposing starter's HR-allowed rate, park HR factor, home/away
Label: the batter hit >=1 HR in the game (from the box score).

Backtest: train 2023, test 2024. Ranks all batters across both lineups per game.
Because a HR is rare (~4% of batter-games), we report top-1 / top-3 / top-5 hit
rates. Then an exhaustive algorithm sweep.
"""
import os, warnings
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import (RandomForestClassifier, ExtraTreesClassifier,
                              GradientBoostingClassifier, HistGradientBoostingClassifier)
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_predict, GroupKFold
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

K_HR, K_P = 150.0, 250.0        # shrinkage: PA of batter prior, BF of pitcher prior
ALPHA = 1 - 0.5 ** (1 / 15)     # EWMA half-life ~15 games for recent form

FEATURES = ["career_hr_rate", "iso", "ewma_hr_rate", "pa_pg", "order_slot",
            "is_home", "sp_hr_rate", "park_hr", "gp", "cum_pa"]


def build():
    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"))
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    bg["batter_id"] = bg.batter_id.astype(str)
    bg["opp_sp"] = bg.opp_sp.astype("Int64").astype(str)
    pg["pitcher_id"] = pg.pitcher_id.astype(str)

    lg_hr_pa = bg.hr.sum() / bg.pa.sum()
    lg_hr_bf = pg.hr_allowed.sum() / pg.bf.sum()
    # park HR factor: venue HR/PA relative to league (stable structural constant)
    pk = bg.groupby("venue").apply(lambda d: (d.hr.sum() / d.pa.sum()) / lg_hr_pa)
    park = pk.to_dict()
    print(f"league HR/PA={lg_hr_pa:.4f}  HR/BF allowed={lg_hr_bf:.4f}  parks={len(park)}")

    order = bg[["gamePk", "date"]].drop_duplicates().sort_values(["date", "gamePk"])
    bats_by = {g: d for g, d in bg.groupby("gamePk")}
    pits_by = {g: d for g, d in pg.groupby("gamePk")}

    B, P, rows = {}, {}, []
    for o in order.itertuples():
        gp_ = o.gamePk
        for r in bats_by[gp_].itertuples():
            b = B.get(r.batter_id)
            sp = P.get(r.opp_sp)
            if b and b["gp"] >= 5:
                sp_rate = ((sp["hr"] + K_P * lg_hr_bf) / (sp["bf"] + K_P)) if sp and sp["bf"] > 0 else lg_hr_bf
                rows.append({
                    "career_hr_rate": (b["hr"] + K_HR * lg_hr_pa) / (b["pa"] + K_HR),
                    "iso": (b["d2"] + 2 * b["d3"] + 3 * b["hr"]) / max(b["ab"], 1),
                    "ewma_hr_rate": b["ewma"],
                    "pa_pg": b["pa"] / b["gp"],
                    "order_slot": r.order_slot if r.order_slot else 6,
                    "is_home": r.is_home,
                    "sp_hr_rate": sp_rate,
                    "park_hr": park.get(r.venue, 1.0),
                    "gp": min(b["gp"], 200),
                    "cum_pa": min(b["pa"], 1500),
                    "season": r.season, "gamePk": gp_, "batter_id": r.batter_id,
                    "scored": int(r.hr > 0),
                })
        # update batter states
        for r in bats_by[gp_].itertuples():
            b = B.setdefault(r.batter_id, dict(gp=0, pa=0, ab=0, hr=0, d2=0, d3=0, ewma=lg_hr_pa))
            rate = r.hr / r.pa if r.pa else 0
            b["ewma"] += ALPHA * (rate - b["ewma"]) if b["gp"] else 0
            b["gp"] += 1; b["pa"] += r.pa; b["ab"] += r.ab; b["hr"] += r.hr
            b["d2"] += r.doubles; b["d3"] += r.triples
        # update pitcher states
        for r in pits_by.get(gp_, pd.DataFrame()).itertuples():
            p = P.setdefault(r.pitcher_id, dict(hr=0, bf=0))
            p["hr"] += r.hr_allowed; p["bf"] += r.bf
    return pd.DataFrame(rows)


def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    o = p.argsort(); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    csum = np.cumsum(cnt); r = ((csum - cnt + csum + 1) / 2.0)[inv]
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def picks(te, score, ks=(1, 3, 5)):
    d = te.copy(); d["_s"] = score
    hit = {k: 0 for k in ks}; n = 0
    for _, g in d.groupby("gamePk"):
        gg = g.sort_values("_s", ascending=False)
        sc = set(gg.loc[gg.scored == 1].index)
        n += 1
        for k in ks:
            hit[k] += int(any(i in sc for i in gg.index[:k]))
    return {k: hit[k] / n for k in ks}


def run():
    df = build()
    tr, te = df[df.season == 2023], df[df.season == 2024]
    ytr, yte = tr.scored.values, te.scored.values
    print(f"rows train={len(tr):,} test={len(te):,}  test games={te.gamePk.nunique()}  "
          f"HR base rate={yte.mean():.3f}")

    def ev(name, est):
        Xtr, Xte = tr[FEATURES].values, te[FEATURES].values
        try:
            est.fit(Xtr, ytr)
            p = est.predict_proba(Xte)[:, 1]
        except Exception as e:
            print(f"  {name}: FAIL {str(e)[:50]}"); return None
        pk = picks(te, p)
        return dict(model=name, auc=auc(yte, p), brier=brier(yte, p),
                    top1=pk[1], top3=pk[3], top5=pk[5])

    lg = lambda **k: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, **k))
    hgb = lambda: HistGradientBoostingClassifier(random_state=0, learning_rate=0.05, max_iter=500,
                                                 max_leaf_nodes=15, l2_regularization=1.0,
                                                 early_stopping=True, validation_fraction=0.15)
    res = []
    res.append(ev("logistic (BASELINE)", lg()))
    res.append(ev("logistic L1", lg(penalty="l1", solver="liblinear", C=0.5)))
    res.append(ev("random forest", RandomForestClassifier(n_estimators=500, min_samples_leaf=30, n_jobs=-1, random_state=0)))
    res.append(ev("extra trees", ExtraTreesClassifier(n_estimators=500, min_samples_leaf=30, n_jobs=-1, random_state=0)))
    res.append(ev("gradient boosting", GradientBoostingClassifier(random_state=0)))
    res.append(ev("hist-GBM", hgb()))
    res.append(ev("XGBoost", XGBClassifier(n_estimators=400, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, eval_metric="logloss", verbosity=0)))
    res.append(ev("LightGBM", LGBMClassifier(n_estimators=500, num_leaves=15, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)))
    res.append(ev("gaussian NB", make_pipeline(StandardScaler(), GaussianNB())))
    res.append(ev("kNN", make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=100))))
    res.append(ev("MLP", make_pipeline(StandardScaler(), MLPClassifier((32, 16), alpha=1e-2, max_iter=1500, early_stopping=True, random_state=0))))

    # stacked super-learner (OOF grouped by game)
    g = tr.gamePk.values
    base = {"lr": lg(), "hgb": hgb(), "rf": RandomForestClassifier(n_estimators=400, min_samples_leaf=30, n_jobs=-1, random_state=0),
            "xgb": XGBClassifier(n_estimators=400, max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, eval_metric="logloss", verbosity=0)}
    OOF, TEST = [], []
    for m in base.values():
        OOF.append(cross_val_predict(m, tr[FEATURES].values, ytr, cv=GroupKFold(4).split(tr[FEATURES].values, ytr, g), method="predict_proba", n_jobs=-1)[:, 1])
        m.fit(tr[FEATURES].values, ytr); TEST.append(m.predict_proba(te[FEATURES].values)[:, 1])
    meta = LogisticRegression(max_iter=2000).fit(np.column_stack(OOF), ytr)
    s = meta.predict_proba(np.column_stack(TEST))[:, 1]
    pk = picks(te, s)
    res.append(dict(model="STACK (LR+HGB+RF+XGB)", auc=auc(yte, s), brier=brier(yte, s), top1=pk[1], top3=pk[3], top5=pk[5]))

    res = [r for r in res if r]
    base_auc = next(r["auc"] for r in res if "BASELINE" in r["model"])
    res.sort(key=lambda r: -r["auc"])
    print("\n" + "=" * 78)
    print(f"MLB HOME-RUN MODEL SWEEP  test=2024  ({len(te):,} preds, {te.gamePk.nunique()} games)")
    print("=" * 78)
    print(f"{'#':>2} {'model':26s} {'AUC':>6} {'dAUC':>7} {'top1':>6} {'top3':>6} {'top5':>6} {'Brier':>7}")
    for i, r in enumerate(res, 1):
        d = r["auc"] - base_auc
        tag = "  <<< BASELINE" if "BASELINE" in r["model"] else ("  ***" if d > 0.005 else "")
        print(f"{i:>2} {r['model']:26s} {r['auc']:>6.4f} {d:>+7.4f} {r['top1']:>6.1%} {r['top3']:>6.1%} {r['top5']:>6.1%} {r['brier']:>7.4f}{tag}")

    # feature importances (logistic std coefs)
    sc = StandardScaler().fit(tr[FEATURES]); lr = LogisticRegression(max_iter=3000).fit(sc.transform(tr[FEATURES]), ytr)
    print("\nlogistic drivers:", {k: round(v, 3) for k, v in sorted(zip(FEATURES, lr.coef_[0]), key=lambda kv: -abs(kv[1]))})
    import json
    json.dump(res, open(os.path.join(HERE, "mlb_hr_results.json"), "w"), indent=2)


if __name__ == "__main__":
    run()
