"""
Freeze the shipped team-stack model.

Three things go into src/lib/mlb-stacks-model.json:

  1. the run-scoring models — a runs regression that ranks the night's offences
     and three logistics for the team totals (over 3.5 / 4.5 / 5.5),
  2. the two correlations that make a stack a stack, fitted on 2024-25 with
     out-of-fold marginals and verified on 2026,
  3. the card's confidence tiers, cut on the held-out season.

Everything quoted in TEAM-STACKS.md is printed by this script. It also writes a
parity self-test the TypeScript pipeline checks on import, so the app and the
backtest cannot silently drift apart.
"""

import json
import os
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
PROPS_DATA = os.path.abspath(os.path.join(HERE, "..", "mlb-props", "data"))
APP_OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib",
                                       "mlb-stacks-model.json"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from bakeoff import apply_platt, auc, brier, logloss, platt, slate_topn  # noqa: E402
from features import BATTER_FEATURES  # noqa: E402

from copula import QMC_N, corr_matrix, orthant, orthant_many  # noqa: E402
from features_team import LG, TEAM_FEATURES, TEAM_MARKETS  # noqa: E402
from joint import fit_predict, fit_rho  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026
LABELS = {"r4": "Team total over 3.5", "r5": "Team total over 4.5",
          "r6": "Team total over 5.5"}


def calibration(p, y, edges=(0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01)):
    out = []
    for a, b in zip(edges, edges[1:]):
        m = (p >= a) & (p < b)
        if m.sum() < 50:
            continue
        out.append({"lo": a, "hi": b, "n": int(m.sum()),
                    "pred": float(p[m].mean()), "actual": float(y[m].mean())})
    return out


def tiers_for(p, y):
    """Cut the held-out picks where the hit rate actually separates."""
    order = np.argsort(-p)
    p, y = p[order], y[order]
    n = len(p)
    best = None
    for hi_q in (0.05, 0.08, 0.10, 0.15, 0.20):
        for lo_q in (0.35, 0.45, 0.55, 0.65):
            if lo_q <= hi_q:
                continue
            hi_n, lo_n = int(n * hi_q), int(n * lo_q)
            if hi_n < 200 or (n - lo_n) < 200:
                continue
            top, mid, bot = y[:hi_n].mean(), y[hi_n:lo_n].mean(), y[lo_n:].mean()
            if not (top > mid > bot):
                continue
            if best is None or (top - bot) > best[0]:
                best = (top - bot, p[hi_n - 1], p[lo_n - 1], top, mid, bot,
                        hi_n, lo_n - hi_n, n - lo_n)
    if best is None:
        return []
    _, hi_p, lo_p, top, mid, bot, n1, n2, n3 = best
    return [
        {"minProb": float(hi_p), "label": "Strong", "hitRate": float(top), "n": int(n1)},
        {"minProb": float(lo_p), "label": "Solid", "hitRate": float(mid), "n": int(n2)},
        {"minProb": 0.0, "label": "Lean", "hitRate": float(bot), "n": int(n3)},
    ]


def american(p):
    if p <= 0 or p >= 1:
        return None
    return round(-100 * p / (1 - p)) if p > 0.5 else round(100 * (1 - p) / p)


def main():
    tf = pd.read_csv(os.path.join(DATA, "team_features.csv"))
    bf = pd.read_csv(os.path.join(PROPS_DATA, "batter_features.csv"))
    tr = tf.season.isin(TRAIN).values
    te = (tf.season == TEST).values
    X = tf[TEAM_FEATURES].values.astype(float)
    dte = tf.date.values[te]
    print(f"team-games: train {tr.sum():,}  test {te.sum():,}\n")

    out = {}
    markets = {}
    for m in TEAM_MARKETS:
        y = tf[f"y_{m}"].values.astype(int)
        sc = StandardScaler().fit(X[tr])
        lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
        pb = platt(lr.predict_proba(sc.transform(X[tr]))[:, 1], y[tr])
        pte = apply_platt(lr.predict_proba(sc.transform(X[te]))[:, 1], pb)
        metrics = dict(auc=auc(y[te], pte), brier=brier(y[te], pte),
                       logloss=logloss(y[te], pte), base=float(y[te].mean()),
                       meanPred=float(pte.mean()),
                       top1=slate_topn(dte, y[te], pte, 1),
                       top3=slate_topn(dte, y[te], pte, 3),
                       top5=slate_topn(dte, y[te], pte, 5),
                       nTest=int(te.sum()), nTrain=int(tr.sum()))
        tiers = tiers_for(pte.copy(), y[te].copy())
        cal = calibration(pte, y[te])
        scA = StandardScaler().fit(X)
        lrA = LogisticRegression(max_iter=3000).fit(scA.transform(X), y)
        pbA = platt(lrA.predict_proba(scA.transform(X))[:, 1], y)
        markets[m] = dict(
            label=LABELS[m], line=int(m[1:]) - 0.5, features=TEAM_FEATURES,
            mean=scA.mean_.tolist(), std=scA.scale_.tolist(),
            coef=lrA.coef_[0].tolist(), intercept=float(lrA.intercept_[0]),
            plattA=float(pbA[0]), plattB=float(pbA[1]), base=float(y.mean()),
            tiers=tiers, metrics=metrics, calibration=cal,
            selftest=[{"x": X[i].tolist(),
                       "p": float(apply_platt(
                           lrA.predict_proba(scA.transform(X[i:i + 1]))[:, 1], pbA)[0])}
                      for i in (0, 1, 2)],
        )
        print(f"{m}  {LABELS[m]:22s} auc={metrics['auc']:.4f} base={metrics['base']:.3f} "
              f"top1={metrics['top1']:.3f} top5={metrics['top5']:.3f} "
              f"tiers={[round(t['hitRate'], 3) for t in tiers]}")

    # ------------------------------------------------- expected-runs ranker
    runs = tf.runs.values.astype(float)
    sc = StandardScaler().fit(X[tr])
    reg = LinearRegression().fit(sc.transform(X[tr]), runs[tr])
    pred = reg.predict(sc.transform(X[te]))
    d = pd.DataFrame({"d": dte, "p": pred, "r": runs[te]})
    tops = {n: float(d.groupby("d", group_keys=False)
                     .apply(lambda g: g.nlargest(n, "p").r.mean()).mean())
            for n in (1, 3, 5)}
    rho_s = float(pd.Series(pred).corr(pd.Series(runs[te]), method="spearman"))
    print(f"\nexpected runs: spearman {rho_s:.4f}  rmse "
          f"{np.sqrt(np.mean((pred - runs[te]) ** 2)):.3f}  "
          f"top1 {tops[1]:.2f}  top3 {tops[3]:.2f}  top5 {tops[5]:.2f}  "
          f"(slate mean {runs[te].mean():.2f})")
    scA = StandardScaler().fit(X)
    regA = LinearRegression().fit(scA.transform(X), runs)
    out["runs"] = dict(
        features=TEAM_FEATURES, mean=scA.mean_.tolist(), std=scA.scale_.tolist(),
        coef=regA.coef_.tolist(), intercept=float(regA.intercept_),
        metrics=dict(spearman=rho_s, rmse=float(np.sqrt(np.mean((pred - runs[te]) ** 2))),
                     slateMean=float(runs[te].mean()), top1=tops[1], top3=tops[3],
                     top5=tops[5], nTest=int(te.sum())),
        selftest=[{"x": X[i].tolist(),
                   "p": float(regA.predict(scA.transform(X[i:i + 1]))[0])}
                  for i in (0, 1, 2)],
    )

    # ---------------------------------------------- correlations and tiers
    p5_te, p5_oof, t_tr, t_te = fit_predict(tf, TEAM_FEATURES, "y_r5")
    tf["p_team5"] = np.nan
    tf.loc[t_te, "p_team5"] = p5_te
    tf.loc[t_tr, "p_team5"] = p5_oof
    # The slate ranking used below has to be honest, so test rows are ranked by
    # the model fitted on 2024-25 only; regA (refit on everything) is what gets
    # exported for tonight, never what grades 2026.
    tf["exp_runs"] = np.where(te, reg.predict(sc.transform(X)),
                              regA.predict(scA.transform(X)))
    tf["team_rank"] = tf.groupby("date").exp_runs.rank(ascending=False, method="first")

    own = ["own_tb2", "ownw_tb2"]
    ptb_te, ptb_oof, b_tr, b_te = fit_predict(bf, BATTER_FEATURES + own, "y_tb2")
    bf["p_tb2"] = np.nan
    bf.loc[b_te, "p_tb2"] = ptb_te
    bf.loc[b_tr, "p_tb2"] = ptb_oof

    j = bf.merge(tf[["gamePk", "team_id", "p_team5", "exp_runs", "team_rank",
                     "runs", "y_r4", "y_r5", "y_r6", "team"]],
                 on=["gamePk", "team_id"], how="inner")
    j = j[j.p_tb2.notna() & j.p_team5.notna()]
    j.to_csv(os.path.join(DATA, "joined.csv"), index=False)
    jtr, jte = j[j.season.isin(TRAIN)], j[j.season == TEST]

    def hitter_pairs(df, cap=250000):
        rows = []
        for _, tt in df.groupby(["gamePk", "team_id"], sort=False):
            pv, yv = tt.p_tb2.values, tt.y_tb2.values
            for i in range(len(pv)):
                for k in range(i + 1, len(pv)):
                    rows.append(dict(p=np.array([pv[i], pv[k]]),
                                     hit=int(yv[i] == 1 and yv[k] == 1)))
        if cap and len(rows) > cap:
            idx = np.random.RandomState(0).choice(len(rows), cap, replace=False)
            rows = [rows[i] for i in idx]
        return rows

    def team_hitter_pairs(df):
        return [dict(p=np.array([r.p_team5, r.p_tb2]),
                     hit=int(r.y_r5 == 1 and r.y_tb2 == 1))
                for r in df.itertuples()]

    rho_hh, o_hh, m_hh = fit_rho(hitter_pairs(jtr))
    rho_th, o_th, m_th = fit_rho(team_hitter_pairs(jtr))
    print(f"\ncorrelations fitted on {TRAIN[0]}-{TRAIN[1]}:")
    print(f"  hitter-hitter (same lineup) rho = {rho_hh:.4f}")
    print(f"  team total  x  hitter       rho = {rho_th:.4f}")

    ver = {}
    for name, rows, rho in (("hitter_pairs", hitter_pairs(jte, cap=None), rho_hh),
                            ("team_hitter", team_hitter_pairs(jte), rho_th)):
        P = np.array([r["p"] for r in rows])
        obs = float(np.mean([r["hit"] for r in rows]))
        ind = float(P.prod(axis=1).mean())
        R = np.array([[1.0, rho], [rho, 1.0]])
        mod = float(orthant_many(P, R).mean())
        ver[name] = dict(observed=obs, independence=ind, model=mod, n=len(rows),
                         indepError=ind / obs - 1, modelError=mod / obs - 1)
        print(f"  2026 {name:12s} observed {obs:.4f}  independence {ind:.4f} "
              f"({ind/obs-1:+.1%})  model {mod:.4f} ({mod/obs-1:+.1%})  n={len(rows):,}")

    # three legs: team total + its two best bats, priced with the full matrix
    R3 = corr_matrix(2, True, rho_hh, rho_th)
    tri = []
    for _, gg in jte.groupby(["gamePk", "team_id"], sort=False):
        g2 = gg.nlargest(2, "p_tb2")
        if len(g2) < 2:
            continue
        tri.append(dict(p=np.array([g2.p_team5.iloc[0], *g2.p_tb2.values]),
                        hit=int(g2.y_r5.iloc[0] == 1 and g2.y_tb2.sum() == 2)))
    P3 = np.array([t["p"] for t in tri])
    obs3 = float(np.mean([t["hit"] for t in tri]))
    ind3 = float(P3.prod(axis=1).mean())
    mod3 = float(orthant_many(P3, R3).mean())
    ver["team_plus_two"] = dict(observed=obs3, independence=ind3, model=mod3,
                                n=len(tri), indepError=ind3 / obs3 - 1,
                                modelError=mod3 / obs3 - 1)
    print(f"  2026 team+2 bats  observed {obs3:.4f}  independence {ind3:.4f} "
          f"({ind3/obs3-1:+.1%})  model {mod3:.4f} ({mod3/obs3-1:+.1%})  n={len(tri):,}")

    # ------------------------------------------------------- the card tiers
    R2 = np.array([[1.0, rho_th], [rho_th, 1.0]])
    card = jte.copy()
    card["p_card"] = orthant_many(card[["p_team5", "p_tb2"]].values, R2)
    card["y_card"] = card.y_r5.astype(int) * card.y_tb2.astype(int)
    card["p_indep"] = card.p_team5 * card.p_tb2
    ctiers = tiers_for(card.p_card.values.copy(), card.y_card.values.copy())
    print("\ncard tiers (team total over 4.5 + a hitter off that lineup, 2+ TB):")
    for t in ctiers:
        m = card[card.p_card >= t["minProb"]] if t["label"] == "Strong" else None
        print(f"  {t['label']:7s} n={t['n']:6,}  hit {t['hitRate']:.4f}  "
              f"breakeven {american(t['hitRate']):+d}")
    dailies = {f"top{n}": float(card.sort_values("p_card", ascending=False)
                                .groupby("date").head(n).y_card.mean())
               for n in (1, 3, 5)}
    print(f"  day's best card: top1 {dailies['top1']:.3f}  "
          f"top3 {dailies['top3']:.3f}  top5 {dailies['top5']:.3f}")

    # gating 2+ TB picks on the night's biggest offences
    gate = {f"top{n}": float(jte[jte.team_rank <= n].y_tb2.mean()) for n in (1, 3, 5, 8)}
    gate["all"] = float(jte.y_tb2.mean())
    print(f"\n2+ TB hit rate — all hitters {gate['all']:.3f}, on the night's "
          f"top-1 offence {gate['top1']:.3f}, top-3 {gate['top3']:.3f}, "
          f"top-5 {gate['top5']:.3f}")

    out["markets"] = markets
    out["correlation"] = dict(
        hitterHitter=rho_hh, teamHitter=rho_th, qmcPoints=QMC_N,
        verification=ver,
        note="Gaussian copula; marginals are unchanged, only the joint moves.",
    )
    out["card"] = dict(tiers=ctiers, daily=dailies,
                       nTest=int(len(card)), base=float(card.y_card.mean()))
    out["gate"] = gate
    out["constants"] = dict(K_G=20.0, K_PA=1500.0, K_BF=300.0, K_OUT=250.0,
                            WINDOW_DAYS=30, LG=LG)
    out["trainedThrough"] = TEST
    out["notes"] = ("Team run-scoring logistics + a runs regression over "
                    "season-to-date, 30-day and prior-season team rates, the "
                    "opposing starter and bullpen, and the park. Stacks are "
                    "priced with a Gaussian copula whose two correlations were "
                    "fitted on 2024-25 and verified on 2026.")
    # copula parity: the app checks these three on import
    out["copulaSelftest"] = [
        {"p": [0.42, 0.35], "rho": rho_th, "team": True,
         "want": float(orthant([0.42, 0.35], R2))},
        {"p": [0.42, 0.35, 0.31], "rho": rho_hh, "team": False,
         "want": float(orthant([0.42, 0.35, 0.31],
                               corr_matrix(3, False, rho_hh, rho_th)))},
        {"p": [0.44, 0.42, 0.35], "rho": None, "team": True,
         "want": float(orthant([0.44, 0.42, 0.35], R3))},
    ]

    json.dump(out, open(os.path.join(HERE, "stacks_model.json"), "w"), indent=1)
    json.dump(out, open(APP_OUT, "w"), indent=1)
    print(f"\nexported -> {APP_OUT}")


if __name__ == "__main__":
    main()
