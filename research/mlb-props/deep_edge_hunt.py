"""
Deep hunt for a pre-game miss signal, using information the models have never seen.

MISS-ANALYSIS.md showed that re-slicing the model's own features finds nothing —
which is what calibration means. So this brings in outside information and throws
everything at it:

  NEW DATA      platoon handedness, temperature, sky condition, wind speed and
                direction, roof type (open / dome / retractable-closed), the
                home-plate umpire, opponent bullpen fatigue, travel distance,
                day vs night.
  DESIGN        prop models refit on 2024 ONLY, so 2025 and 2026 are both fully
                out of sample. Discover on 2025, confirm on 2026. A finding has
                to appear twice, with the sign intact, to count.
  ALGORITHMS    13 learners plus exhaustive 1- and 2-condition rule mining, all
                asked the same question: can you beat "trust the published
                probability" at predicting a miss?

Usage: python3 deep_edge_hunt.py
"""

import itertools
import json
import os
import warnings
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesClassifier, GradientBoostingClassifier,
                              HistGradientBoostingClassifier, RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier, export_text

from features import BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES, PITCHER_MARKETS

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TRAIN_SEASON, DISCOVER, CONFIRM = 2024, 2025, 2026
HIGH_BAR = 0.70
RNG = 0


# --------------------------------------------------------------------- utils
def boot_mean(x, n=2000, seed=0):
    x = np.asarray(x, float)
    if len(x) < 25:
        return (float(np.mean(x)) if len(x) else np.nan), np.nan, np.nan
    rng = np.random.default_rng(seed)
    d = rng.choice(x, (n, len(x)), replace=True).mean(axis=1)
    return float(x.mean()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    o = p.argsort(); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    r = pd.DataFrame({"p": p, "r": r}).groupby("p").r.transform("mean").values
    n1 = y.sum(); n0 = len(y) - n1
    return float("nan") if n1 == 0 or n0 == 0 else float(
        (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def haversine(a_lat, a_lon, b_lat, b_lon):
    if any(pd.isna(v) for v in (a_lat, a_lon, b_lat, b_lon)):
        return np.nan
    r = 3958.8
    p1, p2 = np.radians(a_lat), np.radians(b_lat)
    dp, dl = p2 - p1, np.radians(b_lon - a_lon)
    h = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return float(2 * r * np.arcsin(np.sqrt(h)))


# ------------------------------------------------------------------ context
def context_frames():
    ctx = pd.read_csv(os.path.join(DATA, "game_context.csv"))
    ven = pd.read_csv(os.path.join(DATA, "venues.csv"))
    hands = pd.read_csv(os.path.join(DATA, "player_hands.csv"))
    ctx = ctx.merge(ven[["venue_id", "roof", "lat", "lon"]], on="venue_id", how="left")

    ctx["indoors"] = ctx.condition.isin(["Dome", "Roof Closed"]).astype(int)
    ctx["retract_open"] = ((ctx.roof == "Retractable") & (ctx.indoors == 0)).astype(int)
    ctx["is_night"] = (ctx.day_night == "night").astype(int)
    ctx["precip"] = ctx.condition.isin(["Rain", "Drizzle", "Showers"]).astype(int)
    ctx["sunny"] = ctx.condition.isin(["Sunny", "Clear"]).astype(int)
    # Wind relative to the hitter: out = carries the ball, in = kills it.
    ctx["wind_out"] = ctx.wind_dir.fillna("").str.startswith("Out").astype(int)
    ctx["wind_in"] = ctx.wind_dir.fillna("").str.startswith("In").astype(int)
    ctx["wind_signed"] = ctx.wind_mph.fillna(0) * (ctx.wind_out - ctx.wind_in)
    ctx.loc[ctx.indoors == 1, ["wind_mph", "wind_signed", "wind_out", "wind_in"]] = 0
    ctx["temp"] = ctx.temp.replace(0, np.nan)

    # travel: distance from each team's previous game venue, and days of rest
    meta = pd.read_csv(os.path.join(DATA, "game_meta.csv"))
    meta = meta.merge(ctx[["gamePk", "lat", "lon"]], on="gamePk", how="left")
    meta = meta.sort_values("date")
    last = {}
    trav = []
    for r in meta.itertuples():
        for team, side in ((r.home, "home"), (r.away, "away")):
            prev = last.get(team)
            d = haversine(prev[0], prev[1], r.lat, r.lon) if prev else np.nan
            trav.append(dict(gamePk=r.gamePk, team_id=team, side=side, travel_mi=d))
            last[team] = (r.lat, r.lon)
    travel = pd.DataFrame(trav)

    # bullpen fatigue: batters faced by relievers over the previous 3 days
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    rel = pg[pg.is_starter == 0].groupby(["team_id", "date"]).bf.sum().reset_index()
    rel["d"] = pd.to_datetime(rel.date)
    fatigue = {}
    for team, g in rel.groupby("team_id"):
        g = g.sort_values("d")
        for r in g.itertuples():
            window = g[(g.d < r.d) & (g.d >= r.d - pd.Timedelta(days=3))]
            fatigue[(team, r.date)] = float(window.bf.sum())
    return ctx, hands, travel, fatigue


# ------------------------------------------------------- model, refit on 2024
def refit_and_predict(df, generic, markets, kind):
    """Fit each market on 2024 only; return 2025+2026 rows with probabilities."""
    out = []
    tr = df.season == TRAIN_SEASON
    te = df.season.isin([DISCOVER, CONFIRM])
    for mk in markets:
        feats = generic + [f"own_{mk}", f"ownw_{mk}"]
        X = df[feats].values.astype(float)
        y = df[f"y_{mk}"].values.astype(int)
        sc = StandardScaler().fit(X[tr])
        lr = LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]), y[tr])
        p = lr.predict_proba(sc.transform(X[te]))[:, 1]
        d = df[te].copy()
        d["market"], d["kind"], d["p"], d["y"] = mk, kind, p, y[te]
        out.append(d)
    return pd.concat(out, ignore_index=True)


def build():
    ctx, hands, travel, fatigue = context_frames()
    bats = hands.set_index("player_id").bats.to_dict()
    throws = hands.set_index("player_id").throws.to_dict()

    bf = pd.read_csv(os.path.join(DATA, "batter_features.csv"))
    bg = pd.read_csv(os.path.join(DATA, "batter_games.csv"))[
        ["gamePk", "batter_id", "opp_sp", "pa", "team_id", "opp_team"]]
    bf = bf.merge(bg, on=["gamePk", "batter_id"], how="left", suffixes=("", "_g"))
    B = refit_and_predict(bf, BATTER_FEATURES, list(BATTER_MARKETS), "batter")
    B["bats"] = B.batter_id.map(bats)
    B["opp_throws"] = B.opp_sp.map(throws)
    B["subject_id"] = B.batter_id

    pf = pd.read_csv(os.path.join(DATA, "pitcher_features.csv"))
    pg = pd.read_csv(os.path.join(DATA, "pitcher_games.csv"))
    pg = pg[pg.is_starter == 1][["gamePk", "pitcher_id", "outs", "opp_team"]]
    pf = pf.merge(pg, on=["gamePk", "pitcher_id"], how="left", suffixes=("", "_g"))
    P = refit_and_predict(pf, PITCHER_FEATURES, list(PITCHER_MARKETS), "pitcher")
    P["throws"] = P.pitcher_id.map(throws)
    P["subject_id"] = P.pitcher_id

    # opposing lineup's share of left-handed bats, for the pitcher side
    bgh = pd.read_csv(os.path.join(DATA, "batter_games.csv"))[
        ["gamePk", "batter_id", "team_id", "slot"]]
    bgh = bgh[(bgh.slot >= 1) & (bgh.slot <= 9)]
    bgh["bats"] = bgh.batter_id.map(bats)
    lhb = (bgh.assign(l=(bgh.bats == "L").astype(int) + 0.5 * (bgh.bats == "S").astype(int))
           .groupby(["gamePk", "team_id"]).l.mean().reset_index()
           .rename(columns={"team_id": "opp_team", "l": "opp_lhb_share"}))
    P = P.merge(lhb, on=["gamePk", "opp_team"], how="left")

    df = pd.concat([B, P], ignore_index=True)
    df = df.merge(ctx.drop(columns=["date", "venue"], errors="ignore"), on="gamePk", how="left")

    # platoon: does the batter have the handedness edge?
    def platoon(r):
        b, t = r.bats, r.opp_throws
        if not isinstance(b, str) or not isinstance(t, str):
            return "unknown"
        if b == "S":
            return "switch"
        return f"{b}v{t}"
    df["platoon"] = df.apply(platoon, axis=1) if "bats" in df else "unknown"
    df["has_edge"] = df.platoon.isin(["LvR", "RvL", "switch"]).astype(int)
    df["same_hand"] = df.platoon.isin(["LvL", "RvR"]).astype(int)

    tv = travel.rename(columns={"team_id": "team_id_j"})
    df = df.merge(tv[["gamePk", "team_id_j", "travel_mi"]],
                  left_on=["gamePk", "team_id"], right_on=["gamePk", "team_id_j"], how="left")
    df["pen_fatigue"] = [fatigue.get((t, d), np.nan)
                         for t, d in zip(df.get("opp_team", pd.Series(index=df.index)), df.date)]

    df["miss"] = 1 - df.y
    df["resid"] = df.y - df.p
    return df


# ----------------------------------------------- 1. new-information residuals
FAMILIES = {
    "platoon (batters)": ("batter", "platoon", None),
    "same-handed matchup (batters)": ("batter", "same_hand", None),
    "indoors / roof closed": (None, "indoors", None),
    "temperature": (None, "temp", [0, 55, 65, 75, 85, 200]),
    "wind, signed out-minus-in": (None, "wind_signed", [-30, -8, -3, 3, 8, 30]),
    "wind speed": (None, "wind_mph", [-1, 3, 7, 11, 40]),
    "precipitation": (None, "precip", None),
    "day game": (None, "is_night", None),
    "travel miles since last game": (None, "travel_mi", [-1, 1, 300, 800, 1500, 9999]),
    "opponent bullpen BF, last 3 days": (None, "pen_fatigue", [-1, 20, 35, 50, 999]),
    "opposing lineup LHB share (pitchers)": ("pitcher", "opp_lhb_share", [0, .3, .45, .6, 1.1]),
}


def family_scan(df, season, label):
    print(f"\n{'=' * 84}\n{label}\n{'=' * 84}")
    rows = []
    d0 = df[(df.season == season) & (df.p >= HIGH_BAR)]
    for name, (kind, col, edges) in FAMILIES.items():
        d = d0 if kind is None else d0[d0.kind == kind]
        if col not in d.columns or d[col].notna().sum() < 200:
            continue
        d = d[d[col].notna()]
        if edges is None:
            groups = [(str(v), d[d[col] == v]) for v in sorted(d[col].unique())]
        else:
            b = pd.cut(d[col], edges)
            groups = [(str(iv), d[b == iv]) for iv in b.cat.categories]
        cells = []
        for lbl, s in groups:
            if len(s) < 60:
                continue
            m, lo, hi = boot_mean(s.resid.values)
            cells.append((lbl, len(s), m, lo, hi, s.p.mean(), s.y.mean()))
        if len(cells) < 2:
            continue
        spread = max(c[2] for c in cells) - min(c[2] for c in cells)
        sig = [c for c in cells if not np.isnan(c[3]) and (c[3] > 0 or c[4] < 0)]
        print(f"\n{name}   (spread {spread:.3f}{', SIGNIFICANT CELLS' if sig else ''})")
        print(f"  {'bucket':>22} {'n':>6} {'stated':>7} {'actual':>7} {'residual':>9} {'95% CI':>20}")
        for lbl, n, m, lo, hi, pm, ym in cells:
            star = " *" if (not np.isnan(lo) and (lo > 0 or hi < 0)) else ""
            print(f"  {lbl:>22} {n:>6,} {pm:>7.3f} {ym:>7.3f} {m:>+9.3f}  [{lo:+.3f}, {hi:+.3f}]{star}")
            rows.append(dict(family=name, bucket=lbl, season=season, n=n, resid=m, lo=lo, hi=hi))
    return pd.DataFrame(rows)


def replication(disc, conf):
    print(f"\n{'=' * 84}\nREPLICATION — does a {DISCOVER} finding survive in {CONFIRM}?\n{'=' * 84}")
    m = disc.merge(conf, on=["family", "bucket"], suffixes=("_d", "_c"))
    m["sig_d"] = (m.lo_d > 0) | (m.hi_d < 0)
    m["same_sign"] = np.sign(m.resid_d) == np.sign(m.resid_c)
    m["sig_c"] = (m.lo_c > 0) | (m.hi_c < 0)
    print(f"  {'family':>38} {'bucket':>16} {DISCOVER:>9} {CONFIRM:>9}  verdict")
    for r in m.sort_values("resid_d").itertuples():
        if not r.sig_d:
            continue
        verdict = ("REPLICATES" if r.sig_c and r.same_sign else
                   "same sign only" if r.same_sign else "flips sign")
        print(f"  {r.family[:38]:>38} {str(r.bucket)[:16]:>16} "
              f"{r.resid_d:>+9.3f} {r.resid_c:>+9.3f}  {verdict}")
    n_sig = int(m.sig_d.sum())
    n_rep = int((m.sig_d & m.sig_c & m.same_sign).sum())
    print(f"\n  {n_sig} cells significant in {DISCOVER}; {n_rep} of them replicate in {CONFIRM}.")
    print(f"  ({len(m)} cells tested; ~{0.05 * len(m):.0f} false positives expected per season)")
    return m


# ----------------------------------------------------- 2. the algorithm sweep
def zoo():
    return {
        "logistic L2": make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "logistic L1": make_pipeline(StandardScaler(), LogisticRegression(
            penalty="l1", solver="liblinear", C=0.3, max_iter=3000)),
        "elastic net": make_pipeline(StandardScaler(), LogisticRegression(
            penalty="elasticnet", solver="saga", l1_ratio=0.5, C=0.3, max_iter=2000)),
        "gaussian NB": make_pipeline(StandardScaler(), GaussianNB()),
        "kNN (k=100)": make_pipeline(StandardScaler(), KNeighborsClassifier(100, n_jobs=-1)),
        "SVM (rbf)": make_pipeline(StandardScaler(), SVC(probability=True, C=1.0, cache_size=500)),
        "decision tree d2": DecisionTreeClassifier(max_depth=2, min_samples_leaf=100, random_state=RNG),
        "decision tree d4": DecisionTreeClassifier(max_depth=4, min_samples_leaf=60, random_state=RNG),
        "random forest": RandomForestClassifier(n_estimators=400, min_samples_leaf=30,
                                                n_jobs=-1, random_state=RNG),
        "extra trees": ExtraTreesClassifier(n_estimators=400, min_samples_leaf=30,
                                            n_jobs=-1, random_state=RNG),
        "hist-GBM": HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05,
                                                   max_leaf_nodes=15, l2_regularization=1.0,
                                                   random_state=RNG),
        "gradient boosting": GradientBoostingClassifier(n_estimators=150, max_depth=3,
                                                        learning_rate=0.05, random_state=RNG),
        "MLP (32,16)": make_pipeline(StandardScaler(), MLPClassifier(
            (32, 16), max_iter=300, early_stopping=True, random_state=RNG)),
    }


NEW_FEATS = ["indoors", "retract_open", "temp", "wind_mph", "wind_signed", "wind_out", "wind_in",
             "precip", "sunny", "is_night", "travel_mi", "pen_fatigue", "has_edge", "same_hand"]


def algorithm_sweep(df):
    print(f"\n{'=' * 84}\n2. ALGORITHM SWEEP — predict the MISS, train {DISCOVER} -> test {CONFIRM}"
          f"\n{'=' * 84}")
    d = df[df.p >= HIGH_BAR].copy()
    old = ["p", "slot", "pa_pg", "gp", "is_home", "park", "team_r_pg", "opp_r_allowed_pg",
           "sp_k_bf", "sp_h_bf", "bf_start", "outs_start", "days_rest", "opp_k_pa", "k_bf"]
    old = [c for c in old if c in d.columns]
    feats = old + [c for c in NEW_FEATS if c in d.columns]
    d[feats] = d[feats].astype(float).fillna(-1)
    tr, te = d[d.season == DISCOVER], d[d.season == CONFIRM]
    print(f"  train {len(tr):,} confident picks   test {len(te):,}   "
          f"base miss rate {te.miss.mean():.3f}")
    base = 1 - te.p.values
    print(f"\n  {'model':>22} {'AUC':>8} {'logloss':>9}   (baseline = trust the probability)")
    print(f"  {'BASELINE 1 - p':>22} {auc(te.miss.values, base):>8.4f} "
          f"{logloss(te.miss.values, base):>9.4f}")
    best = None
    for name, est in zoo().items():
        try:
            X = tr[feats].values
            est.fit(X, tr.miss.values)
            p = est.predict_proba(te[feats].values)[:, 1]
            a, l = auc(te.miss.values, p), logloss(te.miss.values, p)
            print(f"  {name:>22} {a:>8.4f} {l:>9.4f}")
            if best is None or a > best[1]:
                best = (name, a, est)
        except Exception as e:
            print(f"  {name:>22} FAILED {str(e)[:40]}")
    # what does the interpretable tree actually say?
    dt = DecisionTreeClassifier(max_depth=2, min_samples_leaf=100, random_state=RNG)
    dt.fit(tr[feats].values, tr.miss.values)
    print("\n  the depth-2 tree, in words:")
    print(export_text(dt, feature_names=feats, max_depth=2))
    return best


# ------------------------------------------------------- 3. exhaustive rules
def rule_mining(df):
    """Every 1- and 2-condition rule over discretized features, ranked by lift.

    Mined on the discovery season, then checked on the confirmation season. The
    permutation column is the honest part: how big a lift this search finds when
    the outcome is shuffled, i.e. the bar a real rule has to clear.
    """
    print(f"\n{'=' * 84}\n3. RULE MINING — 1- and 2-condition flags, mined on {DISCOVER}, "
          f"checked on {CONFIRM}\n{'=' * 84}")
    d = df[df.p >= HIGH_BAR].copy()
    conds = {}
    for c in ["temp", "wind_signed", "wind_mph", "travel_mi", "pen_fatigue", "slot", "p",
              "park", "sp_k_bf", "bf_start", "days_rest", "opp_lhb_share"]:
        if c not in d.columns or d[c].notna().sum() < 500:
            continue
        q = d[c].quantile([0.25, 0.5, 0.75]).values
        for name, m in [(f"{c}<={q[0]:.2f}", d[c] <= q[0]), (f"{c}>={q[2]:.2f}", d[c] >= q[2])]:
            conds[name] = m.fillna(False).values
    for c in ["indoors", "precip", "is_night", "sunny", "has_edge", "same_hand",
              "wind_out", "wind_in", "retract_open"]:
        if c in d.columns and d[c].notna().sum() > 500:
            conds[f"{c}=1"] = (d[c] == 1).fillna(False).values
            conds[f"{c}=0"] = (d[c] == 0).fillna(False).values
    for mk in d.market.unique():
        conds[f"market={mk}"] = (d.market == mk).values

    disc = (d.season == DISCOVER).values
    conf = (d.season == CONFIRM).values
    miss = d.miss.values
    base_d = miss[disc].mean()
    names = list(conds)
    found = []
    for k in (1, 2):
        for combo in itertools.combinations(names, k):
            m = np.logical_and.reduce([conds[c] for c in combo])
            nd = (m & disc).sum()
            if nd < 150:
                continue
            lift = miss[m & disc].mean() - base_d
            found.append((combo, nd, miss[m & disc].mean(), lift))
    found.sort(key=lambda f: -abs(f[3]))

    # permutation null: the same search on shuffled labels
    rng = np.random.default_rng(RNG)
    null = []
    for _ in range(12):
        sh = rng.permutation(miss)
        best = 0.0
        for combo, _, _, _ in found[:400]:
            m = np.logical_and.reduce([conds[c] for c in combo])
            if (m & disc).sum() >= 150:
                best = max(best, abs(sh[m & disc].mean() - sh[disc].mean()))
        null.append(best)
    bar = float(np.percentile(null, 95))
    print(f"  base miss rate {base_d:.3f} on {disc.sum():,} picks; "
          f"{len(found):,} rules with support >= 150")
    print(f"  permutation bar: the best |lift| this search finds on shuffled labels is "
          f"{np.mean(null):.3f} (95th pct {bar:.3f})")
    print(f"\n  {'rule':>52} {'n':>6} {'miss':>7} {'lift':>7} | {CONFIRM} {'n':>6} {'miss':>7} {'lift':>7}")
    base_c = miss[conf].mean()
    shown = 0
    for combo, nd, md, lift in found:
        if abs(lift) < bar:
            continue
        m = np.logical_and.reduce([conds[c] for c in combo])
        nc = (m & conf).sum()
        mc = miss[m & conf].mean() if nc >= 50 else np.nan
        lc = mc - base_c if nc >= 50 else np.nan
        tag = ""
        if nc >= 50 and np.sign(lc) == np.sign(lift) and abs(lc) >= bar / 2:
            tag = "  <-- HOLDS"
        print(f"  {' AND '.join(combo)[:52]:>52} {nd:>6,} {md:>7.3f} {lift:>+7.3f} | "
              f"{nc:>6,} {mc:>7.3f} {lc:>+7.3f}{tag}")
        shown += 1
        if shown >= 25:
            break
    if shown == 0:
        print("\n  no rule clears the permutation bar — every apparent flag is search noise")


def main():
    df = build()
    print(f"{len(df):,} out-of-sample (pick, market) rows for {DISCOVER}-{CONFIRM}")
    print(f"platoon coverage {df.platoon.ne('unknown').mean():.1%}   "
          f"weather {df.temp.notna().mean():.1%}   umpire {df.hp_umpire.notna().mean():.1%}")
    df.to_pickle(os.path.join(DATA, "edge_hunt.pkl"))

    disc = family_scan(df, DISCOVER, f"1. NEW-INFORMATION SCAN — discovery season {DISCOVER}")
    conf = family_scan(df, CONFIRM, f"1b. SAME SCAN — confirmation season {CONFIRM}")
    replication(disc, conf)
    algorithm_sweep(df)
    rule_mining(df)


if __name__ == "__main__":
    main()
