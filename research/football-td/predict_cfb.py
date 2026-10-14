"""
Held-out predictions of the SHIPPED college touchdown model, with outcomes.

    python3 research/football-td/predict_cfb.py
    (after fetch_cfb.py, features_cfb.py and, for positions, fetch_rosters.py)

Unlike the NFL ranker, the shipped CFB artifact IS the held-out model:
export_forest.py fits the exported ExtraTrees(200, min_samples_leaf=20,
seed 0) on Xtr = 2021-24 only, Platt on a held-back 20% tail of 2021-24, and
quotes 2025-26 from that same fit (its `trained_seasons` field says 2021-26,
but the code fits `model` on Xtr). So no refit is needed or attempted: the
forest in src/lib/cfb-td-forest.json is evaluated directly, exactly as
inferForest() in src/lib/cfb-td-forest.ts does it:

    z = (x - mean) / std
    walk each tree: z[f] <= float32 threshold ? left : right  (leaf: f == 255)
    raw = mean of the 200 leaf values
    p = sigmoid(a * logit(clip(raw, 1e-6, 1-1e-6)) + b)

The numpy walk below is checked against the TypeScript function itself on every
row (ts_infer.ts) and against the JSON's own self-test vectors.

Output: data/cfb_model_preds.csv (see README.md), results/cfb_metrics.json.
"""
import os, sys, json, base64, subprocess
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RESULTS = os.path.join(HERE, "results")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SHIPPED_FP = os.path.join(ROOT, "src", "lib", "cfb-td-forest.json")
os.makedirs(RESULTS, exist_ok=True)

M = json.load(open(SHIPPED_FP))
FEATURES = M["features"]
TEST = [2025, 2026]
# Data cutoff of the export's dataset; matches the quoted 1,130 games.
EXPORT_CUTOFF = os.environ.get("CFB_EXPORT_CUTOFF", "2026-09-12")
SECOND_MIN = M["second_pick_min"]


def ece(y, p, bins=10):  # research/cfb/bakeoff_big.py, verbatim
    y, p = np.asarray(y), np.asarray(p)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        total += (m.sum() / len(y)) * abs(p[m].mean() - y[m].mean())
    return total


class Forest:
    def __init__(self, m):
        t = m["trees"]
        dec = lambda k, dt: np.frombuffer(base64.b64decode(t[k]), dtype=dt)
        self.feat = dec("feature", np.uint8).astype(np.int64)
        self.thr = dec("threshold", np.float32).astype(np.float64)
        self.left = dec("left", np.uint16).astype(np.int64)
        self.right = dec("right", np.uint16).astype(np.int64)
        self.val = dec("value", np.float32).astype(np.float64)
        self.offs = np.concatenate([[0], np.cumsum(t["node_counts"])]).astype(np.int64)
        assert self.offs[-1] == t["total_nodes"]
        self.mean, self.std = np.array(m["mean"]), np.array(m["std"])
        self.a, self.b = m["platt_a"], m["platt_b"]

    def raw_from_z(self, Z):
        n = len(Z)
        acc = np.zeros(n)
        rows = np.arange(n)
        for ti in range(len(self.offs) - 1):
            o = self.offs[ti]
            node = np.zeros(n, dtype=np.int64)
            for _ in range(4096):
                f = self.feat[o + node]
                live = f != 255
                if not live.any():
                    break
                fl = np.where(live, f, 0)
                go_left = Z[rows, fl] <= self.thr[o + node]
                nxt = np.where(go_left, self.left[o + node], self.right[o + node])
                node = np.where(live, nxt, node)
            acc += self.val[o + node]
        return acc / (len(self.offs) - 1)

    def calibrate(self, raw):
        q = np.clip(raw, 1e-6, 1 - 1e-6)
        z = self.a * np.log(q / (1 - q)) + self.b
        return 1 / (1 + np.exp(-z))

    def predict(self, X):
        return self.calibrate(self.raw_from_z((X - self.mean) / self.std))


def metrics(sub, p):
    y = sub.scored.values
    d = sub[["game_id", "scored", "season", "date"]].copy()
    d["p"] = p
    hits = np.array([int(g.loc[g.p.idxmax()].scored) for _, g in d.groupby("game_id")])
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    # the board: lead pick + second pick when p >= second_pick_min (export_forest.py)
    ranked = []
    for gid, g in d.groupby("game_id"):
        g = g.sort_values("p", ascending=False).reset_index(drop=True)
        for i in range(min(3, len(g))):
            ranked.append((gid, i + 1, g.loc[i, "p"], int(g.loc[i, "scored"])))
    R = pd.DataFrame(ranked, columns=["game_id", "rank", "p", "scored"])
    shown = R[(R["rank"] == 1) | ((R["rank"] == 2) & (R.p >= SECOND_MIN))]
    return {
        "rows": int(len(sub)), "games": int(sub.game_id.nunique()),
        "slates": int(sub.date.nunique()), "base_rate": float(y.mean()),
        "top1": float(hits.mean()), "top1_hits": int(hits.sum()),
        "lead_stated": float(lead.p.mean()), "lead_actual": float(lead.scored.mean()),
        "auc": float(roc_auc_score(y, p)), "logloss": float(log_loss(y, p)),
        "brier": float(brier_score_loss(y, p)), "ece": float(ece(y, p)),
        "pick_hit_rate": float(shown.scored.mean()),
        "picks_per_game": float(len(shown) / shown.game_id.nunique()),
        "game_hit_rate": float(shown.groupby("game_id").scored.max().mean()),
    }


def fmt(m):
    return (f"rows {m['rows']:>6,}  games {m['games']:>5}  slates {m['slates']:>3}  "
            f"top1 {m['top1']*100:5.2f}% ({m['top1_hits']}/{m['games']})  auc {m['auc']:.4f}  "
            f"ll {m['logloss']:.4f}  brier {m['brier']:.4f}  ece {m['ece']:.4f}  "
            f"lead {m['lead_stated']*100:.1f}/{m['lead_actual']*100:.1f}")


def ts_check(X, tag):
    """Run the shipped TypeScript inferForest on X; returns its probabilities."""
    tmp = os.path.join(DATA, "cache")
    os.makedirs(tmp, exist_ok=True)
    fin, fout = os.path.join(tmp, f"ts_in_{tag}.json"), os.path.join(tmp, f"ts_out_{tag}.json")
    json.dump(X.tolist(), open(fin, "w"))
    r = subprocess.run(["npx", "tsx", os.path.join(HERE, "ts_infer.ts"), "cfb", fin, fout],
                       cwd=ROOT, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        print("  ts check failed:", r.stderr[-500:])
        return None, None
    return np.array(json.load(open(fout))), json.loads(r.stdout.strip().splitlines()[-1])


def main():
    allrows = pd.read_csv(os.path.join(DATA, "cfb_features_all.csv"),
                          dtype={"player_id": str, "team_id": str, "unpriced_reason": str},
                          low_memory=False)
    forest = Forest(M)
    out = {"quoted": M["holdout"], "quoted_board": M["board"],
           "export_cutoff": EXPORT_CUTOFF}

    df = allrows[allrows.kind == "candidate"].reset_index(drop=True)
    tr = df[df.season.isin([2021, 2022, 2023, 2024])]
    te = df[df.season.isin(TEST)].reset_index(drop=True)
    # check 1: the training standardiser reproduces the shipped mean/std
    out["train_scaler_check"] = {
        "train_rows": int(len(tr)),
        "max_rel_mean_diff": float(np.abs(tr[FEATURES].mean().values / forest.mean - 1).max()),
        "max_rel_std_diff": float(np.abs(tr[FEATURES].std(ddof=0).values / forest.std - 1).max()),
    }
    print("train scaler check:", out["train_scaler_check"])

    X = te[FEATURES].values.astype(float)
    te["prob"] = forest.predict(X)
    te["raw_forest"] = forest.raw_from_z((X - forest.mean) / forest.std)

    # check 2: shipped self-test vectors (stored standardised = first 5 test rows)
    Zs = np.array([t["x"] for t in M["selftest"]])
    ps = np.array([t["p"] for t in M["selftest"]])
    zt = (X[:5] - forest.mean) / forest.std
    out["selftest_check"] = {
        "p_from_selftest_x_max_abs_diff": float(np.abs(forest.calibrate(
            forest.raw_from_z(Zs)) - ps).max()),
        "first5_test_rows_x_max_abs_diff": float(np.abs(zt - Zs).max()),
        "first5_test_rows_p_max_abs_diff": float(np.abs(te.prob.values[:5] - ps).max()),
    }
    print("selftest check:", out["selftest_check"])

    quoted = te[te.date <= EXPORT_CUTOFF].reset_index(drop=True)
    res = {"quoted_subset": metrics(quoted, quoted.prob.values),
           "all_to_date": metrics(te, te.prob.values)}
    for s in TEST:
        sub = te[te.season == s].reset_index(drop=True)
        res[f"season_{s}"] = metrics(sub, sub.prob.values)
    late = te[te.date > EXPORT_CUTOFF].reset_index(drop=True)
    if len(late):
        res["after_export_2026"] = metrics(late, late.prob.values)
    out["heldout"] = res
    q = M["holdout"]
    print("\n--- held-out (shipped forest = 2021-24 fit) ---")
    print(f"  quoted           games  1130  top1 {q['top1']*100:5.2f}%  auc {q['auc']:.4f}  "
          f"ll {q['logloss']:.4f}  ece {q['ece']:.4f}  pick_hit {q['pick_hit_rate']:.4f}  "
          f"ppg {q['picks_per_game']:.4f}  game_hit {q['game_hit_rate']:.4f}")
    for k, m in res.items():
        print(f"  {k:<16} {fmt(m)}  pick_hit {m['pick_hit_rate']:.4f}  "
              f"ppg {m['picks_per_game']:.4f}  game_hit {m['game_hit_rate']:.4f}")

    # deliverable rows
    ext = allrows[allrows.season.isin(TEST) & (allrows.kind != "candidate")].copy()
    priced = (ext.kind == "no_touch").values
    ext["prob"] = np.nan
    if priced.any():
        ext.loc[priced, "prob"] = forest.predict(ext.loc[priced, FEATURES].values.astype(float))
    full = pd.concat([te, ext], ignore_index=True, sort=False)

    # check 3: the TypeScript inferForest on every priced row
    pr = full[full.prob.notna()]
    p_ts, info = ts_check(pr[FEATURES].values.astype(float), "cfb")
    if p_ts is not None:
        out["ts_check"] = {"rows": int(len(pr)), "max_abs_diff": float(np.abs(p_ts - pr.prob.values).max()),
                           "module_selftest": info.get("selftest")}
        print("TypeScript inferForest vs numpy:", out["ts_check"])

    pos_fp = os.path.join(DATA, "cfb_positions.csv")
    if os.path.exists(pos_fp):
        pos = pd.read_csv(pos_fp, dtype={"player_id": str})
        full = full.merge(pos[["player_id", "position"]], on="player_id", how="left")
    else:
        full["position"] = ""
    full["candidate"] = (full.kind == "candidate").astype(int)
    full["in_box"] = (full.kind != "no_touch").astype(int)
    full["priced"] = full.prob.notna().astype(int)
    full["in_quoted_subset"] = ((full.date <= EXPORT_CUTOFF) & (full.candidate == 1)).astype(int)
    full["touchdowns"] = full.td_count.astype(int)
    full = full.rename(columns={"game_id": "event_id", "player": "player_name",
                                "car_g": "carries", "rec_g": "receptions",
                                "rush_td_g": "rush_td", "rec_td_g": "rec_td"})
    for f in FEATURES:
        full[f"f_{f}"] = full[f]
    cols = (["season", "week", "season_type", "date", "event_id", "team_id", "team", "opp",
             "is_home", "player_id", "player_name", "position", "prob", "raw_forest",
             "scored", "touchdowns", "rush_td", "rec_td", "carries", "receptions",
             "candidate", "kind", "in_box", "priced", "in_quoted_subset",
             "unpriced_reason", "games_since_touch", "carried", "carried_games"]
            + [f"f_{f}" for f in FEATURES])
    full = full.sort_values(["date", "event_id", "team", "candidate", "prob"],
                            ascending=[True, True, True, False, False])
    full[cols].to_csv(os.path.join(DATA, "cfb_model_preds.csv"), index=False, float_format="%.6g")
    out["deliverable"] = {"rows": int(len(full)), "kinds": full.kind.value_counts().to_dict(),
                          "candidate_rows": int(full.candidate.sum()),
                          "games": int(full.event_id.nunique()),
                          "td_scorers_total": int((full.scored == 1).sum()),
                          "td_scorers_candidates": int(((full.scored == 1) & (full.candidate == 1)).sum()),
                          "position_missing": int((full.position.isna() | (full.position == "")).sum())}
    print(f"\nwrote data/cfb_model_preds.csv: {json.dumps(out['deliverable'])}")
    json.dump(out, open(os.path.join(RESULTS, "cfb_metrics.json"), "w"), indent=1)
    print("wrote results/cfb_metrics.json")


if __name__ == "__main__":
    main()
