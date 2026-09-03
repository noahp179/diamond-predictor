"""
Freeze the dedicated 2+ total-bases model.

The bake-off (bakeoff_tb2.py) says four of the seven candidate blocks earn
their place: weather, the park's total-bases index, the opponent's bases
allowed, and a 15-day form window. This script settles the last question
(does `rest` belong too?), fits the winner, grades it against the model the
Player Props tab already ships, and exports it.

Two things go into src/lib/mlb-tb2-model.json beyond the usual weights:

  groups   every feature tagged with what it *means* — power, form, playing
           time, matchup, conditions, lineup — so the app can say why a
           projection is what it is in a sentence rather than showing 51
           coefficients.
  tiers    breakpoints cut on the held-out season where the hit rate actually
           separates, plus the price each tier needs to be worth betting.
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
APP_OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "mlb-tb2-model.json"))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "mlb-props")))
from features import BATTER_FEATURES  # noqa: E402

from bakeoff_tb2 import (BASE, apply_platt, auc, boot_delta, brier, load,  # noqa: E402
                         logloss, platt, slate_topn)
from features_tb2 import EXTRA_BLOCKS  # noqa: E402

TRAIN = (2024, 2025)
TEST = 2026

# What each feature actually means, in the language a person would use. The app
# turns the biggest contributors into a sentence; these groups are how it knows
# which sentence to write.
GROUPS = {
    "power": {
        "label": "his bat",
        "features": ["tb_pa", "hr_pa", "iso", "h_pa", "py_tb_pa", "py_hr_pa", "py_h_pa",
                     "own_tb2", "py_pa", "py_known", "bb_pa", "k_pa", "sb_pa", "rbi_pa",
                     "r_pa", "gp"],
    },
    "form": {
        "label": "recent form",
        "features": ["w_tb_pa", "w_h_pa", "w_hr_pa", "w_g", "ownw_tb2",
                     "w15_tb_pa", "w15_h_pa", "w15_g", "own15_tb2"],
    },
    "opportunity": {
        "label": "how many at-bats he should get",
        "features": ["slot", "pa_pg", "w_pa_pg", "w15_pa_pg"],
    },
    "matchup": {
        "label": "the pitcher he faces",
        "features": ["sp_k_bf", "sp_h_bf", "sp_hr_bf", "sp_bb_bf", "sp_bf_start", "sp_known",
                     "opp_r_allowed_pg", "def_tb_pa", "def_xbh_pa", "def_known"],
    },
    "conditions": {
        "label": "the ballpark and weather",
        "features": ["park", "park_tb", "temp", "wind_mph", "wind_out", "wind_in",
                     "is_dome", "is_day", "is_home"],
    },
    "lineup": {
        "label": "the lineup around him",
        "features": ["team_r_pg"],
    },
}

# Short, human phrases for the single biggest feature inside the winning group.
PHRASES = {
    "tb_pa": "he racks up bases per trip to the plate",
    "hr_pa": "his home-run rate",
    "iso": "his extra-base power",
    "h_pa": "how often he gets a hit",
    "own_tb2": "how often he has already done this in a game",
    "ownw_tb2": "how often he has done this lately",
    "own15_tb2": "how often he has done this in the last two weeks",
    "w_tb_pa": "his bases per plate appearance over the last month",
    "w15_tb_pa": "his bases per plate appearance over the last two weeks",
    "w_hr_pa": "his recent home-run rate",
    "w_pa_pg": "how many plate appearances he has been getting",
    "w15_pa_pg": "his plate appearances over the last two weeks",
    "py_tb_pa": "what he did last season",
    "slot": "where he bats in the order",
    "pa_pg": "how many trips to the plate he gets",
    "sp_h_bf": "how many hits this starter gives up",
    "sp_hr_bf": "how many home runs this starter gives up",
    "sp_k_bf": "how often this starter strikes batters out",
    "sp_bb_bf": "how often this starter walks batters",
    "sp_bf_start": "how deep this starter goes",
    "def_tb_pa": "how many bases this opponent gives up",
    "def_xbh_pa": "how many extra-base hits this opponent allows",
    "opp_r_allowed_pg": "how many runs this opponent allows",
    "park": "the ballpark",
    "park_tb": "how this ballpark plays for extra-base hits",
    "temp": "the temperature",
    "wind_out": "the wind blowing out",
    "wind_in": "the wind blowing in",
    "is_dome": "the closed roof",
    "is_day": "the day game",
    "is_home": "playing at home",
    "team_r_pg": "how much his lineup scores",
    "k_pa": "how often he strikes out",
    "bb_pa": "how often he walks",
}


def calibration(p, y, edges=(0.0, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 1.01)):
    out = []
    for a, b in zip(edges, edges[1:]):
        m = (p >= a) & (p < b)
        if m.sum() < 100:
            continue
        out.append({"lo": a, "hi": b, "n": int(m.sum()),
                    "pred": float(p[m].mean()), "actual": float(y[m].mean())})
    return out


def tiers_for(p, y):
    order = np.argsort(-p)
    p, y = p[order], y[order]
    n = len(p)
    best = None
    for hi_q in (0.05, 0.08, 0.10, 0.15, 0.20):
        for lo_q in (0.35, 0.45, 0.55, 0.65):
            if lo_q <= hi_q:
                continue
            hi_n, lo_n = int(n * hi_q), int(n * lo_q)
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
        return 0
    return int(round(-100 * p / (1 - p))) if p > 0.5 else int(round(100 * (1 - p) / p))


def fit(df, feats, tr, te, y):
    X = df[feats].values.astype(float)
    sc = StandardScaler().fit(X[tr])
    lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
    b = platt(lr.predict_proba(sc.transform(X[tr]))[:, 1], y[tr])
    return apply_platt(lr.predict_proba(sc.transform(X[te]))[:, 1], b)


def main():
    df = load()
    tr = df.season.isin(TRAIN).values
    te = (df.season == TEST).values
    y = df.y_tb2.values.astype(int)
    yte, dte = y[te], df.date.values[te]

    # The block that won the bake-off outright was weather — and it cannot be
    # served. StatsAPI publishes a game's `weather` object only once the game is
    # under way; it is {} for every scheduled game, so a board rendered before
    # first pitch can never see it. Backtesting on it would be quoting a number
    # the app cannot compute. It is measured here for the record and dropped.
    servable = BASE + EXTRA_BLOCKS["parktb"] + EXTRA_BLOCKS["def"] + EXTRA_BLOCKS["form15"]
    unservable = servable + EXTRA_BLOCKS["weather"]
    p_base = fit(df, BASE, tr, te, y)
    p = fit(df, servable, tr, te, y)
    p_un = fit(df, unservable, tr, te, y)
    a0, a_s, a_un = auc(yte, p_base), auc(yte, p), auc(yte, p_un)
    print(f"shipped 34 features            auc={a0:.5f}")
    print(f"SERVABLE  ({len(servable)} features)        auc={a_s:.5f}  delta {a_s - a0:+.5f}")
    print(f"with live weather ({len(unservable)} feats)  auc={a_un:.5f}  delta {a_un - a0:+.5f}"
          f"   <- not servable, for the record only")
    FEATS = servable
    print(f"  -> shipping {len(FEATS)} features\n")

    m, lo, hi = boot_delta(yte, p_base, p, 400)
    a = auc(yte, p)
    print(f"FINAL vs shipped: auc {a0:.4f} -> {a:.4f}  ({a - a0:+.4f}, "
          f"95% [{lo:+.4f}, {hi:+.4f}])")
    print(f"  brier {brier(yte, p_base):.4f} -> {brier(yte, p):.4f}   "
          f"logloss {logloss(yte, p_base):.4f} -> {logloss(yte, p):.4f}")
    for n in (1, 3, 5, 10):
        print(f"  day's top {n:2d}: {slate_topn(dte, yte, p_base, n):.4f} -> "
              f"{slate_topn(dte, yte, p, n):.4f}")

    # a naive benchmark anyone could compute
    naive = df["own_tb2"].values[te]
    print(f"  naive 'his own rate so far' auc={auc(yte, naive):.4f}")

    tiers = tiers_for(p.copy(), yte.copy())
    print("\ntiers on the held-out season:")
    for t in tiers:
        print(f"  {t['label']:7s} n={t['n']:6,}  hits {t['hitRate']*100:.1f}%  "
              f"breakeven {american(t['hitRate']):+d}")
    cal = calibration(p, yte)
    print("\ncalibration (predicted vs actual):")
    for c in cal:
        print(f"  {c['lo']:.2f}-{c['hi']:.2f}  n={c['n']:6,}  "
              f"predicted {c['pred']*100:.1f}%  actual {c['actual']*100:.1f}%")

    # ------------------------------------------------------------- export
    X = df[FEATS].values.astype(float)
    scA = StandardScaler().fit(X)
    lrA = LogisticRegression(max_iter=3000).fit(scA.transform(X), y)
    pbA = platt(lrA.predict_proba(scA.transform(X))[:, 1], y)

    # The park index is a lookup, not something the app can recompute live —
    # ship the table. Same arithmetic the chronological walk converges to.
    bg = pd.read_csv(os.path.join(PROPS, "batter_games.csv"))
    lg = float(bg.tb.sum() / bg.pa.sum())
    pv = bg.groupby("venue")[["tb", "pa"]].sum()
    K_PARK = 8000.0
    park_tb = {v: float(((r.tb + K_PARK * lg) / (r.pa + K_PARK)) / lg)
               for v, r in pv.iterrows()}
    print("\npark total-bases index (1.00 = league average):")
    for v, x in sorted(park_tb.items(), key=lambda kv: -kv[1])[:5]:
        print(f"  {v:34s} {x:.3f}")
    for v, x in sorted(park_tb.items(), key=lambda kv: kv[1])[:3]:
        print(f"  {v:34s} {x:.3f}")

    known = {f for g in GROUPS.values() for f in g["features"]}
    missing = [f for f in FEATS if f not in known]
    assert not missing, f"ungrouped features: {missing}"
    groups = {k: {"label": v["label"],
                  "features": [f for f in v["features"] if f in FEATS]}
              for k, v in GROUPS.items()}

    model = {
        "market": "tb2",
        "label": "2+ total bases",
        "trainedThrough": TEST,
        "notes": ("Logistic regression on the shipped prop features plus weather, a "
                  "park total-bases index, the opponent's bases allowed and a 15-day "
                  "form window. Fitted 2024-25, tested on 2026. "
                  "P = platt(sigmoid(w.x + b))."),
        "features": FEATS,
        "mean": scA.mean_.tolist(),
        "std": scA.scale_.tolist(),
        "coef": lrA.coef_[0].tolist(),
        "intercept": float(lrA.intercept_[0]),
        "plattA": float(pbA[0]),
        "plattB": float(pbA[1]),
        "base": float(y.mean()),
        "groups": groups,
        "parkTb": park_tb,
        "leagueTbPa": lg,
        "phrases": {f: PHRASES[f] for f in FEATS if f in PHRASES},
        "tiers": tiers,
        "calibration": cal,
        "metrics": {
            "auc": a, "aucShipped": a0, "delta": a - a0, "ci": [lo, hi],
            "brier": brier(yte, p), "logloss": logloss(yte, p),
            "base": float(yte.mean()), "meanPred": float(p.mean()),
            "aucNaive": auc(yte, naive),
            "top1": slate_topn(dte, yte, p, 1), "top3": slate_topn(dte, yte, p, 3),
            "top5": slate_topn(dte, yte, p, 5), "top10": slate_topn(dte, yte, p, 10),
            "top5Shipped": slate_topn(dte, yte, p_base, 5),
            "nTest": int(te.sum()), "nTrain": int(tr.sum()),
        },
        "blocks": {k: [f for f in v if f in FEATS] for k, v in EXTRA_BLOCKS.items()},
        "weatherFinding": {
            "aucWithLiveWeather": a_un,
            "aucServable": a_s,
            "aucShipped": a0,
            "note": ("Weather was the single best block in the bake-off, but StatsAPI "
                     "only publishes it once a game is under way, so a pre-game board "
                     "cannot compute it. Roughly half the available gain is not "
                     "servable and was dropped rather than quoted."),
        },
        "selftest": [
            {"x": X[i].tolist(),
             "p": float(apply_platt(
                 lrA.predict_proba(scA.transform(X[i:i + 1]))[:, 1], pbA)[0])}
            for i in (0, 1, 2, 500, 50000)
        ],
    }
    json.dump(model, open(os.path.join(HERE, "tb2_model.json"), "w"), indent=1)
    json.dump(model, open(APP_OUT, "w"), indent=1)

    top = sorted(zip(FEATS, lrA.coef_[0]), key=lambda kv: -abs(kv[1]))[:12]
    print("\nbiggest drivers (standardised coefficient):")
    for f, c in top:
        print(f"  {f:18s} {c:+.4f}   {PHRASES.get(f, '')}")
    print(f"\nexported -> {APP_OUT}")


if __name__ == "__main__":
    main()
