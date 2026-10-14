"""
Held-out predictions of the SHIPPED NFL first-touchdown (td1) model.

    OMP_NUM_THREADS=2 python3 research/football-td/predict_nfl_td1.py
    (after features_nfl.py, fetch_first_td.py nfl, predict_nfl.py)

The shipped artifact src/lib/nfl-td1-model.json (served by inferMarket in
src/lib/nfl-td-markets.ts) is the DEPLOYMENT fit on 2021-24 + 2025 + 2026
Week 1. Its quoted `heldout` block comes from export_first_td.py's 2021-24 fit
scored on 2025-26, which is not stored, so it is refitted here with the
identical procedure (copied, not imported):

  label     1 if this candidate is the game's first-touchdown scorer
            (data/nfl_first_td.csv), else 0 — same candidate rows as the anytime
            model, so games whose first TD went to a defender, a returner or a
            non-candidate have no positive row (the "ceiling");
  model     StandardScaler + LogisticRegression(C=1, max_iter=3000);
  shrink    picked by rolling origin inside 2021-24 on the legs a slip takes
            (pick_shrink, verbatim) -> p = (1-shrink)*sigmoid(w.z+b) + shrink*base.

Checks: the deployment refit is compared with the shipped JSON, and the held-out
metrics on the quoted 301 games with the quoted ones (results/nfl_td1_metrics.json).

Output: data/nfl_td1_preds.csv — one row per candidate (and priced no_touch
player) in every 2025 + 2026 game: prob (held-out), prob_deployed (shipped
weights; out-of-sample only after 2026-09-16), first_td 0/1.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RESULTS = os.path.join(HERE, "results")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ART = json.load(open(os.path.join(ROOT, "src", "lib", "nfl-td1-model.json")))
FEATURES = ART["features"]
TRAIN, TEST = [2021, 2022, 2023, 2024], [2025, 2026]
SIZES = [5, 10]
EXPORT_CUTOFF = "2026-09-16"


def ece(y, p, bins=10):  # bakeoff_nfl.py, verbatim
    y, p = np.asarray(y), np.asarray(p)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        total += (m.sum() / len(y)) * abs(p[m].mean() - y[m].mean())
    return total


# ------------------------------------------------ export_first_td.py, verbatim
def fit_bundle(df, seasons, shrink):
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[FEATURES].values)
    X, y = sc.transform(tr[FEATURES].values), tr.scored.values
    m = LogisticRegression(max_iter=3000, C=1.0).fit(X, y)
    return {"mean": sc.mean_, "std": sc.scale_, "w": m.coef_[0],
            "intercept": float(m.intercept_[0]), "base": float(y.mean()),
            "shrink": shrink}


def predict(b, raw):  # == inferMarket("td1", x) in nfl-td-markets.ts (no Platt)
    z = (raw - b["mean"]) / b["std"]
    p = 1 / (1 + np.exp(-(z @ b["w"] + b["intercept"])))
    lam = b["shrink"]
    return (1 - lam) * p + lam * b["base"]


def leg_stats(sub, p, y, per_slate=max(SIZES)):
    d = pd.DataFrame({"date": sub.date.values, "game_id": sub.game_id.values,
                      "player_id": sub.player_id.values, "y": y, "p": p})
    d = d.sort_values("p", ascending=False).drop_duplicates(["date", "player_id"])
    keep = d.drop_duplicates(["date", "game_id"]).groupby("date").head(per_slate)
    return float(keep.p.mean()), float(keep.y.mean()), len(keep)


def pick_shrink(df):
    grid = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
    gaps = {l: [] for l in grid}
    for fit_seasons, judge in [([2021], 2022), ([2021, 2022], 2023),
                               ([2021, 2022, 2023], 2024)]:
        b = fit_bundle(df, fit_seasons, 0.0)
        j = df[df.season == judge].reset_index(drop=True)
        z = (j[FEATURES].values - b["mean"]) / b["std"]
        p0 = 1 / (1 + np.exp(-(z @ b["w"] + b["intercept"])))
        for lam in grid:
            st, ac, _ = leg_stats(j, (1 - lam) * p0 + lam * b["base"], j.scored.values)
            gaps[lam].append(ac - st)
    return min(grid, key=lambda l: abs(np.mean(gaps[l])))
# ------------------------------------------------------------------------------


def metrics(sub, p):
    y = sub.scored.values
    d = sub[["game_id", "scored"]].copy()
    d["p"] = p
    hits = np.array([int(g.loc[g.p.idxmax()].scored) for _, g in d.groupby("game_id")])
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    lst, lac, ln = leg_stats(sub, p, y)
    return {"rows": int(len(sub)), "games": int(sub.game_id.nunique()),
            "top1": float(hits.mean()), "top1_hits": int(hits.sum()),
            "ceiling": float(sub.groupby("game_id").scored.max().mean()),
            "lead_stated": float(lead.p.mean()), "lead_actual": float(lead.scored.mean()),
            "leg_stated": lst, "leg_actual": lac, "legs": ln,
            "auc": float(roc_auc_score(y, p)), "logloss": float(log_loss(y, p)),
            "brier": float(brier_score_loss(y, p)), "ece": float(ece(y, p)),
            "base_rate": float(y.mean())}


def main():
    allrows = pd.read_csv(os.path.join(DATA, "nfl_features_all.csv"),
                          dtype={"player_id": str, "game_id": str, "espn_team_id": str,
                                 "unpriced_reason": str}, low_memory=False)
    ft = pd.read_csv(os.path.join(DATA, "nfl_first_td.csv"),
                     dtype={"event_id": str, "first_td_player_id": str})
    first = dict(zip(ft.event_id, ft.first_td_player_id.fillna("")))
    allrows["anytime"] = allrows.scored
    allrows["scored"] = (allrows.player_id == allrows.game_id.map(first).fillna("")).astype(int)
    df = allrows[allrows.kind == "candidate"].reset_index(drop=True)

    shrink = pick_shrink(df)
    out = {"quoted": ART["heldout"], "shrink_picked": shrink, "shrink_shipped": ART["shrink"]}
    print(f"shrink by rolling origin inside 2021-24: {shrink} (shipped {ART['shrink']})")

    dep = df[(df.season < 2026) | (df.date <= EXPORT_CUTOFF)].reset_index(drop=True)
    full = fit_bundle(dep, TRAIN + TEST, shrink)
    out["deployment_fit_check"] = {
        "rows": int(len(dep)),
        "max_abs_w_diff": float(np.abs(full["w"] - np.array(ART["w"])).max()),
        "intercept": [full["intercept"], ART["intercept"]],
        "base": [full["base"], ART["base"]],
        "max_rel_mean_diff": float(np.abs(full["mean"] / np.array(ART["mean"]) - 1).max()),
    }
    shipped = {"mean": np.array(ART["mean"]), "std": np.array(ART["std"]),
               "w": np.array(ART["w"]), "intercept": ART["intercept"],
               "base": ART["base"], "shrink": ART["shrink"]}
    out["deployment_fit_check"]["selftest_p_max_abs_diff"] = float(max(
        abs(predict(shipped, np.array(t["x"])[None, :])[0] - t["p"]) for t in ART["selftest"]))
    print("deployment fit vs shipped JSON:", json.dumps(out["deployment_fit_check"]))

    ho = fit_bundle(df, TRAIN, shrink)
    te = df[df.season.isin(TEST)].reset_index(drop=True)
    te["prob"] = predict(ho, te[FEATURES].values.astype(float))
    quoted = te[(te.season < 2026) | (te.date <= EXPORT_CUTOFF)].reset_index(drop=True)
    late = te[(te.season == 2026) & (te.date > EXPORT_CUTOFF)].reset_index(drop=True)
    res = {"quoted_subset": metrics(quoted, quoted.prob.values),
           "all_to_date": metrics(te, te.prob.values)}
    for s in TEST:
        sub = te[te.season == s].reset_index(drop=True)
        res[f"season_{s}"] = metrics(sub, sub.prob.values)
    if len(late):
        res["after_export_2026"] = metrics(late, late.prob.values)
        res["after_export_2026_deployed_weights"] = metrics(
            late, predict(shipped, late[FEATURES].values.astype(float)))
    out["heldout"] = res
    out["heldout_bundle"] = {"w": ho["w"].tolist(), "intercept": ho["intercept"],
                             "mean": ho["mean"].tolist(), "std": ho["std"].tolist(),
                             "base": ho["base"], "shrink": shrink}
    q = ART["heldout"]
    print(f"\n  quoted          top1 {q['top1']*100:.2f}% ({round(q['top1']*q['games'])}/{q['games']}) "
          f"ceiling {q['ceiling']:.4f} auc {q['auc']:.4f} ll {q['logloss']:.4f} "
          f"brier {q['brier']:.4f} ece {q['ece']:.4f} lead {q['lead_stated']:.4f}/{q['lead_actual']:.4f} "
          f"leg {q['leg_stated']:.4f}/{q['leg_actual']:.4f}")
    for k, m in res.items():
        print(f"  {k:<15} top1 {m['top1']*100:.2f}% ({m['top1_hits']}/{m['games']}) "
              f"ceiling {m['ceiling']:.4f} auc {m['auc']:.4f} ll {m['logloss']:.4f} "
              f"brier {m['brier']:.4f} ece {m['ece']:.4f} lead {m['lead_stated']:.4f}/"
              f"{m['lead_actual']:.4f} leg {m['leg_stated']:.4f}/{m['leg_actual']:.4f}")

    # deliverable
    ext = allrows[allrows.season.isin(TEST) & (allrows.kind == "no_touch")].copy()
    ext["prob"] = predict(ho, ext[FEATURES].values.astype(float))
    rows = pd.concat([te, ext], ignore_index=True, sort=False)
    rows["prob_deployed"] = predict(shipped, rows[FEATURES].values.astype(float))
    pos_fp = os.path.join(DATA, "nfl_positions.csv")
    if os.path.exists(pos_fp):
        pos = pd.read_csv(pos_fp, dtype={"player_id": str})
        rows = rows.merge(pos[["player_id", "position"]], on="player_id", how="left")
    tid = (allrows[allrows.espn_team_id.notna()].groupby(["game_id", "team"])
           .espn_team_id.first())
    rows["team_id"] = [tid.get((g, t), "") for g, t in zip(rows.game_id, rows.team)]
    rows["candidate"] = (rows.kind == "candidate").astype(int)
    rows["in_quoted_subset"] = (((rows.season < 2026) | (rows.date <= EXPORT_CUTOFF))
                                & (rows.candidate == 1)).astype(int)
    rows = rows.rename(columns={"game_id": "event_id", "player": "player_name",
                                "scored": "first_td", "anytime": "scored_anytime"})
    cols = ["season", "week", "game_type", "date", "event_id", "team_id", "team", "opp",
            "player_id", "player_name", "position", "prob", "prob_deployed", "first_td",
            "scored_anytime", "candidate", "kind", "in_quoted_subset", "games_since_touch"]
    rows = rows.sort_values(["date", "event_id", "candidate", "prob"],
                            ascending=[True, True, False, False])
    rows[cols].to_csv(os.path.join(DATA, "nfl_td1_preds.csv"), index=False, float_format="%.6g")
    out["deliverable"] = {"rows": int(len(rows)), "candidate_rows": int(rows.candidate.sum()),
                          "games": int(rows.event_id.nunique()),
                          "games_first_td_by_candidate": int(rows[rows.candidate == 1]
                                                             .groupby("event_id").first_td.max().sum())}
    print("\nwrote data/nfl_td1_preds.csv:", json.dumps(out["deliverable"]))
    json.dump(out, open(os.path.join(RESULTS, "nfl_td1_metrics.json"), "w"), indent=1)
    print("wrote results/nfl_td1_metrics.json")


if __name__ == "__main__":
    main()
