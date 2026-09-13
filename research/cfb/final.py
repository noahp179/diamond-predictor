"""
The production college-TD model: the definitive held-out numbers, then the
export the app actually runs.

Two fits, deliberately:

  the honest one   trained on 2021-2024, scored on 2025 and 2026. Every number
                   quoted in CFB-ANALYSIS.md and shown on the board comes from
                   here — the model had never seen those seasons.

  the shipped one  the same specification refitted on 2021-2026, because when
                   the board runs on Saturday there is no reason to throw away
                   a season and a half of evidence. Its coefficients go into
                   src/lib/cfb-td-model.json.

The export carries a self-test: three feature vectors and the probabilities
this Python produces for them. scripts/test-cfb-td.ts replays them through the
TypeScript port and fails if the two disagree, so a porting slip cannot ship
quietly.
"""
import os, json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT_MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "cfb-td-model.json"))

TRAIN = [2021, 2022, 2023, 2024]
TEST = [2025, 2026]
ALL = TRAIN + TEST

# A second pick joins the card only when the model gives it at least this much.
# Chosen in selection.py: below it, pick-2 hit rates fall into the low 40s and
# then the 30s; at it they hold ~50% in both held-out seasons, and the board
# lands at 1.45 picks per game — genuinely "one or two", not a fixed two.
SECOND_PICK_MIN = 0.45

# Tier edges, set where the held-out hit rate actually steps.
TIERS = [("Strong", 0.62), ("Solid", 0.50), ("Lean", 0.0)]


def board(df, p, second_min=SECOND_PICK_MIN):
    """What the page would have shown: one pick per game, two when earned."""
    d = df.copy()
    d["p"] = p
    rows = []
    for gid, g in d.groupby("game_id"):
        g = g.sort_values("p", ascending=False).reset_index(drop=True)
        n = 2 if len(g) > 1 and g.loc[1, "p"] >= second_min else 1
        for i in range(min(n, len(g))):
            r = g.loc[i]
            rows.append({"game_id": gid, "season": r.season, "rank": i + 1,
                         "p": r.p, "scored": int(r.scored), "player": r.player,
                         "team": r.team, "date": r.date})
    return pd.DataFrame(rows)


def metrics(y, p):
    return {"n": int(len(y)), "auc": float(roc_auc_score(y, p)),
            "logloss": float(log_loss(y, p)), "brier": float(brier_score_loss(y, p)),
            "base_rate": float(np.mean(y))}


def main():
    df = pd.read_csv(os.path.join(DATA, "features.csv"))
    lg = json.load(open(os.path.join(DATA, "league_rates.json")))

    tr = df[df.season.isin(TRAIN)]
    sc = StandardScaler().fit(tr[F.FEATURES].values)
    lr = LogisticRegression(max_iter=2000, C=1.0).fit(sc.transform(tr[F.FEATURES].values),
                                                      tr.scored.values)
    te = df[df.season.isin(TEST)].copy()
    p_te = lr.predict_proba(sc.transform(te[F.FEATURES].values))[:, 1]

    report = {"train_seasons": TRAIN, "test_seasons": TEST,
              "rows": {"train": int(len(tr)), "test": int(len(te))},
              "second_pick_min": SECOND_PICK_MIN}

    print("=== ranking quality, held out ===")
    report["holdout"] = metrics(te.scored.values, p_te)
    print(f"  all candidate rows: n={report['holdout']['n']:,} AUC {report['holdout']['auc']:.4f} "
          f"logloss {report['holdout']['logloss']:.4f} brier {report['holdout']['brier']:.4f}")
    report["by_season"] = {}
    for s in TEST:
        m = te.season == s
        report["by_season"][str(s)] = metrics(te.scored.values[m.values], p_te[m.values])
        print(f"  {s}: n={int(m.sum()):,} AUC {report['by_season'][str(s)]['auc']:.4f}")

    b = board(te, p_te)
    per_game = b.groupby("game_id").scored.max()
    report["board"] = {
        "games": int(b.game_id.nunique()),
        "picks": int(len(b)),
        "picks_per_game": float(len(b) / b.game_id.nunique()),
        "pick_hit_rate": float(b.scored.mean()),
        "game_hit_rate": float(per_game.mean()),
        "one_pick_games": int((b.groupby("game_id").size() == 1).sum()),
        "two_pick_games": int((b.groupby("game_id").size() == 2).sum()),
        "lead_hit": float(b[b["rank"] == 1].scored.mean()),
        "second_hit": float(b[b["rank"] == 2].scored.mean()),
    }
    two = b[b.game_id.isin(b.groupby("game_id").size()[lambda s: s == 2].index)]
    gg = two.groupby("game_id").scored
    report["board"]["two_pick_both"] = float((gg.sum() == 2).mean())
    report["board"]["two_pick_either"] = float((gg.max() == 1).mean())
    r = report["board"]
    print("\n=== the board, held out ===")
    print(f"  {r['games']} games -> {r['picks']} picks ({r['picks_per_game']:.2f}/game); "
          f"{r['one_pick_games']} one-pick, {r['two_pick_games']} two-pick")
    print(f"  every shown pick:     {r['pick_hit_rate']*100:.1f}% scored")
    print(f"  lead pick:            {r['lead_hit']*100:.1f}%")
    print(f"  second pick:          {r['second_hit']*100:.1f}%")
    print(f"  game with a hit:      {r['game_hit_rate']*100:.1f}%")
    print(f"  two-pick games:       {r['two_pick_either']*100:.1f}% at least one, "
          f"{r['two_pick_both']*100:.1f}% both")

    print("\n=== what a fixed board would have done ===")
    d = te.copy(); d["p"] = p_te
    fixed = {}
    for k in (1, 2, 3):
        rows = d.groupby("game_id", group_keys=False).apply(
            lambda g: g.nlargest(k, "p"), include_groups=False)
        fixed[str(k)] = {"pick_hit_rate": float(rows.scored.mean()), "picks_per_game": float(k)}
        print(f"  always {k}: {rows.scored.mean()*100:.1f}% of shown picks scored")
    report["fixed_boards"] = fixed

    print("\n=== tiers, held out ===")
    report["tiers"] = []
    for i, (name, lo) in enumerate(TIERS):
        hi = TIERS[i - 1][1] if i > 0 else 1.01
        s = b[(b.p >= lo) & (b.p < hi)]
        by_season = {str(y): float(s[s.season == y].scored.mean()) for y in TEST
                     if (s.season == y).sum() >= 20}
        report["tiers"].append({"label": name, "min": lo, "n": int(len(s)),
                                "hit": float(s.scored.mean()), "by_season": by_season})
        print(f"  {name:<7} p in [{lo:.2f},{hi:.2f}): {s.scored.mean()*100:5.1f}% "
              f"(n={len(s)}, {len(s)/len(b)*100:.0f}% of picks)  {by_season}")

    print("\n=== calibration, held out (shown picks) ===")
    report["calibration"] = []
    for lo, hi in [(0, .50), (.50, .60), (.60, .70), (.70, 1.01)]:
        s = b[(b.p >= lo) & (b.p < hi)]
        if len(s) < 40:
            continue
        report["calibration"].append({"band": f"{lo:.2f}-{hi:.2f}", "n": int(len(s)),
                                      "predicted": float(s.p.mean()), "actual": float(s.scored.mean())})
        print(f"  p {lo:.2f}-{hi:.2f}: predicted {s.p.mean()*100:5.1f}%  actual {s.scored.mean()*100:5.1f}%  n={len(s)}")

    # ------------------------------------------------------------- the export
    al = df[df.season.isin(ALL)]
    sc2 = StandardScaler().fit(al[F.FEATURES].values)
    lr2 = LogisticRegression(max_iter=2000, C=1.0).fit(sc2.transform(al[F.FEATURES].values),
                                                       al.scored.values)
    sample = al[F.FEATURES].values[:3]
    export = {
        "features": F.FEATURES,
        "mean": sc2.mean_.tolist(),
        "std": sc2.scale_.tolist(),
        "coef": lr2.coef_[0].tolist(),
        "intercept": float(lr2.intercept_[0]),
        "constants": {"K_RUSH": F.K_RUSH, "K_REC": F.K_REC, "K_ANY": F.K_ANY,
                      "LG_RUSH": lg["LG_RUSH"], "LG_REC": lg["LG_REC"], "LG_ANY": lg["LG_ANY"],
                      "USAGE_WINDOW": F.USAGE_WINDOW,
                      "ELO_K": 40, "ELO_HFA": 55, "ELO_CARRY": 0.60},
        "second_pick_min": SECOND_PICK_MIN,
        "tiers": [{"label": n, "min": lo,
                   "hit": next(t["hit"] for t in report["tiers"] if t["label"] == n)}
                  for n, lo in TIERS],
        "notes": ("P(anytime rush/rec TD) = sigmoid(w.z + b) over standardized season-to-date "
                  "features. No market inputs: ESPN does not retain college lines. "
                  "Fitted on 2021-2026; every metric quoted is from the 2021-2024 fit "
                  "scored on 2025-2026."),
        "trained_seasons": ALL,
        "holdout": {"seasons": TEST, "auc": report["holdout"]["auc"],
                    "pick_hit_rate": report["board"]["pick_hit_rate"],
                    "picks_per_game": report["board"]["picks_per_game"],
                    "game_hit_rate": report["board"]["game_hit_rate"]},
        "selftest": [{"x": row.tolist(),
                      "p": float(lr2.predict_proba(sc2.transform(row.reshape(1, -1)))[0, 1])}
                     for row in sample],
    }
    json.dump(export, open(OUT_MODEL, "w"), indent=1)
    print(f"\nwrote {OUT_MODEL}")
    json.dump(report, open(os.path.join(HERE, "final_metrics.json"), "w"), indent=1)
    print("wrote final_metrics.json")


if __name__ == "__main__":
    main()
