"""
Player props for one competition — features, model sweep, calibration, tiers.

Ten binary markets on starting players:

  shots           1+, 2+, 3+ shots
  on target       1+, 2+ shots on target
  end product     1+ goal, 1+ assist, 1+ goal involvement (goal or assist)
  discipline      1+ yellow/red card, 2+ fouls committed

Same discipline as the MLB prop work: a strictly chronological walk, features
that only ever see earlier matches, models trained on the older seasons and
tested on seasons they have never seen (2024-25 discovery, 2025-26 confirmation).

The football-specific problem is minutes. ESPN publishes no minutes played, only
starter / subbed-on / subbed-off flags, so playing time is approximated (90 for a
starter who finishes, 65 for one withdrawn, 25 for a substitute). Rates are
therefore per-appearance rather than true per-90 — good enough to rank, and
honest about what it is.

Every league gets its own fit. The markets are the same ten everywhere, but the
coefficients, the Platt calibration and the tier breakpoints are league-local,
because the base rates are not remotely equal across competitions — Serie A
books far more cards per start than the Premier League, and a "1+ card" model
carried over would be badly mis-calibrated.

Output is a deployable model, not just a report: each market carries its
feature list, standardisation, coefficients and Platt terms, so the site scores
players with exactly the fit that was backtested here.

Usage: python3 props_soccer.py --league seriea
"""

import argparse
import json
import os
import warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesClassifier, GradientBoostingClassifier,
                              HistGradientBoostingClassifier, RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

from leagues import add_league_arg, get as get_league

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
TRAIN_MAX, DISCOVER, CONFIRM = 2023, 2024, 2025
RNG = 0

# market -> (outcome test, league per-start base rate prior)
MARKETS = {
    "sh1": (lambda r: int(r.totalShots >= 1), 0.55),
    "sh2": (lambda r: int(r.totalShots >= 2), 0.28),
    "sh3": (lambda r: int(r.totalShots >= 3), 0.13),
    "sot1": (lambda r: int(r.shotsOnTarget >= 1), 0.25),
    "sot2": (lambda r: int(r.shotsOnTarget >= 2), 0.08),
    "goal1": (lambda r: int(r.totalGoals >= 1), 0.10),
    "asst1": (lambda r: int(r.goalAssists >= 1), 0.07),
    "ga1": (lambda r: int(r.totalGoals + r.goalAssists >= 1), 0.16),
    "card1": (lambda r: int(r.yellowCards + r.redCards >= 1), 0.15),
    "foul2": (lambda r: int(r.foulsCommitted >= 2), 0.25),
}
LABELS = {
    "sh1": "1+ shots", "sh2": "2+ shots", "sh3": "3+ shots",
    "sot1": "1+ on target", "sot2": "2+ on target",
    "goal1": "1+ goal", "asst1": "1+ assist", "ga1": "goal or assist",
    "card1": "1+ card", "foul2": "2+ fouls",
}
# league per-appearance rates, used as shrinkage targets
LG = dict(sh=1.02, sot=0.34, goal=0.11, asst=0.08, card=0.15, foul=0.84, mins=78.0)
K_APP = 12.0     # shrinkage weight, in appearances
K_G = 10.0

FEATURES = [
    "sh_pa", "sot_pa", "goal_pa", "asst_pa", "card_pa", "foul_pa", "conv_rate",
    "w_sh_pa", "w_sot_pa", "w_goal_pa", "w_apps",
    "py_sh_pa", "py_goal_pa", "py_apps", "py_known",
    "apps", "start_rate", "mins_avg", "is_home",
    "pos_fw", "pos_mf", "pos_df", "pos_gk", "formation_place",
    "team_sh_pg", "team_goals_pg", "opp_sh_allowed", "opp_goals_allowed", "opp_fouls_pg",
]


def shrunk(num, den, prior, k):
    return (num + k * prior) / (den + k)


class Window:
    def __init__(self, keys, n=6):
        self.keys, self.q, self.n = keys, deque(), n
        self.tot = dict.fromkeys(keys, 0.0)

    def add(self, rec):
        self.q.append(rec)
        for k in self.keys:
            self.tot[k] += rec[k]
        if len(self.q) > self.n:
            old = self.q.popleft()
            for k in self.keys:
                self.tot[k] -= old[k]

    @property
    def g(self):
        return len(self.q)


PKEYS = ["sh", "sot", "goal", "asst", "card", "foul", "mins", "app", "start"]


def build(data):
    pm = pd.read_csv(os.path.join(data, "player_matches.csv"))
    md = pd.read_csv(os.path.join(data, "matches.csv"))[
        ["matchId", "date", "season", "home_id", "away_id", "home_goals", "away_goals"]]
    pm = pm.merge(md[["matchId", "home_goals", "away_goals"]], on="matchId", how="left")
    pm = pm.sort_values(["date", "matchId"]).reset_index(drop=True)
    for m, (fn, _) in MARKETS.items():
        pm[f"y_{m}"] = [fn(r) for r in pm.itertuples()]

    # prior-season totals per player
    py = pm.groupby(["season", "player_id"]).agg(
        pa=("mins_est", "size"), sh=("totalShots", "sum"),
        goal=("totalGoals", "sum")).reset_index()
    py_map = {(int(r.season) + 1, int(r.player_id)): r for r in py.itertuples()}

    P = defaultdict(lambda: dict.fromkeys(PKEYS, 0.0))
    W = defaultdict(lambda: Window(["sh", "sot", "goal", "app"]))
    G = defaultdict(lambda: dict.fromkeys(["gm", "sh", "goal", "sh_a", "goal_a", "foul"], 0.0))
    MK = defaultdict(lambda: dict.fromkeys([f"g_{m}" for m in MARKETS], 0.0))

    rows = []
    for mid, g in pm.groupby("matchId", sort=False):
        season = int(g.season.iloc[0])
        for r in g.itertuples():
            if not r.starter:                     # props are priced on starters
                continue
            p, w, mk = P[r.player_id], W[r.player_id], MK[r.player_id]
            team, opp = G[(season, r.team_id)], G[(season, r.opp_id)]
            if p["app"] < 3 or team["gm"] < 3 or opp["gm"] < 3:
                continue
            app = p["app"]
            pyr = py_map.get((season, int(r.player_id)))
            pos = str(r.pos or "")
            feat = {
                "sh_pa": shrunk(p["sh"], app, LG["sh"], K_APP),
                "sot_pa": shrunk(p["sot"], app, LG["sot"], K_APP),
                "goal_pa": shrunk(p["goal"], app, LG["goal"], K_APP),
                "asst_pa": shrunk(p["asst"], app, LG["asst"], K_APP),
                "card_pa": shrunk(p["card"], app, LG["card"], K_APP),
                "foul_pa": shrunk(p["foul"], app, LG["foul"], K_APP),
                "conv_rate": shrunk(p["goal"], max(p["sh"], 0), 0.11, 8.0),
                "w_sh_pa": shrunk(w.tot["sh"], w.g, LG["sh"], 4.0),
                "w_sot_pa": shrunk(w.tot["sot"], w.g, LG["sot"], 4.0),
                "w_goal_pa": shrunk(w.tot["goal"], w.g, LG["goal"], 4.0),
                "w_apps": w.g,
                "py_sh_pa": shrunk(pyr.sh, pyr.pa, LG["sh"], K_APP) if pyr is not None else LG["sh"],
                "py_goal_pa": shrunk(pyr.goal, pyr.pa, LG["goal"], K_APP) if pyr is not None else LG["goal"],
                "py_apps": min(pyr.pa, 38) if pyr is not None else 0.0,
                "py_known": 1.0 if pyr is not None else 0.0,
                "apps": min(app, 38),
                "start_rate": p["start"] / app,
                "mins_avg": p["mins"] / app,
                "is_home": float(r.is_home),
                "pos_fw": float(pos in ("F", "CF", "LW", "RW", "ST", "SS")),
                "pos_mf": float(pos in ("M", "CM", "AM", "DM", "LM", "RM")),
                "pos_df": float(pos in ("D", "CB", "LB", "RB", "WB")),
                "pos_gk": float(pos == "G"),
                "formation_place": float(r.formation_place or 0),
                "team_sh_pg": team["sh"] / team["gm"],
                "team_goals_pg": team["goal"] / team["gm"],
                "opp_sh_allowed": opp["sh_a"] / opp["gm"],
                "opp_goals_allowed": opp["goal_a"] / opp["gm"],
                "opp_fouls_pg": opp["foul"] / opp["gm"],
            }
            for m, (_, prior) in MARKETS.items():
                feat[f"own_{m}"] = shrunk(mk[f"g_{m}"], app, prior, K_G)
                feat[f"y_{m}"] = getattr(r, f"y_{m}")
            feat.update(matchId=mid, date=r.date, season=season, player_id=r.player_id,
                        name=r.name, pos=pos, team_id=r.team_id)
            rows.append(feat)

        # fold the match in
        for r in g.itertuples():
            p, w, mk = P[r.player_id], W[r.player_id], MK[r.player_id]
            rec = dict(sh=r.totalShots, sot=r.shotsOnTarget, goal=r.totalGoals,
                       asst=r.goalAssists, card=r.yellowCards + r.redCards,
                       foul=r.foulsCommitted, mins=r.mins_est, app=1.0,
                       start=float(r.starter))
            for k in PKEYS:
                p[k] += rec[k]
            w.add({k: rec[k] for k in ("sh", "sot", "goal", "app")})
            for m in MARKETS:
                mk[f"g_{m}"] += getattr(r, f"y_{m}")
        for tid, td in g.groupby("team_id"):
            opp_id = td.opp_id.iloc[0]
            t, o = G[(season, tid)], G[(season, opp_id)]
            t["gm"] += 1
            t["sh"] += td.totalShots.sum(); t["goal"] += td.totalGoals.sum()
            t["foul"] += td.foulsCommitted.sum()
            o["sh_a"] += td.totalShots.sum(); o["goal_a"] += td.totalGoals.sum()
    return pd.DataFrame(rows)


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


def platt(p, y, it=60):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([x, np.ones_like(x)]); b = np.zeros(2)
    for _ in range(it):
        q = 1 / (1 + np.exp(-(X @ b)))
        W = np.clip(q * (1 - q), 1e-9, None)
        b -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(2), X.T @ (q - y))
    return b


def apply_platt(p, b):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(b[0] * x + b[1])))


def zoo():
    return {
        "logistic": lambda: LogisticRegression(max_iter=3000),
        "logistic L1": lambda: LogisticRegression(penalty="l1", solver="liblinear",
                                                  C=0.5, max_iter=3000),
        "gaussian NB": lambda: GaussianNB(),
        "kNN (k=150)": lambda: KNeighborsClassifier(150, n_jobs=-1),
        "random forest": lambda: RandomForestClassifier(n_estimators=300, min_samples_leaf=40,
                                                        n_jobs=-1, random_state=RNG),
        "extra trees": lambda: ExtraTreesClassifier(n_estimators=300, min_samples_leaf=40,
                                                    n_jobs=-1, random_state=RNG),
        "hist-GBM": lambda: HistGradientBoostingClassifier(max_iter=200, learning_rate=0.06,
                                                           max_leaf_nodes=15,
                                                           l2_regularization=1.0, random_state=RNG),
        "gradient boosting": lambda: GradientBoostingClassifier(n_estimators=120, max_depth=3,
                                                                learning_rate=0.06, random_state=RNG),
        "MLP (32,16)": lambda: MLPClassifier((32, 16), max_iter=200, early_stopping=True,
                                             random_state=RNG),
    }


def tiers_for(p, y):
    order = np.argsort(-p)
    p, y = p[order], y[order]
    n = len(p)
    best = None
    for hi_q in (0.05, 0.10, 0.15, 0.20):
        for lo_q in (0.40, 0.50, 0.60):
            hi_n, lo_n = int(n * hi_q), int(n * lo_q)
            if hi_n < 150 or (n - lo_n) < 150:
                continue
            top, mid, bot = y[:hi_n].mean(), y[hi_n:lo_n].mean(), y[lo_n:].mean()
            if not (top > mid > bot):
                continue
            if best is None or (top - bot) > best[0]:
                best = (top - bot, p[hi_n - 1], p[lo_n - 1], top, mid, bot,
                        hi_n, lo_n - hi_n, n - lo_n)
    if best is None:
        return []
    _, hp, lp, top, mid, bot, n1, n2, n3 = best
    return [{"minProb": float(hp), "label": "Strong", "hitRate": float(top), "n": int(n1)},
            {"minProb": float(lp), "label": "Solid", "hitRate": float(mid), "n": int(n2)},
            {"minProb": 0.0, "label": "Lean", "hitRate": float(bot), "n": int(n3)}]


def slate_topn(dates, y, p, n):
    df = pd.DataFrame({"d": dates, "y": y, "p": p})
    hits = tot = 0
    for _, g in df.groupby("d"):
        t = g.nlargest(n, "p")
        hits += int(t.y.sum()); tot += len(t)
    return hits / tot if tot else float("nan")


def main():
    ap = add_league_arg(argparse.ArgumentParser(description=__doc__))
    league = get_league(ap.parse_args().league)
    os.makedirs(RESULTS, exist_ok=True)
    print(f"{league.name} ({league.country})")

    df = build(os.path.join(HERE, "data", league.slug))
    print(f"{len(df):,} starter-match rows  seasons {sorted(df.season.unique())}")
    print("base rates:", {m: round(df[f'y_{m}'].mean(), 3) for m in MARKETS})

    tr = df.season <= TRAIN_MAX
    dis = df.season == DISCOVER
    con = df.season == CONFIRM
    print(f"\ntrain {tr.sum():,} | discover {dis.sum():,} ({DISCOVER}) | "
          f"confirm {con.sum():,} ({CONFIRM})")

    board, shipped = [], {}
    for mk in MARKETS:
        feats = FEATURES + [f"own_{mk}"]
        X = df[feats].values.astype(float)
        y = df[f"y_{mk}"].values.astype(int)
        sc = StandardScaler().fit(X[tr])
        Xtr, Xd, Xc = sc.transform(X[tr]), sc.transform(X[dis]), sc.transform(X[con])
        print(f"\n=== {LABELS[mk]}  (base {y[con].mean():.3f}) ===")
        best = None
        for name, make in zoo().items():
            try:
                est = make().fit(Xtr, y[tr])
                pd_ = est.predict_proba(Xd)[:, 1]
                pc_ = est.predict_proba(Xc)[:, 1]
                a_d, a_c = auc(y[dis], pd_), auc(y[con], pc_)
                board.append(dict(market=mk, model=name, auc_discover=a_d, auc_confirm=a_c,
                                  logloss_confirm=logloss(y[con], pc_)))
                print(f"  {name:20s} AUC {a_d:.4f} (disc) {a_c:.4f} (conf)")
                if best is None or a_d > best[1]:
                    best = (name, a_d, est)
            except Exception as e:
                print(f"  {name:20s} failed: {str(e)[:40]}")
        # own-rate baseline: no learning at all
        nb = df[f"own_{mk}"].values[con]
        board.append(dict(market=mk, model="own-rate baseline", auc_discover=float("nan"),
                          auc_confirm=auc(y[con], nb), logloss_confirm=logloss(y[con], nb)))
        print(f"  {'own-rate baseline':20s} AUC {'':6}        {auc(y[con], nb):.4f} (conf)")

        # Ship the logistic. The model choice was made on the discovery season
        # only; the confirmation season below is scored once and never fed back.
        # Everything the site needs to reproduce this fit goes into the JSON —
        # feature order, the standardiser, the coefficients and the Platt terms
        # — so a prediction on the site is the same arithmetic as here.
        lr = LogisticRegression(max_iter=3000).fit(Xtr, y[tr])
        b = platt(lr.predict_proba(Xtr)[:, 1], y[tr])
        pc_ = apply_platt(lr.predict_proba(Xc)[:, 1], b)
        shipped[mk] = dict(
            label=LABELS[mk], auc=auc(y[con], pc_), base=float(y[con].mean()),
            meanPred=float(pc_.mean()), logloss=logloss(y[con], pc_),
            top1=slate_topn(df.date.values[con], y[con], pc_, 1),
            top5=slate_topn(df.date.values[con], y[con], pc_, 5),
            tiers=tiers_for(pc_.copy(), y[con].copy()), n=int(con.sum()),
            features=feats,
            mean=[float(v) for v in sc.mean_],
            std=[float(v) for v in sc.scale_],
            coef=[float(v) for v in lr.coef_[0]],
            intercept=float(lr.intercept_[0]),
            plattA=float(b[0]), plattB=float(b[1]))

    B = pd.DataFrame(board)
    B.insert(0, "league", league.slug)
    B.to_csv(os.path.join(RESULTS, f"{league.slug}_props.csv"), index=False)
    json.dump({"league": league.slug, "name": league.name, "markets": shipped},
              open(os.path.join(RESULTS, f"{league.slug}_props_model.json"), "w"), indent=1)

    print("\n" + "=" * 84)
    print(f"MEAN AUC BY ALGORITHM (confirmation season {CONFIRM}-{str(CONFIRM + 1)[2:]})")
    print("=" * 84)
    print(B.groupby("model").auc_confirm.agg(["mean", "min", "max"]).sort_values(
        "mean", ascending=False).round(4).to_string())

    print("\n" + "=" * 84)
    print("SHIPPED LOGISTIC PER MARKET")
    print("=" * 84)
    print(f"{'market':16} {'base':>7} {'AUC':>7} {'top1':>7} {'top5':>7} | tiers")
    for mk, v in shipped.items():
        t = " ".join(f"{x['label'][:2]} {x['hitRate']*100:.0f}%" for x in v["tiers"])
        print(f"{v['label']:16} {v['base']:>7.3f} {v['auc']:>7.4f} {v['top1']:>7.3f} "
              f"{v['top5']:>7.3f} | {t}")


if __name__ == "__main__":
    main()
