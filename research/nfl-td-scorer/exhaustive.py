"""
Exhaustive search for a better TD-scorer model. Two levers:
  1. NEW INFORMATION - add red-zone / goal-line usage (rz_features.py) to the
     shipped season-to-date feature set.
  2. MANY ALGORITHMS - logistic (L1/L2/elastic), tree ensembles, XGBoost,
     LightGBM, kNN, naive Bayes, MLP, SVM, and a stacked super-learner.

Backtest: train 2021-2023, test 2024 (same protocol as the shipped model).
Primary metric AUC (calibration-free); also top-1 / top-2 pick accuracy.
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
from sklearn.svm import SVC
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_predict, GroupKFold
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
K_RUSH, K_REC, K_ANY = 25.0, 30.0, 4.0
LG_RUSH, LG_REC, LG_ANY = 0.0347, 0.0469, 0.21

BASE = ["carry_share", "target_share", "cpg", "tpg", "rush_ypg", "rec_ypg",
        "rush_td_rate", "rec_td_rate", "anytime_rate", "gp",
        "team_rush_tdpg", "team_rec_tdpg", "opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg",
        "is_home", "mkt_implied_total", "mkt_total", "mkt_team_margin"]
RZ = ["rz20_car_pg", "rz5_car_pg", "rz20_tgt_pg", "rz_car_share", "rz_tgt_share"]


def build():
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    pg["player_id"] = pg.player_id.astype(str)
    rz = pd.read_csv(os.path.join(DATA, "rz_usage.csv"))
    rz["player_id"] = rz.player_id.astype(str)
    pg = pg.merge(rz, on=["game_id", "player_id"], how="left").fillna(
        {c: 0 for c in ["rz20_car", "rz20_tgt", "rz10_car", "rz10_tgt", "rz5_car", "rz5_tgt"]})
    mkt = pd.read_csv(os.path.join(DATA, "market_lines.csv"))
    mk = {(r.game_id, r.team): r for r in mkt.itertuples()}
    order = (pg[["game_id", "season", "gameday"]].drop_duplicates().sort_values(["gameday", "game_id"]))
    by_game = {g: d for g, d in pg.groupby("game_id")}

    P, T, rows = {}, {}, []

    def ts(s, t):
        return T.setdefault((s, t), dict(gp=0, car=0, tgt=0, rtd=0, ctd=0, drtd=0, dctd=0,
                                         rzc=0, rzt=0))
    for o in order.itertuples():
        gid, s = o.game_id, o.season
        box = by_game[gid]
        home = gid.split("_")[-1]
        for team, tdf in box.groupby("team"):
            opp = tdf.iloc[0]["opp"]
            tt, ot = ts(s, team), ts(s, opp)
            m = mk.get((gid, team))
            for r in tdf.itertuples():
                ps = P.setdefault((s, r.player_id), dict(gp=0, car=0, tgt=0, ry=0, cy=0, rtd=0, ctd=0,
                                                         scg=0, rzc=0, rz5=0, rzt=0))
                if ps["gp"] >= 1 and tt["gp"] >= 1 and ot["gp"] >= 1 and m is not None and (ps["car"] + ps["tgt"]) >= 1:
                    rows.append({
                        "carry_share": ps["car"] / tt["car"] if tt["car"] else 0,
                        "target_share": ps["tgt"] / tt["tgt"] if tt["tgt"] else 0,
                        "cpg": ps["car"] / ps["gp"], "tpg": ps["tgt"] / ps["gp"],
                        "rush_ypg": ps["ry"] / ps["gp"], "rec_ypg": ps["cy"] / ps["gp"],
                        "rush_td_rate": (ps["rtd"] + K_RUSH * LG_RUSH) / (ps["car"] + K_RUSH),
                        "rec_td_rate": (ps["ctd"] + K_REC * LG_REC) / (ps["tgt"] + K_REC),
                        "anytime_rate": (ps["scg"] + K_ANY * LG_ANY) / (ps["gp"] + K_ANY),
                        "gp": min(ps["gp"], 17),
                        "team_rush_tdpg": tt["rtd"] / tt["gp"], "team_rec_tdpg": tt["ctd"] / tt["gp"],
                        "opp_rush_td_allowed_pg": ot["drtd"] / ot["gp"],
                        "opp_rec_td_allowed_pg": ot["dctd"] / ot["gp"],
                        "is_home": 1 if team == home else 0,
                        "mkt_implied_total": m.mkt_implied_total, "mkt_total": m.mkt_total,
                        "mkt_team_margin": m.mkt_team_margin,
                        # --- red zone (season-to-date) ---
                        "rz20_car_pg": ps["rzc"] / ps["gp"], "rz5_car_pg": ps["rz5"] / ps["gp"],
                        "rz20_tgt_pg": ps["rzt"] / ps["gp"],
                        "rz_car_share": ps["rzc"] / tt["rzc"] if tt["rzc"] else 0,
                        "rz_tgt_share": ps["rzt"] / tt["rzt"] if tt["rzt"] else 0,
                        "season": s, "game_id": gid,
                        "scored": int((r.rush_td + r.rec_td) > 0),
                    })
            # update team
            tt["gp"] += 1; tt["rtd"] += int(tdf.rush_td.sum()); tt["ctd"] += int(tdf.rec_td.sum())
            tt["car"] += int(tdf.carries.sum()); tt["tgt"] += int(tdf.targets.sum())
            tt["rzc"] += int(tdf.rz20_car.sum()); tt["rzt"] += int(tdf.rz20_tgt.sum())
            ot["drtd"] += int(tdf.rush_td.sum()); ot["dctd"] += int(tdf.rec_td.sum())
            for r in tdf.itertuples():
                ps = P[(s, r.player_id)]
                ps["gp"] += 1; ps["car"] += r.carries; ps["tgt"] += r.targets
                ps["ry"] += r.rush_yds; ps["cy"] += r.rec_yds; ps["rtd"] += r.rush_td; ps["ctd"] += r.rec_td
                ps["scg"] += 1 if (r.rush_td + r.rec_td) > 0 else 0
                ps["rzc"] += r.rz20_car; ps["rz5"] += r.rz5_car; ps["rzt"] += r.rz20_tgt
    return pd.DataFrame(rows)


def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    o = p.argsort(); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    csum = np.cumsum(cnt); r = ((csum - cnt + csum + 1) / 2.0)[inv]
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def picks(te, score):
    d = te.copy(); d["_s"] = score
    t1 = t2 = n = 0
    for _, g in d.groupby("game_id"):
        gg = g.sort_values("_s", ascending=False)
        sc = set(gg.loc[gg.scored == 1].index)
        n += 1
        t1 += int(gg.index[0] in sc)
        t2 += int(any(i in sc for i in gg.index[:2]))
    return t1 / n, t2 / n


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def run():
    df = build()
    tr, te = df[df.season <= 2023], df[df.season == 2024]
    ytr, yte = tr.scored.values, te.scored.values
    print(f"rows train={len(tr):,} test={len(te):,}  test games={te.game_id.nunique()}  "
          f"base rate={yte.mean():.3f}")

    def ev(name, est, feats, use_df=False):
        Xtr, Xte = tr[feats].values, te[feats].values
        try:
            est.fit(Xtr, ytr)
            s = est.predict_proba(Xte)[:, 1] if hasattr(est, "predict_proba") else est.decision_function(Xte)
            p = est.predict_proba(Xte)[:, 1] if hasattr(est, "predict_proba") else None
        except Exception as e:
            print(f"  {name}: FAILED {str(e)[:60]}"); return None
        t1, t2 = picks(te, s)
        return dict(model=name, auc=auc(yte, s), top1=t1, top2=t2,
                    brier=brier(yte, p) if p is not None else float("nan"))

    lg = lambda **k: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000, **k))
    xgb = lambda: XGBClassifier(n_estimators=400, max_depth=4, learning_rate=0.05,
                                subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
                                reg_lambda=1.0, verbosity=0)
    lgbm = lambda: LGBMClassifier(n_estimators=500, num_leaves=15, learning_rate=0.05,
                                  subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)
    hgb = lambda: HistGradientBoostingClassifier(random_state=0, learning_rate=0.05, max_iter=500,
                                                 max_leaf_nodes=15, l2_regularization=1.0,
                                                 early_stopping=True, validation_fraction=0.15)

    res = []
    # ---- ablation: does red zone help the shipped model? ----
    res.append(ev("logistic+market  (SHIPPED, base)", lg(), BASE))
    res.append(ev("logistic+market +REDZONE", lg(), BASE + RZ))
    # ---- many algorithms on the enriched set ----
    res.append(ev("logistic L1 +RZ", lg(penalty="l1", solver="liblinear", C=0.5), BASE + RZ))
    res.append(ev("logistic elastic-net +RZ", lg(penalty="elasticnet", solver="saga", l1_ratio=0.5, C=0.5), BASE + RZ))
    res.append(ev("random forest +RZ", RandomForestClassifier(n_estimators=500, min_samples_leaf=20, n_jobs=-1, random_state=0), BASE + RZ))
    res.append(ev("extra trees +RZ", ExtraTreesClassifier(n_estimators=500, min_samples_leaf=20, n_jobs=-1, random_state=0), BASE + RZ))
    res.append(ev("gradient boosting +RZ", GradientBoostingClassifier(random_state=0), BASE + RZ))
    res.append(ev("hist-GBM +RZ", hgb(), BASE + RZ))
    res.append(ev("XGBoost +RZ", xgb(), BASE + RZ))
    res.append(ev("LightGBM +RZ", lgbm(), BASE + RZ))
    res.append(ev("gaussian NB +RZ", make_pipeline(StandardScaler(), GaussianNB()), BASE + RZ))
    res.append(ev("kNN +RZ", make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=75)), BASE + RZ))
    res.append(ev("MLP +RZ", make_pipeline(StandardScaler(), MLPClassifier((32, 16), alpha=1e-2, max_iter=1500, early_stopping=True, random_state=0)), BASE + RZ))
    res.append(ev("SVM-RBF +RZ", make_pipeline(StandardScaler(), SVC(C=1.0, gamma="scale", probability=True, random_state=0)), BASE + RZ))
    # a linear model WITH pairwise interactions (usage x matchup non-linearities)
    res.append(ev("logistic +RZ +interactions", make_pipeline(
        StandardScaler(), PolynomialFeatures(2, interaction_only=True, include_bias=False),
        LogisticRegression(max_iter=6000, C=0.15)), BASE + RZ))
    # a heavily-regularized shallow XGBoost (its best shot on a noisy target)
    res.append(ev("XGBoost (shallow+reg) +RZ", XGBClassifier(
        n_estimators=300, max_depth=3, learning_rate=0.03, subsample=0.7,
        colsample_bytree=0.7, reg_lambda=5.0, min_child_weight=10, gamma=1.0,
        eval_metric="logloss", verbosity=0), BASE + RZ))

    # ---- stacked super-learner (OOF, grouped by game) ----
    feats = BASE + RZ
    g = tr.game_id.values
    base_models = {"lr": lg(), "hgb": hgb(), "rf": RandomForestClassifier(n_estimators=400, min_samples_leaf=20, n_jobs=-1, random_state=0), "xgb": xgb()}
    OOF, TEST = [], []
    for m in base_models.values():
        OOF.append(cross_val_predict(m, tr[feats].values, ytr, cv=GroupKFold(4).split(tr[feats].values, ytr, g), method="predict_proba", n_jobs=-1)[:, 1])
        m.fit(tr[feats].values, ytr); TEST.append(m.predict_proba(te[feats].values)[:, 1])
    meta = LogisticRegression(max_iter=2000).fit(np.column_stack(OOF), ytr)
    s = meta.predict_proba(np.column_stack(TEST))[:, 1]
    t1, t2 = picks(te, s)
    res.append(dict(model="STACK +RZ (LR+HGB+RF+XGB)", auc=auc(yte, s), top1=t1, top2=t2, brier=brier(yte, s)))

    res = [r for r in res if r]
    res.sort(key=lambda r: -r["auc"])
    base_auc = next(r["auc"] for r in res if "SHIPPED" in r["model"])
    print("\n" + "=" * 76)
    print(f"EXHAUSTIVE SWEEP  test=2024  ({len(te):,} preds, {te.game_id.nunique()} games)")
    print("=" * 76)
    print(f"{'#':>2} {'model':34s} {'AUC':>6} {'dAUC':>7} {'top1':>6} {'top2':>6} {'Brier':>7}")
    for i, r in enumerate(res, 1):
        d = r["auc"] - base_auc
        star = "  <<< SHIPPED" if "SHIPPED" in r["model"] else ("  ***" if d > 0.004 else "")
        print(f"{i:>2} {r['model']:34s} {r['auc']:>6.4f} {d:>+7.4f} {r['top1']:>6.1%} {r['top2']:>6.1%} {r['brier']:>7.4f}{star}")

    import json
    json.dump(res, open(os.path.join(HERE, "exhaustive_results.json"), "w"), indent=2)


if __name__ == "__main__":
    run()
