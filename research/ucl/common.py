"""
Shared pieces of the Champions League pipeline: loading, seasons, the
cross-league Elo replay and the scoring rules.

The replay here is the reference implementation. src/lib/ucl-model.ts runs the
same arithmetic in TypeScript from the constants this pipeline freezes into
src/lib/ucl-model.json, and scripts/test-ucl.ts checks the two agree.
"""

import math
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

EUROPE = {
    "uefa.champions", "uefa.champions_qual", "uefa.europa", "uefa.europa_qual",
    "uefa.europa.conf", "uefa.europa.conf_qual", "uefa.super_cup",
}

# Where a club starts the first time it is seen, by league, in Elo points.
# These are priors, not fits: 2013-14 is a warm-up season and nothing from the
# test seasons (2017-18 on) touches them. They only need to be roughly right
# because six to ten European rounds a season move whole leagues quickly.
LEAGUE_PRIOR = {
    "eng.1": 1620, "esp.1": 1620, "ger.1": 1600, "ita.1": 1600, "fra.1": 1560,
    "por.1": 1500, "ned.1": 1490, "rus.1": 1470, "bel.1": 1460, "tur.1": 1450,
    "eng.2": 1450, "aut.1": 1420, "sui.1": 1410, "gre.1": 1400, "sco.1": 1390,
    "den.1": 1390, "cyp.1": 1350, "isr.1": 1350, "rou.1": 1350, "nor.1": 1350,
    "swe.1": 1350, "irl.1": 1250,
}

# A club seen only in European competition (Czechia, Ukraine, Croatia,
# Azerbaijan... ESPN carries no domestic feed for them) enters here.
EURO_ONLY_PRIOR = 1380


def season_of(date: str) -> int:
    """ESPN's season label: 2025 is 2025-26. July opens a season.

    August 2020 is the exception: the 2019-20 Champions League finished then,
    after the pandemic pause, so those matches belong to the season before.
    """
    y, m = int(date[:4]), int(date[5:7])
    if date[:7] == "2020-08":
        return 2019
    return y if m >= 7 else y - 1


def is_ucl_main(comp: str, date: str) -> bool:
    """Champions League proper — league/group phase and knockouts.

    Until 2019 ESPN filed the qualifying rounds under the same competition
    code. Qualifiers are played in July and August; the main event never is,
    except the 2019-20 finals tournament in August 2020.
    """
    if comp != "uefa.champions":
        return False
    mon = int(date[5:7])
    return mon not in (7, 8) or date[:7] == "2020-08"


def load_matches():
    m = pd.read_csv(
        os.path.join(DATA, "matches.csv"),
        dtype={"id": str, "home_id": str, "away_id": str},
    )
    m = m.sort_values(["date", "id"]).reset_index(drop=True)
    m["season"] = [season_of(d) for d in m["date"]]
    m["europe"] = m["comp"].isin(EUROPE)
    m["ucl"] = [is_ucl_main(c, d) for c, d in zip(m["comp"], m["date"])]
    # 90-minute result: what 1X2 settles on. Extra-time matches were 90-minute
    # draws even when the goal log is missing.
    res = []
    for hg, ag, h9, a9, et in zip(m.hg, m.ag, m.hg90, m.ag90, m.et):
        if pd.notna(h9):
            res.append(0 if h9 > a9 else 1 if h9 == a9 else 2)
        elif et:
            res.append(1)
        else:
            res.append(0 if hg > ag else 1 if hg == ag else 2)
    m["res"] = res
    return m


# ------------------------------------------------------------------ scoring

def rps(p, y):
    """Ranked probability score for ordered H/D/A. p: (n,3), y: (n,) in {0,1,2}.

    Summed over the two cumulative splits and NOT halved — the convention of
    research/soccer and the site's ledger (ledger-stats.ts), so a Champions
    League RPS reads on the same scale as the five leagues'. Halve it to compare
    with the published literature."""
    p = np.asarray(p)
    o = np.zeros_like(p)
    o[np.arange(len(y)), y] = 1
    cp, co = np.cumsum(p, 1)[:, :2], np.cumsum(o, 1)[:, :2]
    return ((cp - co) ** 2).sum(1)


def logloss(p, y):
    p = np.asarray(p)
    return -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))


def brier(p, y):
    p = np.asarray(p)
    o = np.zeros_like(p)
    o[np.arange(len(y)), y] = 1
    return ((p - o) ** 2).sum(1)


def summary(p, y):
    p = np.asarray(p)
    return dict(
        n=int(len(y)),
        rps=float(rps(p, y).mean()),
        logloss=float(logloss(p, y).mean()),
        brier=float(brier(p, y).mean()),
        acc=float((p.argmax(1) == y).mean()),
    )


# --------------------------------------------------------------------- elo

DEFAULT = dict(k=20.0, eu_mult=1.5, hfa=60.0, gd_exp=0.6, carry=0.85, promo=60.0,
               euro_prior=EURO_ONLY_PRIOR)


def replay(m, params=DEFAULT, observer=None):
    """Replay every match oldest-first through one Elo shared by all leagues.

    `observer(i, rh, ra)` is called for each row index BEFORE the match is
    folded in, with both sides' ratings as they stood that morning — the only
    honest numbers to price it with.

    Returns (rating, league_of) after the last match.
    """
    return replay_state(m, params, {}, {}, None, observer)


def replay_state(m, params, rating, league_of, season, observer=None):
    """`replay`, continued from an existing state (a shipped snapshot)."""
    k, eu_mult, hfa = params["k"], params["eu_mult"], params["hfa"]
    gd_exp, carry, promo = params["gd_exp"], params["carry"], params["promo"]
    euro_prior = params.get("euro_prior", EURO_ONLY_PRIOR)

    def league_mean(comp):
        vals = [rating[t] for t, lg in league_of.items() if lg == comp]
        return sum(vals) / len(vals) if len(vals) >= 6 else None

    cols = zip(m.index, m.comp, m.season, m.home_id, m.away_id, m.hg, m.ag,
               m.neutral, m.europe)
    for i, comp, s, h, a, hg, ag, neutral, eu in cols:
        if season is not None and s != season:
            # New season: pull each domestic club part of the way back to its
            # league's mean. The league's level itself is left alone — that is
            # what European results have taught the model.
            means = {}
            for t, lg in league_of.items():
                means.setdefault(lg, []).append(rating[t])
            means = {lg: sum(v) / len(v) for lg, v in means.items()}
            for t, lg in league_of.items():
                rating[t] = means[lg] + carry * (rating[t] - means[lg])
        season = s

        for t in (h, a):
            if t not in rating:
                if eu:
                    rating[t] = euro_prior
                else:
                    mu = league_mean(comp)
                    rating[t] = (mu - promo) if mu is not None else LEAGUE_PRIOR.get(comp, 1400)
            if not eu:
                league_of[t] = comp

        rh, ra = rating[h], rating[a]
        if observer is not None:
            observer(i, rh, ra)

        adv = 0.0 if neutral else hfa
        exp = 1.0 / (1.0 + 10 ** (-(rh + adv - ra) / 400.0))
        gd = hg - ag
        res = 1.0 if gd > 0 else 0.5 if gd == 0 else 0.0
        kk = k * (eu_mult if eu else 1.0)
        d = kk * (abs(gd) + 1) ** gd_exp * (res - exp)
        rating[h] = rh + d
        rating[a] = ra - d
    return rating, league_of


def pre_match_ratings(m, params=DEFAULT):
    rh = np.zeros(len(m))
    ra = np.zeros(len(m))

    def obs(i, h, a):
        rh[i] = h
        ra[i] = a

    final, league_of = replay(m, params, obs)
    return rh, ra, final, league_of


# --------------------------------------------------- probability calibration

def softmax3(z):
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def fit_mnl(X, y, l2=1e-3):
    """Multinomial logistic, away class as reference. Returns (coef (3,f), intercept (3,))."""
    from scipy.optimize import minimize

    X = np.asarray(X, float)
    n, f = X.shape

    def unpack(w):
        W = np.zeros((3, f))
        b = np.zeros(3)
        W[:2] = w[: 2 * f].reshape(2, f)
        b[:2] = w[2 * f:]
        return W, b

    def loss(w):
        W, b = unpack(w)
        z = X @ W.T + b
        z = z - z.max(1, keepdims=True)
        lse = np.log(np.exp(z).sum(1))
        ll = z[np.arange(n), y] - lse
        P = np.exp(z - lse[:, None])
        O = np.zeros_like(P)
        O[np.arange(n), y] = 1
        G = (P - O)  # (n,3)
        gW = (G.T @ X)[:2] / n + 2 * l2 * W[:2]
        gb = G.sum(0)[:2] / n
        return -ll.mean() + l2 * (W[:2] ** 2).sum(), np.concatenate([gW.ravel(), gb])

    r = minimize(loss, np.zeros(2 * f + 2), jac=True, method="L-BFGS-B")
    return unpack(r.x)


def mnl_predict(W, b, X):
    return softmax3(np.asarray(X, float) @ W.T + b)


# --------------------------------------------------------------- goal model

def dc_matrix(lh, la, rho, maxg=10):
    """Dixon-Coles score matrix P[i, j] = P(home i, away j), normalised."""
    i = np.arange(maxg + 1)
    ph = np.exp(-lh) * lh ** i / np.array([math.factorial(x) for x in i])
    pa = np.exp(-la) * la ** i / np.array([math.factorial(x) for x in i])
    P = np.outer(ph, pa)
    P[0, 0] *= 1 - lh * la * rho
    P[0, 1] *= 1 + lh * rho
    P[1, 0] *= 1 + la * rho
    P[1, 1] *= 1 - rho
    P = np.clip(P, 0, None)
    return P / P.sum()


def hda_from_matrix(P):
    return np.array([np.tril(P, -1).sum(), np.trace(P), np.triu(P, 1).sum()])
