"""
marketlib.py — the scoring every market's backtest shares.

    metrics(y, p, gids)   Brier, log loss, AUC, calibration deciles, the hit
                          rate of each game's top three picks (what the
                          ledger records) and fixed 10-point confidence bands
                          ("when it said 70-80%, how often did it happen?").
    crossfit_iso(...)     an isotonic calibration map fitted on other date
                          folds and applied to the held-out one, so the
                          calibrated numbers are never scored on the data
                          they were fitted to.
    nb_tail, fit_phi      the negative binomial behind the season-average
                          baseline.
    paired_boot(...)      a game-level bootstrap of the Brier difference
                          between two methods on the same rows.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
from scipy import stats
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

TOP_PER_GAME = 3
BANDS = [(i / 10, (i + 1) / 10) for i in range(10)]


def clip(p):
    return np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)


def bands(y: np.ndarray, p: np.ndarray) -> list[dict]:
    out = []
    for lo, hi in BANDS:
        m = (p >= lo) & ((p < hi) if hi < 1 else (p <= 1.0))
        if m.sum() == 0:
            continue
        out.append(
            {"lo": lo, "hi": hi, "n": int(m.sum()), "said": float(p[m].mean()), "hit": float(y[m].mean())}
        )
    return out


def metrics(y, p, gids) -> dict:
    y = np.asarray(y, dtype=float)
    p = clip(p)
    base = float(y.mean())
    brier = float(np.mean((p - y) ** 2))
    brier0 = float(np.mean((base - y) ** 2))
    ll = float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    try:
        auc = float(roc_auc_score(y, p))
    except ValueError:
        auc = float("nan")
    order = np.argsort(p, kind="stable")
    cal = [
        {"predicted": float(p[b].mean()), "actual": float(y[b].mean()), "n": int(len(b))}
        for b in np.array_split(order, 10)
        if len(b)
    ]
    ece = float(sum(abs(c["predicted"] - c["actual"]) * c["n"] for c in cal) / len(y))
    by_game = defaultdict(list)
    for i, g in enumerate(gids):
        by_game[g].append(i)
    top_idx = []
    top1_hit = top1_said = 0.0
    for idx in by_game.values():
        ranked = sorted(idx, key=lambda i: -p[i])
        top_idx.extend(ranked[:TOP_PER_GAME])
        top1_hit += y[ranked[0]]
        top1_said += p[ranked[0]]
    top_idx = np.array(top_idx, dtype=int)
    g = max(1, len(by_game))
    return {
        "n": int(len(y)),
        "games": int(len(by_game)),
        "base_rate": base,
        "brier": brier,
        "brier_skill": 1 - brier / brier0 if brier0 > 0 else 0.0,
        "log_loss": ll,
        "auc": auc,
        "ece": ece,
        "calibration": cal,
        "bands": bands(y, p),
        "top_hit": float(y[top_idx].mean()) if len(top_idx) else None,
        "top_said": float(p[top_idx].mean()) if len(top_idx) else None,
        "top_n": int(len(top_idx)),
        "top_bands": bands(y[top_idx], p[top_idx]) if len(top_idx) else [],
        "top1_hit": float(top1_hit / g),
        "top1_said": float(top1_said / g),
    }


def date_folds(dates: list[str], k: int = 5) -> np.ndarray:
    """Contiguous blocks of game days: fold id per row."""
    days = sorted(set(dates))
    cut = {d: min(k - 1, i * k // max(1, len(days))) for i, d in enumerate(days)}
    return np.array([cut[d] for d in dates])


def iso() -> IsotonicRegression:
    return IsotonicRegression(out_of_bounds="clip", y_min=1e-4, y_max=1 - 1e-4)


def crossfit_iso(s: np.ndarray, y: np.ndarray, folds: np.ndarray) -> np.ndarray:
    out = np.zeros_like(s, dtype=float)
    for f in np.unique(folds):
        tr, te = folds != f, folds == f
        if tr.sum() < 50 or y[tr].min() == y[tr].max():
            out[te] = s[te]
            continue
        out[te] = iso().fit(s[tr], y[tr]).predict(s[te])
    return out


def nb_tail(mu: np.ndarray, k: float, phi: float) -> np.ndarray:
    """P(X >= k) for a negative binomial with mean mu, var = mu + phi*mu^2."""
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-6)
    r = 1.0 / phi
    pr = r / (r + mu)
    return stats.nbinom.sf(np.ceil(k) - 1, r, pr)


def fit_phi(mu: np.ndarray, y: np.ndarray) -> float:
    ok = mu > 0
    mu, y = np.maximum(mu[ok], 1e-6), np.round(y[ok]).astype(int)
    if len(mu) < 30:
        return 0.2
    best, best_ll = 0.1, float("inf")
    for phi in np.concatenate([np.linspace(0.005, 0.1, 20), np.linspace(0.12, 1.5, 70)]):
        r = 1.0 / phi
        ll = -stats.nbinom.logpmf(y, r, r / (r + mu)).mean()
        if ll < best_ll:
            best, best_ll = float(phi), ll
    return best


def paired_boot(y, pa, pb, gids, n=1000, seed=11) -> dict:
    """Brier(a) - Brier(b), resampling whole games. Negative = a better."""
    y, pa, pb = (np.asarray(v, dtype=float) for v in (y, pa, pb))
    d = (pa - y) ** 2 - (pb - y) ** 2
    by_game = defaultdict(list)
    for i, g in enumerate(gids):
        by_game[g].append(i)
    sums = np.array([d[idx].sum() for idx in by_game.values()])
    cnts = np.array([len(idx) for idx in by_game.values()])
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(n):
        k = rng.integers(0, len(sums), len(sums))
        draws.append(sums[k].sum() / cnts[k].sum())
    return {"diff": float(d.mean()), "lo": float(np.percentile(draws, 2.5)), "hi": float(np.percentile(draws, 97.5))}


def choose(methods: dict) -> str:
    """The simulator, calibrated or raw, whichever scored the lower Brier on
    held-out games: on a small market the calibration map can cost more than
    it fixes."""
    sc, sr = methods.get("sim_cal"), methods.get("sim")
    if sc is None:
        return "sim"
    return "sim_cal" if sr is None or sc["brier"] <= sr["brier"] else "sim"
