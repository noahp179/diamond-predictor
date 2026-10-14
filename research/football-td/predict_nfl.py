"""
Held-out predictions of the SHIPPED NFL touchdown ranker, with outcomes.

    python3 research/football-td/predict_nfl.py
    (after fetch_nfl.py, features_nfl.py and, for positions, fetch_rosters.py)

The shipped artifact (src/lib/nfl-td-ranker.json) is the deployment fit on
2021-26, so it has seen the test seasons. The honest held-out model is the one
export_ranker.py builds for its quoted numbers: `fit_bundle` on 2021-24 only,
scored on 2025 + 2026. That bundle is not stored anywhere, so it is refitted
here with the identical procedure (copied verbatim below, no imports from the
original directory):

  * StandardScaler on the 20,379 training rows,
  * within-game pairwise ranker, weights averaged over seeds 0..19
    (pairs: first <=4 scorers x <=4 sampled non-scorers per game, random sign,
    LogisticRegression(fit_intercept=False, C=1, max_iter=5000)),
  * Platt fitted on the last 20% of training rows with a ranker refitted on
    the first 80%,
  * inferRanker: s = w.z, p = sigmoid(a*s + b), then 0.8*p + 0.2*base.

Checks performed (results/nfl_metrics.json):
  1. the DEPLOYMENT fit (2021-24 + 2025 + 2026 through 2026-09-16, the data the
     export saw) is rebuilt and compared with the shipped JSON: weights, Platt,
     base, mean/std and the three self-test vectors;
  2. held-out metrics on the quoted 301-game subset vs the quoted numbers;
  3. held-out metrics on everything played to date.

Output: data/nfl_model_preds.csv (one row per player-game, see README.md).
"""
import os, sys, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RESULTS = os.path.join(HERE, "results")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SHIPPED = os.path.join(ROOT, "src", "lib", "nfl-td-ranker.json")
os.makedirs(RESULTS, exist_ok=True)

ART = json.load(open(SHIPPED))
FEATURES = ART["features"]
TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]
SEEDS = list(range(20))
SHRINK = 0.20
# The export (commit 4473c13, 2026-09-18 00:18 UTC) saw 2026 Week 1 only:
# 285 games of 2025 + 16 of 2026 = the 301 quoted games.
EXPORT_CUTOFF = "2026-09-16"


# ---------------------------------------------------- verbatim from the original
def ece(y, p, bins=10):  # research/nfl-td-scorer/bakeoff_nfl.py
    y, p = np.asarray(y), np.asarray(p)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        total += (m.sum() / len(y)) * abs(p[m].mean() - y[m].mean())
    return total


def per_game_top1(te, score):  # research/nfl-td-scorer/bakeoff_nfl.py
    d = te[["game_id", "scored", "date"]].copy()
    d["s"] = score
    hits, gids = [], []
    for gid, g in d.groupby("game_id"):
        top = g.loc[g.s.idxmax()]
        hits.append(int(top.scored))
        gids.append(gid)
    return np.array(hits), np.array(gids)


def build_pairs(X, y, gid, seed, cap_pos=4, cap_neg=4):  # rank_study.py
    rng = np.random.default_rng(seed)
    order = np.argsort(gid, kind="stable")
    Xs, ys, gs = X[order], y[order], gid[order]
    starts = np.searchsorted(gs, np.unique(gs))
    bounds = list(starts) + [len(gs)]
    diffs, labels = [], []
    for a, b in zip(bounds[:-1], bounds[1:]):
        yi = ys[a:b]
        pos = np.flatnonzero(yi == 1) + a
        neg = np.flatnonzero(yi == 0) + a
        if len(pos) == 0 or len(neg) == 0:
            continue
        for i in pos[: min(len(pos), cap_pos)]:
            for j in rng.choice(neg, size=min(len(neg), cap_neg), replace=False):
                d = Xs[i] - Xs[j]
                if rng.random() < 0.5:
                    diffs.append(d); labels.append(1)
                else:
                    diffs.append(-d); labels.append(0)
    return np.asarray(diffs), np.asarray(labels)


def fit_ranker(X, y, gid, seed, C=1.0, cap_pos=4, cap_neg=4):  # rank_study.py
    D, L = build_pairs(X, y, gid, seed, cap_pos, cap_neg)
    m = LogisticRegression(max_iter=5000, fit_intercept=False, C=C).fit(D, L)
    return m.coef_[0], len(D)


def fit_bundle(df, seasons):  # export_ranker.py
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[FEATURES].values)
    X, y, g = sc.transform(tr[FEATURES].values), tr.scored.values, tr.game_id.values
    W = np.mean([fit_ranker(X, y, g, s)[0] for s in SEEDS], axis=0)
    cut = int(len(tr) * 0.80)
    m_fit = np.arange(len(tr)) < cut
    Wc = np.mean([fit_ranker(X[m_fit], y[m_fit], g[m_fit], s)[0] for s in SEEDS], axis=0)
    pl = LogisticRegression(max_iter=2000).fit((X[~m_fit] @ Wc).reshape(-1, 1), y[~m_fit])
    return {
        "mean": sc.mean_, "std": sc.scale_, "w": W,
        "a": float(pl.coef_[0][0]), "b": float(pl.intercept_[0]),
        "base": float(y.mean()),
    }


def predict(bundle, raw):  # export_ranker.py == inferRanker in nfl-td-ranker.ts
    z = (raw - bundle["mean"]) / bundle["std"]
    s = z @ bundle["w"]
    p = 1 / (1 + np.exp(-(bundle["a"] * s + bundle["b"])))
    return (1 - SHRINK) * p + SHRINK * bundle["base"]
# ------------------------------------------------------------------------------


def ts_check(X):
    """Run the shipped TypeScript inferRanker (deployed weights) on X."""
    import subprocess
    tmp = os.path.join(DATA, "cache")
    os.makedirs(tmp, exist_ok=True)
    fin, fout = os.path.join(tmp, "ts_in_nfl.json"), os.path.join(tmp, "ts_out_nfl.json")
    json.dump(X.tolist(), open(fin, "w"))
    r = subprocess.run(["npx", "tsx", os.path.join(HERE, "ts_infer.ts"), "nfl", fin, fout],
                       cwd=ROOT, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        print("  ts check failed:", r.stderr[-500:])
        return None, None
    return np.array(json.load(open(fout))), json.loads(r.stdout.strip().splitlines()[-1])


def metrics(sub, p):
    y = sub.scored.values
    hits, _ = per_game_top1(sub, p)
    d = sub[["game_id", "scored"]].copy()
    d["p"] = p
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    return {
        "rows": int(len(sub)), "games": int(sub.game_id.nunique()),
        "base_rate": float(y.mean()),
        "top1": float(hits.mean()), "top1_hits": int(hits.sum()),
        "lead_stated": float(lead.p.mean()), "lead_actual": float(lead.scored.mean()),
        "auc": float(roc_auc_score(y, p)), "logloss": float(log_loss(y, p)),
        "brier": float(brier_score_loss(y, p)), "ece": float(ece(y, p)),
    }


def fmt(m):
    return (f"rows {m['rows']:>6,}  games {m['games']:>4}  top1 {m['top1']*100:5.2f}% "
            f"({m['top1_hits']}/{m['games']})  auc {m['auc']:.4f}  ll {m['logloss']:.4f}  "
            f"brier {m['brier']:.4f}  ece {m['ece']:.4f}  lead {m['lead_stated']*100:.1f}/"
            f"{m['lead_actual']*100:.1f}")


def main():
    allrows = pd.read_csv(os.path.join(DATA, "nfl_features_all.csv"),
                          dtype={"player_id": str, "espn_team_id": str,
                                 "unpriced_reason": str}, low_memory=False)
    # the original pipeline wrote and re-read nfl_features.csv, so game_id is
    # an int there; the pair sampler argsorts it, so keep the same dtype.
    allrows["game_id"] = allrows["game_id"].astype(np.int64)
    df = allrows[allrows.kind == "candidate"].reset_index(drop=True)
    out = {"quoted": ART["heldout"], "export_cutoff": EXPORT_CUTOFF}

    # ------------------------------------------------ 1. deployment-fit check
    dep = df[(df.season < 2026) | (df.date <= EXPORT_CUTOFF)].reset_index(drop=True)
    full = fit_bundle(dep, TRAIN + TEST)
    chk = {
        "rows": int(len(dep)),
        "max_abs_w_diff": float(np.abs(full["w"] - np.array(ART["w"])).max()),
        "max_abs_mean_rel_diff": float(np.abs(full["mean"] / np.array(ART["mean"]) - 1).max()),
        "max_abs_std_rel_diff": float(np.abs(full["std"] / np.array(ART["std"]) - 1).max()),
        "platt_a": [full["a"], ART["platt_a"]], "platt_b": [full["b"], ART["platt_b"]],
        "base": [full["base"], ART["base"]],
    }
    idx = [0, len(dep) // 2, len(dep) - 1]
    chk["selftest_x_max_abs_diff"] = float(max(
        np.abs(dep.loc[i, FEATURES].values.astype(float) - np.array(t["x"])).max()
        for i, t in zip(idx, ART["selftest"])))
    shipped_bundle = {"mean": np.array(ART["mean"]), "std": np.array(ART["std"]),
                      "w": np.array(ART["w"]), "a": ART["platt_a"], "b": ART["platt_b"],
                      "base": ART["base"]}
    chk["selftest_p_max_abs_diff_shipped_weights"] = float(max(
        abs(predict(shipped_bundle, np.array(t["x"])[None, :])[0] - t["p"])
        for t in ART["selftest"]))
    out["deployment_fit_check"] = chk
    print("--- deployment fit (2021-24 + 2025 + 2026 to the export cutoff) vs shipped JSON ---")
    print(json.dumps(chk, indent=1))

    # ------------------------------------------------ 2. the held-out bundle
    ho = fit_bundle(df, TRAIN)
    out["heldout_bundle"] = {"w": ho["w"].tolist(), "mean": ho["mean"].tolist(),
                             "std": ho["std"].tolist(), "platt_a": ho["a"],
                             "platt_b": ho["b"], "base": ho["base"], "shrink": SHRINK,
                             "features": FEATURES, "train_seasons": TRAIN,
                             "train_rows": int(df.season.isin(TRAIN).sum())}
    te = df[df.season.isin(TEST)].reset_index(drop=True)
    te["prob"] = predict(ho, te[FEATURES].values.astype(float))
    quoted = te[(te.season < 2026) | (te.date <= EXPORT_CUTOFF)].reset_index(drop=True)

    res = {}
    res["quoted_subset"] = metrics(quoted, quoted.prob.values)
    res["all_to_date"] = metrics(te, te.prob.values)
    for s in TEST:
        sub = te[te.season == s].reset_index(drop=True)
        res[f"season_{s}"] = metrics(sub, sub.prob.values)
    post = te[te.game_type.isin(["WC", "DIV", "CON", "SB"])].reset_index(drop=True)
    res["postseason_2025"] = metrics(post, post.prob.values)
    late = te[(te.season == 2026) & (te.date > EXPORT_CUTOFF)].reset_index(drop=True)
    if len(late):
        res["after_export_2026"] = metrics(late, late.prob.values)
    if len(late):
        # the deployed weights are out-of-sample only on these games
        res["after_export_2026_deployed_weights"] = metrics(
            late, predict(shipped_bundle, late[FEATURES].values.astype(float)))
    out["heldout"] = res
    print("\n--- held-out (fit 2021-24) ---")
    q = ART["heldout"]
    print(f"  quoted           top1 {q['top1']*100:5.2f}% ({round(q['top1']*q['games'])}/"
          f"{q['games']})  auc {q['auc']:.4f}  ll {q['logloss']:.4f}  brier {q['brier']:.4f}  "
          f"ece {q['ece']:.4f}  lead {q['lead_stated']*100:.1f}/{q['lead_actual']*100:.1f}")
    for k, m in res.items():
        print(f"  {k:<16} {fmt(m)}")

    # ------------------------------------------------ 3. the deliverable
    ext = allrows[allrows.season.isin(TEST) & (allrows.kind != "candidate")].copy()
    priced = ext.kind == "no_touch"
    ext["prob"] = np.nan
    ext.loc[priced, "prob"] = predict(ho, ext.loc[priced, FEATURES].values.astype(float))
    full_rows = pd.concat([te, ext], ignore_index=True, sort=False)
    # The DEPLOYED weights (src/lib/nfl-td-ranker.json, fitted on 2021-24 + 2025
    # + 2026 Week 1) as a second column: in-sample on those games, genuinely
    # out-of-sample on 2026 games after the export cutoff, which is what the
    # live board actually ran on (modulo its roster filter and odds feed).
    pr = full_rows.prob.notna()
    full_rows["prob_deployed"] = np.nan
    full_rows.loc[pr, "prob_deployed"] = predict(
        shipped_bundle, full_rows.loc[pr, FEATURES].values.astype(float))
    p_ts, info = ts_check(full_rows.loc[pr, FEATURES].values.astype(float))
    if p_ts is not None:
        out["ts_check_deployed_weights"] = {
            "rows": int(pr.sum()),
            "max_abs_diff": float(np.abs(p_ts - full_rows.loc[pr, "prob_deployed"].values).max()),
            "module_selftest": info.get("selftest")}
        print("TypeScript inferRanker (deployed weights) vs numpy:",
              out["ts_check_deployed_weights"])

    pos_fp = os.path.join(DATA, "nfl_positions.csv")
    if os.path.exists(pos_fp):
        pos = pd.read_csv(pos_fp, dtype={"player_id": str})
        full_rows = full_rows.merge(pos[["player_id", "position"]], on="player_id", how="left")
    else:
        full_rows["position"] = ""

    full_rows["candidate"] = (full_rows.kind == "candidate").astype(int)
    full_rows["in_box"] = (full_rows.kind != "no_touch").astype(int)
    full_rows["priced"] = full_rows.prob.notna().astype(int)
    full_rows["in_quoted_subset"] = (((full_rows.season < 2026) |
                                      (full_rows.date <= EXPORT_CUTOFF)) &
                                     (full_rows.candidate == 1)).astype(int)
    full_rows["touchdowns"] = full_rows.td_count.astype(int)
    full_rows = full_rows.rename(columns={
        "game_id": "event_id", "espn_team_id": "team_id", "player": "player_name",
        "car_g": "carries", "tgt_g": "targets", "rush_td_g": "rush_td", "rec_td_g": "rec_td",
    })
    # team_id for no_touch rows: same team, take it from that game's other rows
    tid = (full_rows[full_rows.team_id.notna()]
           .groupby(["event_id", "team"]).team_id.first())
    miss = full_rows.team_id.isna()
    full_rows.loc[miss, "team_id"] = [tid.get((e, t), "") for e, t in
                                      zip(full_rows.loc[miss, "event_id"],
                                          full_rows.loc[miss, "team"])]
    cols = (["season", "week", "game_type", "date", "event_id", "team_id", "team", "opp",
             "is_home", "player_id", "player_name", "position", "prob", "prob_deployed", "scored",
             "touchdowns", "rush_td", "rec_td", "carries", "targets",
             "candidate", "kind", "in_box", "priced", "in_quoted_subset",
             "unpriced_reason", "games_since_touch", "carried"]
            + [f"f_{f}" for f in FEATURES])
    for f in FEATURES:
        full_rows[f"f_{f}"] = full_rows[f]
    full_rows = full_rows.sort_values(["date", "event_id", "team", "candidate", "prob"],
                                      ascending=[True, True, True, False, False])
    full_rows[cols].to_csv(os.path.join(DATA, "nfl_model_preds.csv"), index=False,
                           float_format="%.6g")
    kinds = full_rows.kind.value_counts().to_dict()
    out["deliverable"] = {"rows": int(len(full_rows)), "kinds": kinds,
                          "candidate_rows": int(full_rows.candidate.sum()),
                          "games": int(full_rows.event_id.nunique()),
                          "td_scorers_total": int((full_rows.scored == 1).sum()),
                          "td_scorers_candidates": int(((full_rows.scored == 1) &
                                                        (full_rows.candidate == 1)).sum()),
                          "position_missing": int((full_rows.position.isna() |
                                                   (full_rows.position == "")).sum())}
    print(f"\nwrote data/nfl_model_preds.csv: {json.dumps(out['deliverable'])}")
    json.dump(out, open(os.path.join(RESULTS, "nfl_metrics.json"), "w"), indent=1)
    print("wrote results/nfl_metrics.json")


if __name__ == "__main__":
    main()
