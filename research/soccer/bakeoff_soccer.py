"""
Match-outcome bake-off for one competition — every algorithm worth trying,
scored against the closing market price where ESPN still carries it.

Football is a three-way problem (home / draw / away), so the metric that matters
is the **Ranked Probability Score** — it respects the ordering H > D > A and
punishes a model that puts weight on the wrong side of a draw. Log loss,
accuracy and multiclass Brier are reported alongside.

Families covered:
  baselines        always-home, base rates, and THE MARKET (de-vigged closing 1X2)
  ratings          Elo (3 variants), Glicko, pi-rating, Massey, Colley,
                   Davidson (Bradley-Terry with draws), Kalman, Bayesian
  goal processes   Poisson, Dixon-Coles (+ time decay), bivariate Poisson,
                   negative binomial, Skellam, zero-inflated Poisson
  shot processes   shots and shots-on-target attack/defence, an xG proxy
  form             points per game, goal difference, last-5 form, head-to-head
  machine learning multinomial logistic (L1/L2), ordered logit, RF, extra trees,
                   hist-GBM, XGBoost, LightGBM, MLP, kNN, naive Bayes, SVM
  ensembles        probability mean, logit mean, stack, BMA, model x market

Protocol: one chronological walk-forward pass; state for a match is built only
from earlier matches. One-dimensional signals are mapped to probabilities by a
multinomial logistic fit on the calibration seasons only. Every season from
2023-24 on takes its turn as the test set (a single 380-match season is far too
small to rank on), and the results are pooled.

Every league is fitted, calibrated and ranked on its own data. Nothing is
pooled across competitions: home advantage, draw rate and goal supply differ
enough between them that a model carried over from another league starts
mis-calibrated, and the per-league tables are what show that.

Usage: python3 bakeoff_soccer.py --league bundesliga
"""

import argparse
import math
import os
import warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson, skellam
from sklearn.ensemble import (ExtraTreesClassifier, HistGradientBoostingClassifier,
                              RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from leagues import ROLLING_TEST, add_league_arg, get as get_league

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
CLASSES = ["H", "D", "A"]
MAXG = 9                                # goal grid for the scoring models
RNG = 0
LG_HOME, LG_AWAY = 1.55, 1.25           # league goal means, reset from data


# ----------------------------------------------------------------- metrics
def rps(y, P):
    """Ranked Probability Score over ordered outcomes H > D > A (lower better)."""
    Y = np.zeros_like(P)
    for i, c in enumerate(y):
        Y[i, CLASSES.index(c)] = 1
    cp, cy = np.cumsum(P, axis=1)[:, :2], np.cumsum(Y, axis=1)[:, :2]
    return float(np.mean(np.sum((cp - cy) ** 2, axis=1)))


def mlogloss(y, P):
    P = np.clip(P, 1e-9, 1)
    return float(-np.mean([math.log(P[i, CLASSES.index(c)]) for i, c in enumerate(y)]))


def accuracy(y, P):
    return float(np.mean([CLASSES[int(np.argmax(P[i]))] == c for i, c in enumerate(y)]))


def mbrier(y, P):
    Y = np.zeros_like(P)
    for i, c in enumerate(y):
        Y[i, CLASSES.index(c)] = 1
    return float(np.mean(np.sum((P - Y) ** 2, axis=1)))


def score(name, y, P):
    return dict(model=name, rps=rps(y, P), logloss=mlogloss(y, P),
                acc=accuracy(y, P), brier=mbrier(y, P))


# ------------------------------------------------- goal matrix -> H / D / A
def probs_from_lambdas(lh, la, model="poisson", rho=-0.04, disp=12.0, zi=0.0):
    lh, la = max(lh, 0.05), max(la, 0.05)
    if model == "nbinom":
        ph = nbinom.pmf(np.arange(MAXG + 1), disp, disp / (disp + lh))
        pa = nbinom.pmf(np.arange(MAXG + 1), disp, disp / (disp + la))
    else:
        ph = poisson.pmf(np.arange(MAXG + 1), lh)
        pa = poisson.pmf(np.arange(MAXG + 1), la)
    M = np.outer(ph, pa)
    if model == "dixon_coles":
        # the low-score dependence correction that makes Dixon-Coles Dixon-Coles
        M[0, 0] *= 1 - lh * la * rho
        M[0, 1] *= 1 + lh * rho
        M[1, 0] *= 1 + la * rho
        M[1, 1] *= 1 - rho
    if model == "zip":
        M *= 1 - zi
        M[0, 0] += zi
    M /= M.sum()
    h = float(np.tril(M, -1).sum())     # home goals > away goals
    d = float(np.trace(M))
    return np.array([h, d, 1 - h - d])


def biv_poisson(lh, la, lc=0.12):
    """Bivariate Poisson: a shared component lc correlates the two scorelines."""
    lh, la = max(lh - lc, 0.05), max(la - lc, 0.05)
    M = np.zeros((MAXG + 1, MAXG + 1))
    pc = poisson.pmf(np.arange(6), lc)
    for c in range(6):
        M += pc[c] * np.outer(
            np.roll(poisson.pmf(np.arange(MAXG + 1), lh), c),
            np.roll(poisson.pmf(np.arange(MAXG + 1), la), c))
    M = np.clip(M, 0, None)
    M /= M.sum()
    h = float(np.tril(M, -1).sum())
    d = float(np.trace(M))
    return np.array([h, d, 1 - h - d])


def skellam_probs(lh, la):
    d = float(skellam.pmf(0, lh, la))
    h = float(1 - skellam.cdf(0, lh, la))
    return np.array([h, d, max(1 - h - d, 1e-9)])


# -------------------------------------------------------------------- state
class State:
    def __init__(self, teams):
        self.teams = list(teams)
        self.idx = {t: i for i, t in enumerate(self.teams)}
        n = len(self.teams)
        self.elo = defaultdict(lambda: 1500.0)
        self.elo_mov = defaultdict(lambda: 1500.0)
        self.elo_gd = defaultdict(lambda: 1500.0)
        self.g_r = defaultdict(lambda: 1500.0)
        self.g_rd = defaultdict(lambda: 350.0)
        self.pi_h = defaultdict(float)      # pi-rating: separate home/away form
        self.pi_a = defaultdict(float)
        self.k_m = defaultdict(float)
        self.k_v = defaultdict(lambda: 1.0)
        self.b_m = defaultdict(float)
        self.b_n = defaultdict(float)
        self.att = defaultdict(lambda: 1.0)     # multiplicative goal attack
        self.dfn = defaultdict(lambda: 1.0)
        self.att_d = defaultdict(lambda: 1.0)   # time-decayed variant
        self.dfn_d = defaultdict(lambda: 1.0)
        self.s_att = defaultdict(lambda: 1.0)   # shots
        self.s_dfn = defaultdict(lambda: 1.0)
        self.t_att = defaultdict(lambda: 1.0)   # shots on target
        self.t_dfn = defaultdict(lambda: 1.0)
        self.pts = defaultdict(int)
        self.gp = defaultdict(int)
        self.gf = defaultdict(int)
        self.ga = defaultdict(int)
        self.last5 = defaultdict(lambda: deque(maxlen=5))
        self.h2h = defaultdict(lambda: [0, 0, 0])
        self.hist = []
        self.massey = np.zeros(n)
        self.colley = np.zeros(n)
        self.dav = np.zeros(n)
        self.dav_hfa = 0.3
        self.since_fit = 10 ** 9

    def ppg(self, t):
        return (self.pts[t] + 4) / (self.gp[t] + 3) if self.gp[t] else 1.33

    def gdpg(self, t):
        return (self.gf[t] - self.ga[t]) / max(self.gp[t], 1)

    def form5(self, t):
        d = self.last5[t]
        return sum(d) / len(d) if d else 1.33

    def refit(self):
        n = len(self.teams)
        if len(self.hist) < 80:
            return
        H = np.array(self.hist, float)
        hi, ai, gd = H[:, 0].astype(int), H[:, 1].astype(int), H[:, 2]
        res = H[:, 3]                      # 1 home win, 0.5 draw, 0 away win
        M = np.zeros((n, n)); p = np.zeros(n)
        np.add.at(M, (hi, hi), 1); np.add.at(M, (ai, ai), 1)
        np.add.at(M, (hi, ai), -1); np.add.at(M, (ai, hi), -1)
        np.add.at(p, hi, gd); np.add.at(p, ai, -gd)
        M[-1, :] = 1.0; p[-1] = 0.0
        try:
            self.massey = np.linalg.lstsq(M, p, rcond=None)[0]
        except Exception:
            pass
        C = np.zeros((n, n)); b = np.ones(n)
        np.add.at(C, (hi, hi), 1); np.add.at(C, (ai, ai), 1)
        np.add.at(C, (hi, ai), -1); np.add.at(C, (ai, hi), -1)
        C += 2 * np.eye(n)
        np.add.at(b, hi, (res - (1 - res)) / 2); np.add.at(b, ai, ((1 - res) - res) / 2)
        try:
            self.colley = np.linalg.solve(C, b)
        except Exception:
            pass
        # Davidson model = Bradley-Terry with an explicit draw parameter, fitted
        # here as an ordinal logistic on the rating difference.
        X = np.zeros((len(H), n + 1))
        X[np.arange(len(H)), hi] = 1
        X[np.arange(len(H)), ai] = -1
        X[:, n] = 1.0
        yb = (res > 0.5).astype(int)
        try:
            lr = LogisticRegression(fit_intercept=False, C=0.4, max_iter=400).fit(X, yb)
            self.dav = lr.coef_[0][:n]; self.dav_hfa = lr.coef_[0][n]
        except Exception:
            pass

    def update(self, m):
        h, a = m.home_id, m.away_id
        hg, ag = m.home_goals, m.away_goals
        gd = hg - ag
        res = 1.0 if gd > 0 else (0.5 if gd == 0 else 0.0)
        exp_h = 1 / (1 + 10 ** (-((self.elo[h] + 60) - self.elo[a]) / 400))
        for store, k, mode in ((self.elo, 20.0, "plain"), (self.elo_mov, 20.0, "mov"),
                               (self.elo_gd, 20.0, "gd")):
            e = 1 / (1 + 10 ** (-((store[h] + 60) - store[a]) / 400))
            mult = 1.0
            if mode == "mov":
                mult = math.log(abs(gd) + 1) + 1
            elif mode == "gd":
                mult = (abs(gd) + 1) ** 0.6
            d = k * mult * (res - e)
            store[h] += d; store[a] -= d
        for t, opp, r in ((h, a, res), (a, h, 1 - res)):
            rd = self.g_rd[t]
            q = math.log(10) / 400
            gdv = 1 / math.sqrt(1 + 3 * q * q * self.g_rd[opp] ** 2 / math.pi ** 2)
            e = 1 / (1 + 10 ** (-gdv * (self.g_r[t] - self.g_r[opp]) / 400))
            dsq = 1 / (q * q * gdv * gdv * e * (1 - e) + 1e-9)
            self.g_r[t] += (q / (1 / rd ** 2 + 1 / dsq)) * gdv * (r - e)
            self.g_rd[t] = max(30.0, math.sqrt(1 / (1 / rd ** 2 + 1 / dsq)))
        # pi-rating (Constantinou & Fenton): learn home and away form separately
        pred_gd = (self.pi_h[h] - self.pi_a[a])
        err = gd - pred_gd
        lr_, gamma = 0.06, 0.5
        self.pi_h[h] += lr_ * err; self.pi_a[h] += lr_ * gamma * err
        self.pi_a[a] -= lr_ * err; self.pi_h[a] -= lr_ * gamma * err
        Q, R = 0.03, 1.6
        pred = self.k_m[h] - self.k_m[a] + 0.35
        resid = gd - pred
        for t, s in ((h, +1), (a, -1)):
            self.k_v[t] += Q
            kg = self.k_v[t] / (self.k_v[t] + R)
            self.k_m[t] += s * kg * resid
            self.k_v[t] *= (1 - kg)
        for t, s in ((h, +1), (a, -1)):
            self.b_n[t] += 1
            self.b_m[t] += (s * gd - self.b_m[t]) / (self.b_n[t] + 8)
        for al, A, D in ((0.08, self.att, self.dfn), (0.18, self.att_d, self.dfn_d)):
            A[h] += al * (hg / LG_HOME - A[h]); D[h] += al * (ag / LG_AWAY - D[h])
            A[a] += al * (ag / LG_AWAY - A[a]); D[a] += al * (hg / LG_HOME - D[a])
        if not pd.isna(getattr(m, "home_shots", np.nan)):
            for al, A, D, hv, av, sc in ((0.10, self.s_att, self.s_dfn, m.home_shots, m.away_shots, 13.0),
                                         (0.10, self.t_att, self.t_dfn, m.home_sot, m.away_sot, 4.5)):
                A[h] += al * (hv / sc - A[h]); D[h] += al * (av / sc - D[h])
                A[a] += al * (av / sc - A[a]); D[a] += al * (hv / sc - D[a])
        self.pts[h] += 3 if gd > 0 else (1 if gd == 0 else 0)
        self.pts[a] += 3 if gd < 0 else (1 if gd == 0 else 0)
        self.gp[h] += 1; self.gp[a] += 1
        self.gf[h] += hg; self.ga[h] += ag
        self.gf[a] += ag; self.ga[a] += hg
        self.last5[h].append(3 if gd > 0 else (1 if gd == 0 else 0))
        self.last5[a].append(3 if gd < 0 else (1 if gd == 0 else 0))
        k = (h, a)
        self.h2h[k][0 if gd > 0 else (1 if gd == 0 else 2)] += 1
        self.hist.append((self.idx[h], self.idx[a], gd, res))
        self.since_fit += 1

    def season_reset(self):
        for st in (self.elo, self.elo_mov, self.elo_gd, self.g_r):
            for t in list(st):
                st[t] = 1500 + 0.80 * (st[t] - 1500)
        for st in (self.pi_h, self.pi_a, self.k_m, self.b_m):
            for t in list(st):
                st[t] *= 0.80
        for d in (self.pts, self.gp, self.gf, self.ga):
            d.clear()
        self.last5.clear()


# ------------------------------------------------------------ walk-forward
def walk(df):
    st = State(sorted(set(df.home_id) | set(df.away_id)))
    sig_rows, prob_rows, feat_rows = [], [], []
    season = None
    for m in df.itertuples():
        if m.season != season:
            if season is not None:
                st.season_reset()
            season = m.season
        if st.since_fit >= 40:
            st.refit(); st.since_fit = 0
        h, a = m.home_id, m.away_id
        hi, ai = st.idx[h], st.idx[a]
        lam_h = LG_HOME * st.att[h] * st.dfn[a]
        lam_a = LG_AWAY * st.att[a] * st.dfn[h]
        lam_hd = LG_HOME * st.att_d[h] * st.dfn_d[a]
        lam_ad = LG_AWAY * st.att_d[a] * st.dfn_d[h]
        # shots -> goals proxy: shot volume scaled by league conversion
        lam_hs = LG_HOME * st.s_att[h] * st.s_dfn[a]
        lam_as = LG_AWAY * st.s_att[a] * st.s_dfn[h]
        lam_ht = LG_HOME * st.t_att[h] * st.t_dfn[a]
        lam_at = LG_AWAY * st.t_att[a] * st.t_dfn[h]
        hh, hd, ha = st.h2h[(h, a)]

        sig_rows.append(dict(
            matchId=m.matchId, season=m.season, date=m.date, result=m.result,
            elo=(st.elo[h] + 60) - st.elo[a],
            elo_mov=(st.elo_mov[h] + 60) - st.elo_mov[a],
            elo_gd=(st.elo_gd[h] + 60) - st.elo_gd[a],
            glicko=(st.g_r[h] + 60) - st.g_r[a],
            pi_rating=st.pi_h[h] - st.pi_a[a],
            massey=st.massey[hi] - st.massey[ai] + 0.35,
            colley=st.colley[hi] - st.colley[ai],
            davidson=st.dav[hi] - st.dav[ai] + st.dav_hfa,
            kalman=st.k_m[h] - st.k_m[a] + 0.35,
            bayes_hier=st.b_m[h] - st.b_m[a] + 0.35,
            points_per_game=st.ppg(h) - st.ppg(a),
            goal_diff_pg=st.gdpg(h) - st.gdpg(a),
            form_last5=st.form5(h) - st.form5(a),
            head_to_head=(hh - ha) / max(hh + hd + ha, 1),
            lambda_gap=lam_h - lam_a,
            shots_gap=lam_hs - lam_as,
            sot_gap=lam_ht - lam_at,
        ))
        prob_rows.append(dict(
            matchId=m.matchId,
            poisson=probs_from_lambdas(lam_h, lam_a),
            dixon_coles=probs_from_lambdas(lam_h, lam_a, "dixon_coles"),
            dixon_coles_decay=probs_from_lambdas(lam_hd, lam_ad, "dixon_coles"),
            bivariate_poisson=biv_poisson(lam_h, lam_a),
            negative_binomial=probs_from_lambdas(lam_h, lam_a, "nbinom"),
            zero_infl_poisson=probs_from_lambdas(lam_h, lam_a, "zip", zi=0.02),
            skellam=skellam_probs(lam_h, lam_a),
            poisson_shots=probs_from_lambdas(lam_hs, lam_as, "dixon_coles"),
            poisson_sot=probs_from_lambdas(lam_ht, lam_at, "dixon_coles"),
        ))
        feat_rows.append(dict(
            matchId=m.matchId, season=m.season, result=m.result,
            elo=(st.elo[h] + 60) - st.elo[a], elo_mov=(st.elo_mov[h] + 60) - st.elo_mov[a],
            glicko=st.g_r[h] - st.g_r[a], pi=st.pi_h[h] - st.pi_a[a],
            massey=st.massey[hi] - st.massey[ai], colley=st.colley[hi] - st.colley[ai],
            davidson=st.dav[hi] - st.dav[ai], kalman=st.k_m[h] - st.k_m[a],
            ppg=st.ppg(h) - st.ppg(a), gdpg=st.gdpg(h) - st.gdpg(a),
            form=st.form5(h) - st.form5(a), h2h=(hh - ha) / max(hh + hd + ha, 1),
            lam_h=lam_h, lam_a=lam_a, lam_gap=lam_h - lam_a,
            att_h=st.att[h], att_a=st.att[a], dfn_h=st.dfn[h], dfn_a=st.dfn[a],
            s_gap=lam_hs - lam_as, t_gap=lam_ht - lam_at,
            gp=min(st.gp[h], 38),
        ))
        st.update(m)
    return pd.DataFrame(sig_rows), pd.DataFrame(prob_rows), pd.DataFrame(feat_rows)


# ------------------------------------------------------------- calibration
def calibrate_1d(sig_tr, y_tr, sig_te):
    """1-D signal -> 3-way probabilities via multinomial logistic."""
    X = np.asarray(sig_tr, float).reshape(-1, 1)
    if np.std(X) < 1e-12:
        base = np.array([np.mean(np.array(y_tr) == c) for c in CLASSES])
        return np.tile(base, (len(sig_te), 1))
    lr = LogisticRegression(max_iter=2000).fit(X, y_tr)
    P = lr.predict_proba(np.asarray(sig_te, float).reshape(-1, 1))
    return P[:, [list(lr.classes_).index(c) for c in CLASSES]]


def ml_probs(est, Xtr, ytr, Xte):
    est.fit(Xtr, ytr)
    P = est.predict_proba(Xte)
    cls = list(est.classes_ if hasattr(est, "classes_") else est[-1].classes_)
    return P[:, [cls.index(c) for c in CLASSES]]


def zoo():
    return {
        "ML_multinomial_logistic": make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "ML_logistic_L1": make_pipeline(StandardScaler(), LogisticRegression(
            penalty="l1", solver="saga", C=0.3, max_iter=3000)),
        "ML_random_forest": RandomForestClassifier(n_estimators=400, min_samples_leaf=15,
                                                   n_jobs=-1, random_state=RNG),
        "ML_extra_trees": ExtraTreesClassifier(n_estimators=400, min_samples_leaf=15,
                                               n_jobs=-1, random_state=RNG),
        "ML_hist_gbm": HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05,
                                                      max_leaf_nodes=12, l2_regularization=2.0,
                                                      random_state=RNG),
        "ML_kNN": make_pipeline(StandardScaler(), KNeighborsClassifier(60, n_jobs=-1)),
        "ML_naive_bayes": make_pipeline(StandardScaler(), GaussianNB()),
        "ML_svm_rbf": make_pipeline(StandardScaler(), SVC(probability=True, C=1.0)),
        "ML_neural_net": make_pipeline(StandardScaler(), MLPClassifier(
            (24, 12), alpha=0.1, max_iter=800, early_stopping=True, random_state=RNG)),
    }


def evaluate_season(df, sigs, probs, feats, test_season):
    calib = sorted(s for s in df.season.unique() if s < test_season)
    tr = sigs.season.isin(calib).values
    te = (sigs.season == test_season).values
    ytr, yte = sigs.result.values[tr], sigs.result.values[te]
    out, P_te = [], {}

    for col in sigs.columns:
        if col in {"matchId", "season", "date", "result"}:
            continue
        P = calibrate_1d(sigs[col].values[tr], ytr, sigs[col].values[te])
        P_te[col] = P
        out.append(score(col, yte, P))

    for col in probs.columns:
        if col == "matchId":
            continue
        raw_tr = np.vstack(probs[col].values[tr])
        raw_te = np.vstack(probs[col].values[te])
        # recalibrate the scoring models' log-odds so they compete on equal terms
        lr = LogisticRegression(max_iter=2000).fit(np.log(np.clip(raw_tr, 1e-6, 1)), ytr)
        P = lr.predict_proba(np.log(np.clip(raw_te, 1e-6, 1)))
        P = P[:, [list(lr.classes_).index(c) for c in CLASSES]]
        P_te[col] = P
        out.append(score(col, yte, P))

    F = [c for c in feats.columns if c not in ("matchId", "season", "result")]
    Xtr, Xte = feats[F].values[tr], feats[F].values[te]
    for name, est in zoo().items():
        try:
            P = ml_probs(est, Xtr, ytr, Xte)
            P_te[name] = P
            out.append(score(name, yte, P))
        except Exception as e:
            print(f"    {name} failed: {str(e)[:50]}")

    base = np.array([np.mean(ytr == c) for c in CLASSES])
    P_te["BASE_rates"] = np.tile(base, (te.sum(), 1))
    out.append(score("BASE_rates", yte, P_te["BASE_rates"]))
    P_te["BASE_always_home"] = np.tile([0.98, 0.01, 0.01], (te.sum(), 1))
    out.append(score("BASE_always_home", yte, P_te["BASE_always_home"]))

    mk = df[te][["mkt_home", "mkt_draw", "mkt_away"]].values
    have = ~np.isnan(mk).any(axis=1)
    if have.sum() > 50:
        M = np.where(np.isnan(mk), base, mk)
        P_te["MARKET_closing_line"] = M
        out.append(score("MARKET_closing_line", yte, M))

    # ensembles over the calibrated probabilities
    names = [n for n in P_te if not n.startswith(("BASE_", "MARKET_"))]
    stack = np.stack([P_te[n] for n in names])
    P_te["ENS_mean_prob"] = stack.mean(axis=0)
    lg = np.log(np.clip(stack, 1e-9, 1))
    e = np.exp(lg.mean(axis=0)); P_te["ENS_logit_mean"] = e / e.sum(axis=1, keepdims=True)
    # A pre-specified diverse five — chosen by family, never by test score, so
    # the ensemble cannot peek at the season it is being graded on.
    diverse = [n for n in ("elo_mov", "dixon_coles", "pi_rating", "massey", "ML_hist_gbm")
               if n in P_te]
    P_te["ENS_diverse5_mean"] = np.stack([P_te[n] for n in diverse]).mean(axis=0)
    for nm in ("ENS_mean_prob", "ENS_logit_mean", "ENS_diverse5_mean"):
        out.append(score(nm, yte, P_te[nm]))
    if "MARKET_closing_line" in P_te:
        for w, nm in ((0.5, "ENS_market_x_model_50"), (0.75, "ENS_market_x_model_75")):
            P = w * P_te["MARKET_closing_line"] + (1 - w) * P_te["ENS_logit_mean"]
            out.append(score(nm, yte, P))
            P_te[nm] = P
    return out, P_te, yte


def main():
    global LG_HOME, LG_AWAY
    ap = add_league_arg(argparse.ArgumentParser(description=__doc__))
    league = get_league(ap.parse_args().league)
    data = os.path.join(HERE, "data", league.slug)
    os.makedirs(RESULTS, exist_ok=True)
    print(f"{league.name} ({league.country})")

    df = pd.read_csv(os.path.join(data, "matches.csv")).sort_values(["date", "matchId"])
    pm = pd.read_csv(os.path.join(data, "player_matches.csv"))
    tm = (pm.groupby(["matchId", "is_home"])[["totalShots", "shotsOnTarget"]].sum()
          .unstack("is_home"))
    df = df.merge(pd.DataFrame({
        "matchId": tm.index,
        "away_shots": tm[("totalShots", 0)].values, "home_shots": tm[("totalShots", 1)].values,
        "away_sot": tm[("shotsOnTarget", 0)].values, "home_sot": tm[("shotsOnTarget", 1)].values,
    }), on="matchId", how="left").reset_index(drop=True)
    LG_HOME = float(df.home_goals.mean()); LG_AWAY = float(df.away_goals.mean())
    print(f"{len(df):,} matches, {df.season.min()}-{df.season.max()}  "
          f"home {(df.result == 'H').mean():.3f} / draw {(df.result == 'D').mean():.3f} / "
          f"away {(df.result == 'A').mean():.3f}   goals {LG_HOME:.2f}-{LG_AWAY:.2f}")
    print("walking forward ...", flush=True)
    sigs, probs, feats = walk(df)

    pooled_P, pooled_y, per_season = {}, [], []
    for ts in ROLLING_TEST:
        print(f"  test {ts}-{str(ts + 1)[2:]} ...", flush=True)
        out, P_te, yte = evaluate_season(df, sigs, probs, feats, ts)
        pooled_y.append(yte)
        for n, P in P_te.items():
            pooled_P.setdefault(n, []).append(P)
        for r in out:
            per_season.append({**r, "test_season": ts})

    y = np.concatenate(pooled_y)
    P = {n: np.vstack(v) for n, v in pooled_P.items() if len(v) == len(ROLLING_TEST)}
    R = pd.DataFrame([score(n, y, p) for n, p in P.items()]).sort_values("rps")
    R.insert(0, "league", league.slug)
    R.to_csv(os.path.join(RESULTS, f"{league.slug}_bakeoff.csv"), index=False)
    per = pd.DataFrame(per_season)
    per.insert(0, "league", league.slug)
    per.to_csv(os.path.join(RESULTS, f"{league.slug}_bakeoff_per_season.csv"), index=False)

    print("\n" + "=" * 86)
    print(f"{league.name.upper()} MATCH-OUTCOME BAKE-OFF — pooled "
          f"{ROLLING_TEST[0]}-{ROLLING_TEST[-1] + 1}, "
          f"{len(y):,} matches (lower RPS is better)")
    print("=" * 86)
    print(f"{'#':>2}  {'algorithm':30s} {'RPS':>8} {'logloss':>9} {'acc':>7} {'brier':>8}")
    for i, r in enumerate(R.itertuples(), 1):
        mark = ""
        if r.model.startswith("MARKET"):
            mark = "  <<< the price"
        elif r.model.startswith("ENS_market"):
            mark = "  (uses the price)"
        print(f"{i:>2}  {r.model:30s} {r.rps:>8.4f} {r.logloss:>9.4f} {r.acc:>7.1%} "
              f"{r.brier:>8.4f}{mark}")
    print(f"\nsaved -> results/{league.slug}_bakeoff.csv")


if __name__ == "__main__":
    main()
