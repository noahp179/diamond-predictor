"""
Statcast premium-feature experiment — the MLB analog of the NFL red-zone test.

Does batted-ball QUALITY (Statcast barrel rate, expected ISO / wOBA) beat plain
box-score power for predicting home runs? We add each batter's PRIOR full season
Statcast profile (leak-free) to the model and see if AUC / top-k improve.
"""
import io, os, warnings
import numpy as np
import pandas as pd
import requests
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

import exhaustive_mlb as E

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))


def savant(url):
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    return pd.read_csv(io.StringIO(r.text))


def statcast_year(year):
    xs = savant(f"https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year={year}&min=50&csv=true")
    xs["xiso"] = xs["est_slg"] - xs["est_ba"]
    xs = xs.rename(columns={"est_woba": "xwoba"})[["player_id", "xiso", "xwoba"]]
    bl = savant(f"https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year={year}&min=50&csv=true")
    bl = bl.rename(columns={"brl_pa": "brl_pa", "avg_hit_speed": "ev"})[["player_id", "brl_pa", "ev"]]
    m = xs.merge(bl, on="player_id", how="outer")
    m["year"] = year
    return m


def main():
    print("Fetching Statcast leaderboards (2022, 2023) ...")
    sc = pd.concat([statcast_year(2022), statcast_year(2023)], ignore_index=True)
    sc["player_id"] = sc.player_id.astype(str)
    print(f"  Statcast batter-seasons: {len(sc)}")

    df = E.build()
    df["batter_id"] = df.batter_id.astype(str)
    df["prior_year"] = df.season - 1
    df = df.merge(sc, left_on=["batter_id", "prior_year"], right_on=["player_id", "year"], how="left")
    med = df[["xiso", "xwoba", "brl_pa", "ev"]].median()
    for c in ["xiso", "xwoba", "brl_pa", "ev"]:
        df[c] = df[c].fillna(med[c])
    cov = df.assign(has=df.player_id.notna()).groupby("season").has.mean()
    print("prior-season Statcast coverage by season:", {int(k): round(v, 2) for k, v in cov.items()})

    tr, te = df[df.season == 2023], df[df.season == 2024]
    ytr, yte = tr.scored.values, te.scored.values
    SC = ["xiso", "xwoba", "brl_pa", "ev"]

    def evl(name, feats):
        m = make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)).fit(tr[feats].values, ytr)
        p = m.predict_proba(te[feats].values)[:, 1]
        pk = E.picks(te, p)
        return dict(model=name, auc=E.auc(yte, p), top1=pk[1], top3=pk[3], top5=pk[5], brier=E.brier(yte, p))

    rows = [
        evl("box-score model (BASELINE)", E.FEATURES),
        evl("+ Statcast (barrel/xISO/xwOBA)", E.FEATURES + SC),
        evl("Statcast-only (no box power)", [f for f in E.FEATURES if f not in ("career_hr_rate", "iso", "ewma_hr_rate")] + SC),
    ]
    base = rows[0]["auc"]
    print(f"\n{'model':34s} {'AUC':>7} {'dAUC':>7} {'top1':>6} {'top3':>6} {'top5':>6}")
    for r in rows:
        print(f"{r['model']:34s} {r['auc']:>7.4f} {r['auc']-base:>+7.4f} {r['top1']:>6.1%} {r['top3']:>6.1%} {r['top5']:>6.1%}")

    sc_ = StandardScaler().fit(tr[E.FEATURES + SC]); lr = LogisticRegression(max_iter=3000).fit(sc_.transform(tr[E.FEATURES + SC]), ytr)
    print("\ndrivers with Statcast:", {k: round(v, 3) for k, v in sorted(zip(E.FEATURES + SC, lr.coef_[0]), key=lambda kv: -abs(kv[1]))[:8]})


if __name__ == "__main__":
    main()
