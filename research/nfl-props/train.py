"""
Fit, calibrate and export the NFL player-prop models.

One logistic regression per market on the shared feature set, standardized,
then Platt-scaled on the held-out season so the printed probability means what
it says. Exactly the shape of the MLB prop models, and exported in the same
schema so src/lib/nfl-props.server.ts can score it with twenty lines of maths.

Split: fit on 2021-2024, test on 2025. The test season is never fit on, never
used to pick a threshold before the tiers are cut, and is the only season the
reported numbers come from.

    python3 research/nfl-props/train.py
"""
import os, json, math
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import features as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_MODEL = os.path.abspath(os.path.join(HERE, "..", "..", "src", "lib", "nfl-props-model.json"))
OUT_METRICS = os.path.join(HERE, "metrics.json")

TRAIN_SEASONS = {2021, 2022, 2023, 2024}
TEST_SEASONS = {2025}
TIER_LABELS = ["Strong", "Solid", "Lean"]


def platt(p_raw, y):
    """Fit a 1-D logistic on the logit of the raw score (Platt scaling)."""
    lg = np.log(np.clip(p_raw, 1e-6, 1 - 1e-6) / (1 - np.clip(p_raw, 1e-6, 1 - 1e-6)))
    lr = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
    lr.fit(lg.reshape(-1, 1), y)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])


def apply_platt(p_raw, a, b):
    lg = np.log(np.clip(p_raw, 1e-6, 1 - 1e-6) / (1 - np.clip(p_raw, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(a * lg + b)))


def tiers_from(p, y):
    """Three tiers cut at the test set's own tertiles, each reporting the hit
    rate actually measured inside it. Cutting on the held-out season is the
    point: a tier boundary chosen on training data is just the model's opinion
    of itself."""
    if len(p) < 300:
        return []
    hi, lo = np.quantile(p, 0.90), np.quantile(p, 0.60)
    out = []
    for label, mn, mx in (("Strong", hi, 1.1), ("Solid", lo, hi), ("Lean", -0.1, lo)):
        m = (p >= mn) & (p < mx)
        if m.sum() < 30:
            continue
        out.append({"minProb": float(mn), "label": label,
                    "hitRate": float(y[m].mean()), "n": int(m.sum())})
    return out


def main():
    print("pass 1: measuring market base rates")
    rows0 = F.build(None)
    rates = {}
    for key in F.MARKETS:
        ys = [r["y"][key] for r in rows0 if key in r["y"]]
        rates[key] = float(np.mean(ys)) if ys else 0.2
    print("  base rates:", {k: round(v, 3) for k, v in rates.items()})

    print("pass 2: rebuilding with measured priors")
    rows = F.build(rates)
    print(f"  {len(rows):,} player-game rows")

    markets, metrics = {}, {}
    for key, (kind, label, _pred) in F.MARKETS.items():
        tr = [r for r in rows if key in r["x"] and r["season"] in TRAIN_SEASONS]
        te = [r for r in rows if key in r["x"] and r["season"] in TEST_SEASONS]
        if len(tr) < 500 or len(te) < 200:
            print(f"  {key}: too few rows ({len(tr)}/{len(te)}), skipped")
            continue
        Xtr = np.array([r["x"][key] for r in tr], dtype=float)
        ytr = np.array([r["y"][key] for r in tr], dtype=int)
        Xte = np.array([r["x"][key] for r in te], dtype=float)
        yte = np.array([r["y"][key] for r in te], dtype=int)

        mean, std = Xtr.mean(axis=0), Xtr.std(axis=0)
        std[std == 0] = 1.0
        lr = LogisticRegression(C=0.5, solver="lbfgs", max_iter=3000)
        lr.fit((Xtr - mean) / std, ytr)

        raw_tr = lr.predict_proba((Xtr - mean) / std)[:, 1]
        a, b = platt(raw_tr, ytr)
        raw_te = lr.predict_proba((Xte - mean) / std)[:, 1]
        p_te = apply_platt(raw_te, a, b)

        m = {
            "auc": float(roc_auc_score(yte, p_te)),
            "logloss": float(log_loss(yte, p_te)),
            "brier": float(brier_score_loss(yte, p_te)),
            "base": float(yte.mean()),
            "meanPred": float(p_te.mean()),
            "nTrain": len(tr), "nTest": len(te),
        }
        order = np.argsort(-p_te)
        for n in (50, 200, 500):
            if len(order) >= n:
                m[f"top{n}"] = float(yte[order[:n]].mean())

        markets[key] = {
            "label": label, "kind": kind,
            "features": F.FEATURES[kind],
            "mean": mean.tolist(), "std": std.tolist(),
            "coef": lr.coef_[0].tolist(), "intercept": float(lr.intercept_[0]),
            "plattA": a, "plattB": b,
            "base": rates[key],
            "tiers": tiers_from(p_te, yte),
            "metrics": m,
        }
        metrics[key] = m
        print(f"  {key:9s} auc={m['auc']:.3f} base={m['base']:.3f} "
              f"top50={m.get('top50', float('nan')):.3f} n={len(te)}")

    # A handful of real vectors and the probability they must produce, so the
    # TypeScript port can prove it computes the same numbers.
    selftest = {}
    for key, mm in markets.items():
        ex = [r for r in rows if key in r["x"] and r["season"] in TEST_SEASONS][:3]
        mean, std = np.array(mm["mean"]), np.array(mm["std"])
        for r in ex:
            x = np.array(r["x"][key], dtype=float)
            raw = 1 / (1 + math.exp(-(float(np.dot((x - mean) / std, mm["coef"])) + mm["intercept"])))
            lg = math.log(raw / (1 - raw))
            p = 1 / (1 + math.exp(-(mm["plattA"] * lg + mm["plattB"])))
            selftest.setdefault(key, []).append({"x": r["x"][key], "p": p})

    out = {
        "trainedThrough": max(TEST_SEASONS),
        "notes": ("logistic on trailing-6 and trailing-17 game windows (which cross the "
                  "season boundary, so Week 1 is defined) + team pace, opponent defence and "
                  "the market line; P = platt(sigmoid(w.x + b)). Fit 2021-24, tested 2025."),
        "constants": {"W_SHORT": F.W_SHORT, "W_LONG": F.W_LONG, "LG": F.LG, "K": F.K,
                      "DEFAULT_TOTAL": F.DEFAULT_TOTAL,
                      "MIN_SKILL_TOUCHES": F.MIN_SKILL_TOUCHES,
                      "MIN_QB_ATTEMPTS": F.MIN_QB_ATTEMPTS, "MIN_GAMES": F.MIN_GAMES},
        "markets": markets,
        "selftest": selftest,
    }
    with open(OUT_MODEL, "w") as f:
        json.dump(out, f)
    with open(OUT_METRICS, "w") as f:
        json.dump(metrics, f, indent=1)
    print(f"\nwrote {OUT_MODEL} ({os.path.getsize(OUT_MODEL)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
