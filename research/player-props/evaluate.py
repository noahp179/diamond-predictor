"""
evaluate.py — which method best predicts NBA points and NHL points/goals?

    python3 research/player-props/evaluate.py nba
    python3 research/player-props/evaluate.py nhl

Every candidate method is scored on the same player-games of the held-out
season (2025-26), with the same rule for who counts: every player listed for
the game, except those the injury report had out (listed as not playing for
an injury or illness). A coach's-decision scratch counts, as a miss — that
could not be known in the morning.

Methods
-------
  sim     the site's game simulator (scripts/props-backtest.ts), 1,000 plays
          of each game from the numbers known that morning.
  avg     the player's season average turned into a probability: Poisson for
          hockey's counts; for basketball points a negative binomial whose
          spread is fitted on the training season.
  fit     gradient-boosted trees on the as-of features (form, minutes, usage,
          team and opponent scoring), trained on
          2024-25 and calibrated with isotonic regression on a held-back
          slice of it.
  hybrid  the same trees with the simulator's own numbers added as inputs —
          "the simulation, plus an algorithm".
  sim_cal the simulator's numbers passed through an isotonic map learned on
          the training season's simulations (fixes over-confidence, keeps the
          order).
  blend   the plain average of sim_cal and fit.

Metrics, per line (e.g. 20+ points): Brier score and log loss (lower is
better), Brier skill against always quoting the base rate, AUC (how well it
ranks), the calibration table, and — what the board actually shows — the hit
rate of each day's top picks against what they were priced at.

Writes research/player-props/results/{sport}_backtest.json.
"""

from __future__ import annotations

import glob
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
from scipy import stats
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asof  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "results")

COACH = ("coach", "decision")

# (label, stat, threshold, sim key, sim line index)
TARGETS = {
    "nba": [
        ("10+ points", "pts", 10, "pts", 0),
        ("15+ points", "pts", 15, "pts", 1),
        ("20+ points", "pts", 20, "pts", 2),
        ("25+ points", "pts", 25, "pts", 3),
        ("30+ points", "pts", 30, "pts", 4),
    ],
    "nhl": [
        ("1+ point", "pts", 1, "pts", 0),
        ("2+ points", "pts", 2, "pts", 1),
        ("1+ goal", "g", 1, "g", 0),
        ("1+ assist", "a", 1, "a", 0),
    ],
}
TEST, TRAIN = 2025, 2024
TOP = 10  # picks per day the board would show for a line


def eligible(sport: str, p: dict) -> bool:
    if sport == "nhl" and p.get("grp") == "goalies":
        return False
    if not p.get("dnp"):
        return True
    reason = str(p.get("reason") or "").lower()
    return (not reason) or any(c in reason for c in COACH)


def load_sim(sport: str, season: int) -> dict:
    out = {}
    for path in glob.glob(os.path.join(DATA, f"sim_{sport}_{season}*.jsonl")):
        with open(path) as f:
            for line in f:
                g = json.loads(line)
                out[g["id"]] = g
    return out


FEATURES = {
    "nba": [
        "cur_pts", "prev_pts", "ew_pts", "last5", "sd_last10",
        "cur_min", "prev_min", "ew_min", "last_min",
        "cur_fga", "ew_fga", "cur_fta", "ew_fta", "cur_tpa", "ew_tpa", "ew_ast", "ew_tov",
        "gp", "prev_gp", "start_rate", "rest", "home",
        "opp_pa", "opp_ew_pa", "team_pf", "team_ew_pf", "lg_avg",
    ],
    "nhl": [
        "cur_pts", "prev_pts", "ew_pts", "cur_g", "prev_g", "ew_g", "cur_a", "ew_a",
        "last5", "cur_toi", "prev_toi", "ew_toi", "last_min", "cur_pptoi", "ew_pptoi",
        "cur_shots", "prev_shots", "ew_shots", "is_d",
        "gp", "prev_gp", "rest", "home",
        "opp_pa", "opp_ew_pa", "team_pf", "team_ew_pf", "lg_avg",
    ],
}
# ESPN kept the pre-game line (pickcenter) for 2025-26 only, not 2024-25, so a
# model trained on 2024-25 cannot learn from it; team strength comes in
# through each side's scoring and points allowed instead. The simulator does
# not read the line either, so every method sees the same information.


def rows_for(sport: str) -> list[dict]:
    seasons = [s for s in (2023, 2024, 2025) if os.path.exists(os.path.join(DATA, f"{sport}_{s}.jsonl"))]
    sims = {s: load_sim(sport, s) for s in (TRAIN, TEST)}
    rows = []
    for g, snap in asof.walk(sport, seasons):
        if g["season"] not in (TRAIN, TEST):
            continue
        sim = sims[g["season"]].get(g["id"])
        date = g["date"][:10]
        for p in g["players"]:
            pid = p.get("pid")
            if not pid or not eligible(sport, p) or pid not in snap:
                continue
            f = dict(snap[pid])
            line = asof.outcome(sport, p)
            y = line or {}
            r = {
                "season": g["season"],
                "gid": g["id"],
                "date": date,
                "stype": g.get("stype"),
                "pid": pid,
                "name": p.get("name"),
                "played": line is not None,
                "y_pts": y.get("pts", 0.0),
                "y_g": y.get("g", 0.0),
                "y_a": y.get("a", 0.0),
            }
            f["start_rate"] = f["starts"] / f["gp"] if f.get("gp") else None
            f["is_d"] = 1.0 if (p.get("grp") == "defenses") else 0.0
            f["home"] = 1.0 if f.get("home") else 0.0
            if sport == "nhl":
                f["cur_shots"] = f.get("cur_shots")
            r.update({k: f.get(k) for k in FEATURES[sport]})
            if sim is not None:
                sp = sim["players"].get(pid)
                r["sim_has"] = True
                r["sim_played"] = sp.get("played", 0.0) if sp else 0.0
                for key in ("pts", "g", "a"):
                    v = sp.get(key) if sp else None
                    r[f"sim_{key}_mean"] = v["mean"] if v else 0.0
                    r[f"sim_{key}_over"] = v["over"] if v else None
            else:
                r["sim_has"] = False
            rows.append(r)
    return rows


# --------------------------------------------------------------- metrics


def clip(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def metrics(y, p, dates) -> dict:
    y = np.asarray(y, dtype=float)
    p = clip(p)
    base = y.mean()
    brier = float(np.mean((p - y) ** 2))
    brier0 = float(np.mean((base - y) ** 2))
    ll = float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    try:
        auc = float(roc_auc_score(y, p))
    except ValueError:
        auc = float("nan")
    # calibration: 10 equal-count bins
    order = np.argsort(p)
    bins = np.array_split(order, 10)
    cal = [
        {"predicted": float(p[b].mean()), "actual": float(y[b].mean()), "n": int(len(b))}
        for b in bins
        if len(b)
    ]
    ece = float(sum(abs(c["predicted"] - c["actual"]) * c["n"] for c in cal) / len(y))
    # what the board shows: each day's top picks
    by_day = defaultdict(list)
    for i, d in enumerate(dates):
        by_day[d].append(i)
    hits = said = n_top = 0
    for idx in by_day.values():
        top = sorted(idx, key=lambda i: -p[i])[:TOP]
        hits += y[top].sum()
        said += p[top].sum()
        n_top += len(top)
    return {
        "n": int(len(y)),
        "base_rate": float(base),
        "brier": brier,
        "brier_skill": 1 - brier / brier0 if brier0 > 0 else 0.0,
        "log_loss": ll,
        "auc": auc,
        "ece": ece,
        "top_hit": float(hits / n_top) if n_top else None,
        "top_said": float(said / n_top) if n_top else None,
        "top_n": int(n_top),
        "calibration": cal,
    }


# ---------------------------------------------------------------- methods


def avg_mean(r: dict, stat: str) -> float:
    """Season average, last season carried in for the first games."""
    gp, pgp = r.get("gp") or 0, r.get("prev_gp") or 0
    cur = r.get(f"cur_{stat}")
    prev = r.get(f"prev_{stat}")
    k = 10.0  # last season's weight, in games
    num = (cur or 0) * gp + (prev or 0) * min(pgp, k)
    den = gp + (min(pgp, k) if prev is not None else 0)
    if den <= 0:
        return 0.0
    return num / den


def nb_tail(mu: np.ndarray, k: int, phi: float) -> np.ndarray:
    """P(X >= k) for a negative binomial with mean mu, var = mu + phi*mu^2."""
    mu = np.maximum(mu, 1e-6)
    r = 1.0 / phi
    pr = r / (r + mu)
    return stats.nbinom.sf(k - 1, r, pr)


def fit_phi(mu: np.ndarray, y: np.ndarray) -> float:
    best, best_ll = 0.1, float("inf")
    for phi in np.linspace(0.02, 0.6, 59):
        r = 1.0 / phi
        pr = r / (r + np.maximum(mu, 1e-6))
        ll = -stats.nbinom.logpmf(y.astype(int), r, pr).mean()
        if ll < best_ll:
            best, best_ll = phi, ll
    return float(best)


def matrix(rows: list[dict], cols: list[str]) -> np.ndarray:
    return np.array([[np.nan if r.get(c) is None else float(r[c]) for c in cols] for r in rows])


def fit_trees(Xtr, ytr, Xte, seed=7):
    """Gradient-boosted trees, isotonic-calibrated on the last fifth of the
    training season (chronological, so calibration never sees the future)."""
    cut = int(len(ytr) * 0.8)
    clf = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=80,
        l2_regularization=1.0, random_state=seed,
    )
    clf.fit(Xtr[:cut], ytr[:cut])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)
    iso.fit(clf.predict_proba(Xtr[cut:])[:, 1], ytr[cut:])
    # refit on everything for the final trees, keep the calibration map
    clf_all = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=80,
        l2_regularization=1.0, random_state=seed,
    )
    clf_all.fit(Xtr, ytr)
    return iso.predict(clf_all.predict_proba(Xte)[:, 1]), clf_all, iso


def main() -> None:
    sport = sys.argv[1]
    rows = rows_for(sport)
    tr = [r for r in rows if r["season"] == TRAIN]
    te = [r for r in rows if r["season"] == TEST]
    have_sim_tr = all(r["sim_has"] for r in tr) and len(tr) > 0
    print(f"{sport}: {len(tr)} training player-games, {len(te)} test; sim on train: {have_sim_tr}")
    te_sim = [r for r in te if r["sim_has"]]
    print(f"  test rows with a simulation: {len(te_sim)}")

    results = {"sport": sport, "train": TRAIN, "test": TEST, "n_train": len(tr), "n_test": len(te_sim), "targets": []}
    preds_out = {}

    for label, stat, thr, skey, sidx in TARGETS[sport]:
        ytr = np.array([1.0 if r[f"y_{stat}"] >= thr else 0.0 for r in tr])
        yte = np.array([1.0 if r[f"y_{stat}"] >= thr else 0.0 for r in te_sim])
        dates = [r["date"] for r in te_sim]
        P = {}

        # sim
        P["sim"] = np.array([
            (r[f"sim_{skey}_over"][sidx] if r.get(f"sim_{skey}_over") else 0.0) for r in te_sim
        ])

        # avg
        mu_tr = np.array([avg_mean(r, stat) for r in tr])
        mu_te = np.array([avg_mean(r, stat) for r in te_sim])
        if sport == "nba":
            phi = fit_phi(mu_tr[mu_tr > 0], np.array([r["y_pts"] for r in tr])[mu_tr > 0])
            P["avg"] = np.where(mu_te > 0, nb_tail(mu_te, thr, phi), 0.0)
        else:
            P["avg"] = np.where(mu_te > 0, stats.poisson.sf(thr - 1, np.maximum(mu_te, 1e-6)), 0.0)

        # fit
        cols = FEATURES[sport]
        Xtr, Xte = matrix(tr, cols), matrix(te_sim, cols)
        P["fit"], _, _ = fit_trees(Xtr, ytr, Xte)

        # sim, recalibrated: an isotonic map from the simulator's number to how
        # often it came in, learned on the training season's simulations. It
        # never reorders players (monotone), only corrects the percentages.
        if have_sim_tr:
            s_tr = np.array([
                (r[f"sim_{skey}_over"][sidx] if r.get(f"sim_{skey}_over") else 0.0) for r in tr
            ])
            iso = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)
            iso.fit(s_tr, ytr)
            P["sim_cal"] = iso.predict(P["sim"])

        # hybrid (needs the simulator on the training season too)
        if have_sim_tr:
            def simcols(rs):
                return np.array([
                    [
                        (r[f"sim_{skey}_over"][sidx] if r.get(f"sim_{skey}_over") else 0.0),
                        r.get(f"sim_{skey}_mean", 0.0),
                        r.get("sim_played", 0.0),
                    ]
                    for r in rs
                ])
            P["hybrid"], _, _ = fit_trees(np.hstack([Xtr, simcols(tr)]), ytr, np.hstack([Xte, simcols(te_sim)]))

        P["blend"] = 0.5 * P.get("sim_cal", P["sim"]) + 0.5 * P["fit"]

        res = {"label": label, "stat": stat, "threshold": thr, "methods": {}}
        for m, p in P.items():
            res["methods"][m] = metrics(yte, p, dates)
        if sport == "nba":
            res["nb_phi"] = phi
        results["targets"].append(res)
        preds_out[label] = {m: p.tolist() for m, p in P.items()}

        line = f"  {label:>11}  base {yte.mean():.3f}"
        print(line)
        for m, mt in res["methods"].items():
            print(
                f"    {m:>6}: brier {mt['brier']:.4f}  skill {mt['brier_skill']:+.3f}  ll {mt['log_loss']:.4f}"
                f"  auc {mt['auc']:.3f}  ece {mt['ece']:.3f}  top{TOP}/day hit {mt['top_hit']:.3f} (said {mt['top_said']:.3f})"
            )

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{sport}_backtest.json"), "w") as f:
        json.dump(results, f, indent=1)
    # player-level predictions for the bootstrap / further study (gitignored data dir)
    with open(os.path.join(DATA, f"preds_{sport}.json"), "w") as f:
        json.dump(
            {
                "rows": [{k: r[k] for k in ("gid", "date", "pid", "name", "y_pts", "y_g", "y_a")} for r in te_sim],
                "preds": preds_out,
            },
            f,
        )


if __name__ == "__main__":
    main()
