"""
Train the shippable model (logistic + market) on SEASON-TO-DATE features - the
exact same features the live TypeScript pipeline can compute from ESPN box-score
aggregates - and export weights to td_model.json for the app to import.

Season-to-date (cumulative, reset each season) is used instead of the backtest's
EWMA features so that training and live serving are identical: the app just sums
each team's completed-game box scores.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
APP_OUT = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "td-model.json"))

K_RUSH, K_REC, K_ANY = 25.0, 30.0, 4.0
LG_RUSH, LG_REC, LG_ANY = 0.0347, 0.0469, 0.21

FEATURES = [
    "carry_share", "target_share", "cpg", "tpg", "rush_ypg", "rec_ypg",
    "rush_td_rate", "rec_td_rate", "anytime_rate", "gp",
    "team_rush_tdpg", "team_rec_tdpg", "opp_rush_td_allowed_pg", "opp_rec_td_allowed_pg",
    "is_home", "mkt_implied_total", "mkt_total", "mkt_team_margin",
]


def build_rows():
    pg = pd.read_csv(os.path.join(DATA, "player_games.csv"))
    pg["player_id"] = pg.player_id.astype(str)
    mkt = pd.read_csv(os.path.join(DATA, "market_lines.csv"))
    mkt_map = {(r.game_id, r.team): r for r in mkt.itertuples()}

    # chronological game order
    order = (pg[["game_id", "season", "week", "gameday"]].drop_duplicates()
             .sort_values(["gameday", "game_id"]))
    pg_by_game = {g: d for g, d in pg.groupby("game_id")}

    P = {}   # (season, pid) -> cumulative dict
    T = {}   # (season, team) -> cumulative dict (offense + defense allowed)
    rows = []

    def team_state(s, t):
        return T.setdefault((s, t), dict(gp=0, car=0, tgt=0, rtd=0, ctd=0,
                                         d_rtd=0, d_ctd=0))

    for o in order.itertuples():
        gid, s = o.game_id, o.season
        box = pg_by_game[gid]
        home = gid.split("_")[-1]
        # team-game TD totals (from box score)
        for team, tdf in box.groupby("team"):
            opp = tdf.iloc[0]["opp"]
            ts, os_ = team_state(s, team), team_state(s, opp)
            mk = mkt_map.get((gid, team))
            for r in tdf.itertuples():
                ps = P.setdefault((s, r.player_id),
                                  dict(gp=0, car=0, tgt=0, ry=0, cy=0, rtd=0, ctd=0, scg=0))
                if ps["gp"] >= 1 and ts["gp"] >= 1 and os_["gp"] >= 1 and mk is not None:
                    car, tgt = ps["car"], ps["tgt"]
                    feat = {
                        "carry_share": car / ts["car"] if ts["car"] else 0.0,
                        "target_share": tgt / ts["tgt"] if ts["tgt"] else 0.0,
                        "cpg": car / ps["gp"], "tpg": tgt / ps["gp"],
                        "rush_ypg": ps["ry"] / ps["gp"], "rec_ypg": ps["cy"] / ps["gp"],
                        "rush_td_rate": (ps["rtd"] + K_RUSH * LG_RUSH) / (car + K_RUSH),
                        "rec_td_rate": (ps["ctd"] + K_REC * LG_REC) / (tgt + K_REC),
                        "anytime_rate": (ps["scg"] + K_ANY * LG_ANY) / (ps["gp"] + K_ANY),
                        "gp": min(ps["gp"], 17),
                        "team_rush_tdpg": ts["rtd"] / ts["gp"], "team_rec_tdpg": ts["ctd"] / ts["gp"],
                        "opp_rush_td_allowed_pg": os_["d_rtd"] / os_["gp"],
                        "opp_rec_td_allowed_pg": os_["d_ctd"] / os_["gp"],
                        "is_home": 1 if team == home else 0,
                        "mkt_implied_total": mk.mkt_implied_total,
                        "mkt_total": mk.mkt_total, "mkt_team_margin": mk.mkt_team_margin,
                        "season": s, "scored": int((r.rush_td + r.rec_td) > 0),
                    }
                    if (car + tgt) >= 1:      # only rankable players
                        rows.append(feat)
            # update team offense + this game's totals
            g_rtd = int(tdf.rush_td.sum()); g_ctd = int(tdf.rec_td.sum())
        # second pass: update cumulative AFTER emitting features for the whole game
        for team, tdf in box.groupby("team"):
            opp = tdf.iloc[0]["opp"]
            ts, os_ = team_state(s, team), team_state(s, opp)
            g_rtd = int(tdf.rush_td.sum()); g_ctd = int(tdf.rec_td.sum())
            ts["gp"] += 1; ts["rtd"] += g_rtd; ts["ctd"] += g_ctd
            ts["car"] += int(tdf.carries.sum()); ts["tgt"] += int(tdf.targets.sum())
            os_["d_rtd"] += g_rtd; os_["d_ctd"] += g_ctd   # opp allowed these
            for r in tdf.itertuples():
                ps = P[(s, r.player_id)]
                ps["gp"] += 1; ps["car"] += r.carries; ps["tgt"] += r.targets
                ps["ry"] += r.rush_yds; ps["cy"] += r.rec_yds
                ps["rtd"] += r.rush_td; ps["ctd"] += r.rec_td
                ps["scg"] += 1 if (r.rush_td + r.rec_td) > 0 else 0

    return pd.DataFrame(rows)


def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    o = p.argsort(); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def fit_platt(p, y, it=60):
    x = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    X = np.column_stack([x, np.ones_like(x)]); b = np.zeros(2)
    for _ in range(it):
        q = 1 / (1 + np.exp(-(X @ b))); W = np.clip(q * (1 - q), 1e-9, None)
        b -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(2), X.T @ (q - y))
    return b


def main():
    df = build_rows()
    print(f"rows={len(df):,}  scored rate={df.scored.mean():.3f}  "
          f"seasons={sorted(df.season.unique())}")
    Xall, yall = df[FEATURES].values, df.scored.values

    # ---- validation: train <=2023, test 2024 ----
    tr, te = df[df.season <= 2023], df[df.season == 2024]
    sc = StandardScaler().fit(tr[FEATURES].values)
    lr = LogisticRegression(max_iter=3000).fit(sc.transform(tr[FEATURES].values), tr.scored.values)
    pte = lr.predict_proba(sc.transform(te[FEATURES].values))[:, 1]
    platt = fit_platt(lr.predict_proba(sc.transform(tr[FEATURES].values))[:, 1], tr.scored.values)
    print(f"[validation 2024]  AUC={auc(te.scored.values, pte):.4f}  n={len(te):,}")

    # ---- final model: fit on ALL data for shipping ----
    scaler = StandardScaler().fit(Xall)
    final = LogisticRegression(max_iter=3000).fit(scaler.transform(Xall), yall)
    p_all = final.predict_proba(scaler.transform(Xall))[:, 1]
    platt_final = fit_platt(p_all, yall)

    model = {
        "features": FEATURES,
        "mean": scaler.mean_.tolist(),
        "std": scaler.scale_.tolist(),
        "coef": final.coef_[0].tolist(),
        "intercept": float(final.intercept_[0]),
        "platt_a": float(platt_final[0]), "platt_b": float(platt_final[1]),
        "constants": {"K_RUSH": K_RUSH, "K_REC": K_REC, "K_ANY": K_ANY,
                      "LG_RUSH": LG_RUSH, "LG_REC": LG_REC, "LG_ANY": LG_ANY},
        "notes": "logistic + market on season-to-date features; P=platt(sigmoid(w.x+b))",
    }
    # self-test vectors (first 3 rows) for the TS port to verify parity
    def infer(x):
        z = (np.asarray(x) - scaler.mean_) / scaler.scale_
        raw = 1 / (1 + np.exp(-(z @ final.coef_[0] + final.intercept_[0])))
        lg = np.log(raw / (1 - raw))
        return 1 / (1 + np.exp(-(platt_final[0] * lg + platt_final[1])))
    model["selftest"] = [{"x": df[FEATURES].iloc[i].tolist(), "p": float(infer(df[FEATURES].iloc[i].values))}
                         for i in range(3)]

    with open(APP_OUT, "w") as f:
        json.dump(model, f, indent=2)
    with open(os.path.join(HERE, "td_model.json"), "w") as f:
        json.dump(model, f, indent=2)
    print(f"exported -> {APP_OUT}")
    print("sample coefs:", {k: round(v, 3) for k, v in
          sorted(zip(FEATURES, final.coef_[0]), key=lambda kv: -abs(kv[1]))[:6]})


if __name__ == "__main__":
    main()
