"""
evaluate_football.py — the simulator against the shipped touchdown models.

    python3 research/player-props/evaluate_football.py nfl
    python3 research/player-props/evaluate_football.py cfb

Anytime touchdown, on the held-out seasons the shipped models were never
fitted on (NFL 2025 + 2026 to date, college 2025-26):

  model    the shipped model's held-out probability (NFL: the pairwise
           ranker; college: the calibrated extra-trees), reproduced exactly by
           research/football-td (predict_nfl.py / predict_cfb.py).
  sim      the site's game simulator (scripts/props-backtest-football.ts),
           1,000 plays of each game from the numbers known that morning.
  sim_cal  the simulator's number through an isotonic calibration map,
           cross-fitted: each week's games are calibrated by a map learned on
           the OTHER weeks only (there is no earlier simulated season to learn
           it from — that would need 2023's box scores).
  blend    the average of model and sim_cal.
  hybrid   logistic regression on logit(model) and logit(sim), cross-fitted
           the same way.

First touchdown (NFL and college): sim (its first-scorer share) against the
shipped NFL first-TD model where research/football-td produced it, and a
simple share baseline (anytime prob x the player's share of his team's
expected touchdowns x the team's chance of scoring first).

Population, identical for every method: the shipped model's candidates who
appear in the game's box score (the simulator's roster is the box score, so a
player who was inactive cannot be compared fairly; both methods are scored on
the same rows).
"""

from __future__ import annotations

import csv
import glob
import gzip
import json
import math
import os
import re
import sys
from collections import defaultdict

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
FT = os.path.join(HERE, "..", "football-td", "data")
OUT = os.path.join(HERE, "results")


def clip(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def logit(p):
    p = clip(p)
    return np.log(p / (1 - p))


def load_sim(league: str) -> dict:
    out = {}
    for path in glob.glob(os.path.join(DATA, f"sim_{league}_*.jsonl")):
        with open(path) as f:
            for line in f:
                g = json.loads(line)
                out[str(g["id"])] = g
    return out


def first_td(league: str) -> dict:
    """event id -> player id of the game's first touchdown (None if it was a
    team/return score, or no touchdown). Prefers research/football-td's labels
    (ESPN's play feed, which the shipped first-TD model was trained on — the
    summary's scoring-play list misses some defensive returns); otherwise the
    raw summaries' scoring plays, matched to the box score by name."""
    path = os.path.join(FT, f"{league}_first_td.csv")
    if os.path.exists(path):
        with open(path) as f:
            return {
                str(r["event_id"]): (str(r["first_td_player_id"]) or None)
                if r.get("kind") == "offense"
                else None
                for r in csv.DictReader(f)
            }
    out = {}
    for path in glob.glob(os.path.join(FT, "raw", league, "*.json.gz")):
        try:
            d = json.load(gzip.open(path))
        except Exception:  # noqa: BLE001
            continue
        eid = str(d.get("header", {}).get("id"))
        names = {}
        for t in d.get("boxscore", {}).get("players", []):
            for st in t.get("statistics", []):
                for a in st.get("athletes", []):
                    ath = a.get("athlete", {})
                    if ath.get("id") and ath.get("displayName"):
                        names.setdefault(ath["displayName"].lower(), ath["id"])
        first = None
        for p in d.get("scoringPlays", []):
            if (p.get("scoringType") or {}).get("name") != "touchdown":
                continue
            text = p.get("text") or ""
            m = re.match(r"^(.+?)\s+\d+\s+Yd", text)
            nm = (m.group(1) if m else "").strip().lower()
            first = names.get(nm)
            if first is None and nm:
                # initials or suffixes: match on last name + first initial
                parts = nm.split()
                for full, pid in names.items():
                    fp = full.split()
                    if fp and parts and fp[-1] == parts[-1] and fp[0][0] == parts[0][0]:
                        first = pid
                        break
            break
        out[eid] = first
    return out


def metrics(y, p, games) -> dict:
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
    order = np.argsort(p)
    bins = np.array_split(order, 10)
    cal = [{"predicted": float(p[b].mean()), "actual": float(y[b].mean()), "n": int(len(b))} for b in bins if len(b)]
    ece = float(sum(abs(c["predicted"] - c["actual"]) * c["n"] for c in cal) / len(y))
    by_game = defaultdict(list)
    for i, g in enumerate(games):
        by_game[g].append(i)
    h1 = s1 = h3 = s3 = n3 = 0.0
    for idx in by_game.values():
        srt = sorted(idx, key=lambda i: -p[i])
        h1 += y[srt[0]]
        s1 += p[srt[0]]
        top = srt[:3]
        h3 += y[top].sum()
        s3 += p[top].sum()
        n3 += len(top)
    G = len(by_game)
    return {
        "n": int(len(y)), "games": G, "base_rate": float(base), "brier": brier,
        "brier_skill": 1 - brier / brier0 if brier0 else 0.0, "log_loss": ll, "auc": auc, "ece": ece,
        "top1_hit": h1 / G, "top1_said": s1 / G, "top3_hit": h3 / n3, "top3_said": s3 / n3,
        "calibration": cal,
    }


def cross_fit(x, y, folds, make):
    out = np.zeros(len(y))
    for f in sorted(set(folds)):
        tr = folds != f
        te = folds == f
        m = make()
        m.fit(x[tr], y[tr])
        out[te] = m.predict_proba(x[te])[:, 1] if hasattr(m, "predict_proba") else m.predict(x[te])
    return out


def bootstrap_diff(y, a, b, games, metric="brier", B=2000, seed=11):
    """Paired bootstrap over games: CI for metric(a) - metric(b)."""
    rng = np.random.default_rng(seed)
    by = defaultdict(list)
    for i, g in enumerate(games):
        by[g].append(i)
    keys = list(by)
    idx = [np.array(by[k]) for k in keys]
    diffs = []
    for _ in range(B):
        pick = rng.integers(0, len(keys), len(keys))
        ii = np.concatenate([idx[k] for k in pick])
        if metric == "brier":
            diffs.append(np.mean((a[ii] - y[ii]) ** 2) - np.mean((b[ii] - y[ii]) ** 2))
        else:
            pa, pb = clip(a[ii]), clip(b[ii])
            yy = y[ii]
            diffs.append(
                -np.mean(yy * np.log(pa) + (1 - yy) * np.log(1 - pa))
                + np.mean(yy * np.log(pb) + (1 - yy) * np.log(1 - pb))
            )
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return float(np.mean(diffs)), float(lo), float(hi)


def main() -> None:
    league = sys.argv[1]
    sims = load_sim(league)
    rows = []
    with open(os.path.join(FT, f"{league}_model_preds.csv")) as f:
        for r in csv.DictReader(f):
            if r.get("candidate") != "1":
                continue
            eid = str(r["event_id"])
            g = sims.get(eid)
            if not g:
                continue
            sp = g["players"].get(str(r["player_id"]))
            if sp is None or str(r.get("in_box", "1")) != "1":
                continue
            rows.append({
                "eid": eid, "date": r["date"], "season": int(r["season"]), "pid": str(r["player_id"]),
                "team": str(r["team_id"]), "name": r["player_name"], "pos": r.get("position"),
                "model": float(r["prob"]), "sim": float(sp.get("td", 0.0)), "sim_first": float(sp.get("first", 0.0)),
                "y": 1.0 if r["scored"] == "1" else 0.0,
            })
    if not rows:
        print("no overlapping rows")
        return
    rows.sort(key=lambda r: (r["date"], r["eid"]))
    y = np.array([r["y"] for r in rows])
    games = [r["eid"] for r in rows]
    # five chronological folds by date, for the cross-fitted calibration
    dates = sorted({r["date"] for r in rows})
    fold_of = {d: min(4, i * 5 // len(dates)) for i, d in enumerate(dates)}
    folds = np.array([fold_of[r["date"]] for r in rows])

    P = {"model": np.array([r["model"] for r in rows]), "sim": np.array([r["sim"] for r in rows])}
    P["sim_cal"] = cross_fit(
        P["sim"].reshape(-1, 1), y, folds,
        lambda: IsotonicRegressionWrapper(),
    )
    P["blend"] = 0.5 * P["model"] + 0.5 * P["sim_cal"]
    X = np.column_stack([logit(P["model"]), logit(P["sim"])])
    P["hybrid"] = cross_fit(X, y, folds, lambda: LogisticRegression(C=1.0, max_iter=1000))

    res = {"league": league, "anytime": {}, "first_td": {}}
    print(f"{league}: {len(rows)} player-games, {len(set(games))} games, base {y.mean():.3f}")
    for m, p in P.items():
        mt = metrics(y, p, games)
        res["anytime"][m] = mt
        print(
            f"  {m:8} brier {mt['brier']:.4f} skill {mt['brier_skill']:+.3f} ll {mt['log_loss']:.4f} auc {mt['auc']:.3f}"
            f" ece {mt['ece']:.3f} | top1/game {mt['top1_hit']:.3f} (said {mt['top1_said']:.3f}) top3 {mt['top3_hit']:.3f} (said {mt['top3_said']:.3f})"
        )
    best = min(("sim_cal", "blend", "hybrid", "model"), key=lambda m: res["anytime"][m]["brier"])
    res["anytime_best"] = best
    res["anytime_ci"] = {}
    for m in P:
        if m == best:
            continue
        res["anytime_ci"][m] = {
            "brier_diff": bootstrap_diff(y, P[best], P[m], games, "brier"),
            "logloss_diff": bootstrap_diff(y, P[best], P[m], games, "ll"),
        }
        d, lo, hi = res["anytime_ci"][m]["brier_diff"]
        print(f"    {best} minus {m}: brier {d:+.5f} [{lo:+.5f}, {hi:+.5f}]")

    # ------------------------------------------------------- first touchdown
    ftd = first_td(league)
    fr = [r for r in rows if r["eid"] in ftd]
    if fr:
        yf = np.array([1.0 if ftd[r["eid"]] == r["pid"] else 0.0 for r in fr])
        gf = [r["eid"] for r in fr]
        F = {"sim": np.array([r["sim_first"] for r in fr])}
        # share baseline: the model's anytime prob, renormalised so each
        # game's candidates share the game's chance of a non-return first TD
        by = defaultdict(list)
        for i, r in enumerate(fr):
            by[r["eid"]].append(i)
        share = np.zeros(len(fr))
        for idx in by.values():
            lam = np.array([-math.log(max(1e-6, 1 - fr[i]["model"])) for i in idx])
            tot = lam.sum()
            for k, i in enumerate(idx):
                share[i] = 0.97 * lam[k] / tot if tot > 0 else 0.0
        F["model_share"] = share
        td1 = os.path.join(FT, "nfl_td1_preds.csv")
        if league == "nfl" and os.path.exists(td1):
            m1 = {}
            with open(td1) as f:
                for r in csv.DictReader(f):
                    m1[(str(r["event_id"]), str(r["player_id"]))] = float(r["prob"])
            F["model_td1"] = np.array([m1.get((r["eid"], r["pid"]), np.nan) for r in fr])
            if np.isnan(F["model_td1"]).any():
                ok = ~np.isnan(F["model_td1"])
                print(f"  td1 model covers {ok.mean():.2%} of rows; filling the rest with model_share")
                F["model_td1"] = np.where(ok, F["model_td1"], share)
        foldsf = np.array([fold_of[r["date"]] for r in fr])
        F["sim_cal"] = cross_fit(F["sim"].reshape(-1, 1), yf, foldsf, lambda: IsotonicRegressionWrapper())
        print(f"  first TD: {len(fr)} rows, {len(set(gf))} games, base {yf.mean():.4f}")
        for m, p in F.items():
            mt = metrics(yf, p, gf)
            res["first_td"][m] = mt
            print(
                f"    {m:11} brier {mt['brier']:.5f} ll {mt['log_loss']:.4f} auc {mt['auc']:.3f} ece {mt['ece']:.4f}"
                f" | top1/game {mt['top1_hit']:.3f} (said {mt['top1_said']:.3f})"
            )
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{league}_td_backtest.json"), "w") as f:
        json.dump(res, f, indent=1)


class IsotonicRegressionWrapper:
    def __init__(self):
        self.m = IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)

    def fit(self, x, y):
        self.m.fit(x.ravel(), y)
        return self

    def predict(self, x):
        return self.m.predict(x.ravel())


if __name__ == "__main__":
    main()
