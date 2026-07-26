"""
Exhaustive MLB game-outcome bake-off — "which algorithm should the platform use
to predict who wins an MLB game?"

MLB has never been bake-offed in this repo (MODEL-BAKEOFF.md covers NBA/NFL
only), and it is the hardest of the three sports: the home team wins only ~52.8%
of the time and a great starter can be undone by one swing.

Protocol
--------
ONE chronological walk-forward pass over 9,737 games (2021-2024). Before each
game every algorithm emits a RAW pre-game signal from state built only on
earlier games; then the result updates that state. No leakage anywhere.

Fair comparison: each model's raw signal (a rating gap, a probability, a run
differential - different units) is mapped to a probability by a 1-D logistic
(Platt) fit ONLY on the training seasons (2021-2023) and applied to the 2024
test season. AUC is invariant to that monotone map, so it measures pure ranking
skill; Brier / log loss then measure calibrated quality on equal footing.

Families: baselines, Elo variants, linear-algebra ratings (Massey/Colley/
Bradley-Terry), state-space (Kalman), Bayesian hierarchical, run-scoring
processes (Poisson / Dixon-Coles / negative binomial), pitcher-aware models,
situational (rest, streak, head-to-head, park), machine learning, ensembles.
"""
import os, math, warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from scipy.stats import skellam, nbinom
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import (RandomForestClassifier, ExtraTreesClassifier,
                              HistGradientBoostingClassifier)
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import cross_val_predict, GroupKFold
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

TRAIN_SEASONS = {2021, 2022, 2023}
TEST_SEASON = 2024
REFIT_EVERY = 50          # games between Massey/Colley/Bradley-Terry refits
LG_RUNS = 4.45            # league runs per team per game (set from data)


# ----------------------------------------------------------------- helpers
def sig(x):
    return 1.0 / (1.0 + math.exp(-max(-35.0, min(35.0, x))))


def skellam_home(lh, la):
    """P(home wins) for independent Poisson run totals; split ties (extras)."""
    lh, la = max(lh, 0.15), max(la, 0.15)
    p_gt = float(skellam.sf(0, lh, la))
    p_eq = float(skellam.pmf(0, lh, la))
    return p_gt + 0.5 * p_eq


def dixon_coles_home(lh, la, rho=-0.05, cap=18):
    """Poisson grid with the Dixon-Coles low-score dependence correction."""
    lh, la = max(lh, 0.15), max(la, 0.15)
    i = np.arange(cap + 1)
    ph = np.exp(-lh) * lh ** i / np.array([math.factorial(k) for k in i])
    pa = np.exp(-la) * la ** i / np.array([math.factorial(k) for k in i])
    M = np.outer(ph, pa)
    M[0, 0] *= 1 - lh * la * rho
    M[0, 1] *= 1 + lh * rho
    M[1, 0] *= 1 + la * rho
    M[1, 1] *= 1 - rho
    M /= M.sum()
    win = np.tril(M, -1).sum()          # home > away
    tie = np.trace(M)
    return win + 0.5 * tie


def nb_home(lh, la, disp=8.0, cap=18):
    """Negative-binomial run totals (over-dispersed vs Poisson)."""
    lh, la = max(lh, 0.15), max(la, 0.15)
    i = np.arange(cap + 1)
    ph = nbinom.pmf(i, disp, disp / (disp + lh))
    pa = nbinom.pmf(i, disp, disp / (disp + la))
    M = np.outer(ph, pa); M /= M.sum()
    return np.tril(M, -1).sum() + 0.5 * np.trace(M)


# ------------------------------------------------------------------ state
class State:
    """Every algorithm's running memory, updated after each game."""

    def __init__(self, teams):
        self.teams = list(teams)
        self.idx = {t: i for i, t in enumerate(self.teams)}
        n = len(self.teams)
        # season-scoped tallies
        self.w = defaultdict(int); self.l = defaultdict(int)
        self.rs = defaultdict(int); self.ra = defaultdict(int); self.gp = defaultdict(int)
        # Elo family (carried across seasons with regression to mean)
        self.elo = defaultdict(lambda: 1500.0)
        self.elo_mov = defaultdict(lambda: 1500.0)
        self.elo_p = defaultdict(lambda: 1500.0)
        # Glicko-ish: rating + deviation
        self.g_r = defaultdict(lambda: 1500.0); self.g_rd = defaultdict(lambda: 350.0)
        # Kalman state-space rating (mean, variance)
        self.k_m = defaultdict(float); self.k_v = defaultdict(lambda: 1.0)
        # Bayesian hierarchical strength (normal-normal conjugate on margin)
        self.b_m = defaultdict(float); self.b_n = defaultdict(float)
        # run-scoring EWMAs (attack / defence, multiplicative vs league)
        self.att = defaultdict(lambda: 1.0); self.dfn = defaultdict(lambda: 1.0)
        # recent form / streak / rest / head-to-head
        self.last10 = defaultdict(lambda: deque(maxlen=10))
        self.streak = defaultdict(int)
        self.last_date = {}
        self.h2h = defaultdict(lambda: [0, 0])
        # starting pitcher: opponent runs allowed while he started
        self.sp_runs = defaultdict(float); self.sp_gs = defaultdict(int)
        # accumulators for matrix ratings
        self.hist = []            # (home_idx, away_idx, margin, home_win)
        self.massey = np.zeros(n); self.colley = np.zeros(n)
        self.bt = np.zeros(n); self.bt_hfa = 0.1
        self.since_fit = 10 ** 9

    # -------- pre-game signals --------
    def pyth(self, t, exp_=1.83):
        rs, ra = self.rs[t], self.ra[t]
        if rs + ra == 0:
            return 0.5
        return rs ** exp_ / (rs ** exp_ + ra ** exp_)

    def pythagenpat(self, t):
        g = max(self.gp[t], 1)
        rpg = (self.rs[t] + self.ra[t]) / g
        exp_ = max(0.5, min(2.5, rpg ** 0.287)) if rpg > 0 else 1.83
        return self.pyth(t, exp_)

    def winpct(self, t):
        n = self.w[t] + self.l[t]
        return (self.w[t] + 8) / (n + 16) if n else 0.5      # shrunk to .500

    def rdiff(self, t):
        g = max(self.gp[t], 1)
        return (self.rs[t] - self.ra[t]) / g

    def form10(self, t):
        d = self.last10[t]
        return sum(d) / len(d) if d else 0.5

    def sp_quality(self, pid):
        """Shrunk mean opponent runs while this pitcher started (lower = better)."""
        if pid is None or self.sp_gs[pid] == 0:
            return LG_RUNS
        k = 6.0
        return (self.sp_runs[pid] + k * LG_RUNS) / (self.sp_gs[pid] + k)

    def refit_matrix(self):
        """Massey / Colley / Bradley-Terry from all games so far."""
        n = len(self.teams)
        if len(self.hist) < 60:
            return
        H = np.array(self.hist, dtype=float)
        hi, ai, mar, hw = H[:, 0].astype(int), H[:, 1].astype(int), H[:, 2], H[:, 3]
        # --- Massey (least squares on margins) ---
        M = np.zeros((n, n)); p = np.zeros(n)
        np.add.at(M, (hi, hi), 1); np.add.at(M, (ai, ai), 1)
        np.add.at(M, (hi, ai), -1); np.add.at(M, (ai, hi), -1)
        np.add.at(p, hi, mar); np.add.at(p, ai, -mar)
        M[-1, :] = 1.0; p[-1] = 0.0
        try:
            self.massey = np.linalg.lstsq(M, p, rcond=None)[0]
        except Exception:
            pass
        # --- Colley (wins/losses, matrix-regularized) ---
        C = np.zeros((n, n)); b = np.ones(n)
        np.add.at(C, (hi, hi), 1); np.add.at(C, (ai, ai), 1)
        np.add.at(C, (hi, ai), -1); np.add.at(C, (ai, hi), -1)
        C += 2 * np.eye(n)
        np.add.at(b, hi, (hw - (1 - hw)) / 2); np.add.at(b, ai, ((1 - hw) - hw) / 2)
        try:
            self.colley = np.linalg.solve(C, b)
        except Exception:
            pass
        # --- Bradley-Terry (logistic MLE with ridge + home edge) ---
        X = np.zeros((len(H), n + 1))
        X[np.arange(len(H)), hi] = 1
        X[np.arange(len(H)), ai] = -1
        X[:, n] = 1.0
        try:
            lr = LogisticRegression(fit_intercept=False, C=0.5, max_iter=400)
            lr.fit(X, hw)
            self.bt = lr.coef_[0][:n]; self.bt_hfa = lr.coef_[0][n]
        except Exception:
            pass

    # -------- post-game update --------
    def update(self, g):
        h, a = g.home, g.away
        hs, as_ = g.home_score, g.away_score
        hw = 1 if hs > as_ else 0
        mar = hs - as_
        # tallies
        self.w[h] += hw; self.l[h] += 1 - hw
        self.w[a] += 1 - hw; self.l[a] += hw
        self.rs[h] += hs; self.ra[h] += as_
        self.rs[a] += as_; self.ra[a] += hs
        self.gp[h] += 1; self.gp[a] += 1
        self.last10[h].append(hw); self.last10[a].append(1 - hw)
        self.streak[h] = self.streak[h] + 1 if hw else 0
        self.streak[a] = self.streak[a] + 1 if not hw else 0
        self.last_date[h] = g.date; self.last_date[a] = g.date
        self.h2h[(h, a)][0 if hw else 1] += 1
        self.h2h[(a, h)][1 if hw else 0] += 1
        # Elo variants
        for store, k, use_mov in ((self.elo, 4.0, False), (self.elo_mov, 4.0, True),
                                  (self.elo_p, 4.0, True)):
            exp_h = 1 / (1 + 10 ** (-((store[h] + 24) - store[a]) / 400))
            mult = math.log(abs(mar) + 1) if use_mov else 1.0
            d = k * mult * (hw - exp_h)
            store[h] += d; store[a] -= d
        # Glicko-ish
        for t, opp, res in ((h, a, hw), (a, h, 1 - hw)):
            rd = self.g_rd[t]
            q = math.log(10) / 400
            gd = 1 / math.sqrt(1 + 3 * q * q * self.g_rd[opp] ** 2 / math.pi ** 2)
            e = 1 / (1 + 10 ** (-gd * (self.g_r[t] - self.g_r[opp]) / 400))
            dsq = 1 / (q * q * gd * gd * e * (1 - e) + 1e-9)
            self.g_r[t] += (q / (1 / rd ** 2 + 1 / dsq)) * gd * (res - e)
            self.g_rd[t] = max(30.0, math.sqrt(1 / (1 / rd ** 2 + 1 / dsq)))
        # Kalman filter on margin (observation = margin - hfa)
        Q, R = 0.02, 9.0
        pred = self.k_m[h] - self.k_m[a] + 0.15
        resid = mar - pred
        for t, s in ((h, +1), (a, -1)):
            self.k_v[t] += Q
            kg = self.k_v[t] / (self.k_v[t] + R)
            self.k_m[t] += s * kg * resid
            self.k_v[t] *= (1 - kg)
        # Bayesian hierarchical (conjugate mean of margins, shrunk)
        for t, s in ((h, +1), (a, -1)):
            self.b_n[t] += 1
            self.b_m[t] += (s * mar - self.b_m[t]) / (self.b_n[t] + 12)
        # run-scoring attack / defence EWMA (multiplicative)
        al = 0.06
        self.att[h] += al * (hs / LG_RUNS - self.att[h])
        self.dfn[h] += al * (as_ / LG_RUNS - self.dfn[h])
        self.att[a] += al * (as_ / LG_RUNS - self.att[a])
        self.dfn[a] += al * (hs / LG_RUNS - self.dfn[a])
        # starting pitchers: runs the opponent put up while they started
        if not pd.isna(g.home_sp):
            self.sp_runs[g.home_sp] += as_; self.sp_gs[g.home_sp] += 1
        if not pd.isna(g.away_sp):
            self.sp_runs[g.away_sp] += hs; self.sp_gs[g.away_sp] += 1
        # matrix-rating history
        self.hist.append((self.idx[h], self.idx[a], mar, hw))
        self.since_fit += 1

    def season_reset(self):
        """New season: regress ratings to the mean, clear season tallies."""
        for d in (self.w, self.l, self.rs, self.ra, self.gp):
            d.clear()
        for store in (self.elo, self.elo_mov, self.elo_p):
            for t in list(store):
                store[t] = 1500 + 0.70 * (store[t] - 1500)
        for t in list(self.g_rd):
            self.g_rd[t] = min(350.0, self.g_rd[t] + 60)
        for t in list(self.k_v):
            self.k_v[t] += 0.35
        self.last10.clear(); self.streak.clear()


# ------------------------------------------------------------ walk-forward
def walk(df):
    st = State(sorted(set(df.home) | set(df.away)))
    sig_rows, feat_rows = [], []
    cur_season = None

    for g in df.itertuples():
        if g.season != cur_season:
            if cur_season is not None:
                st.season_reset()
            cur_season = g.season
        if st.since_fit >= REFIT_EVERY:
            st.refit_matrix(); st.since_fit = 0

        h, a = g.home, g.away
        hi, ai = st.idx[h], st.idx[a]
        # ---------- raw signals ----------
        elo_d = (st.elo[h] + 24) - st.elo[a]
        mov_d = (st.elo_mov[h] + 24) - st.elo_mov[a]
        sp_h, sp_a = st.sp_quality(g.home_sp), st.sp_quality(g.away_sp)
        # pitcher-adjusted Elo: better starter (fewer runs allowed) is a bonus
        elo_pd = mov_d + 26.0 * (sp_a - sp_h)
        lam_h = LG_RUNS * st.att[h] * st.dfn[a] * 1.03
        lam_a = LG_RUNS * st.att[a] * st.dfn[h] * 0.97
        # pitcher-tilted run expectations
        plam_h = LG_RUNS * st.att[h] * (sp_a / LG_RUNS) * 1.03
        plam_a = LG_RUNS * st.att[a] * (sp_h / LG_RUNS) * 0.97
        rest_h = (pd.Timestamp(g.date) - pd.Timestamp(st.last_date[h])).days if h in st.last_date else 3
        rest_a = (pd.Timestamp(g.date) - pd.Timestamp(st.last_date[a])).days if a in st.last_date else 3
        hh, hl = st.h2h[(h, a)]

        s = {
            # --- baselines ---
            "always_home": 1.0,
            "win_pct_log5": st.winpct(h) - st.winpct(a),
            "pythagorean": st.pyth(h) - st.pyth(a),
            "pythagenpat": st.pythagenpat(h) - st.pythagenpat(a),
            "run_differential": st.rdiff(h) - st.rdiff(a),
            "recent_form_10": st.form10(h) - st.form10(a),
            # --- rating systems ---
            "elo_basic": elo_d,
            "elo_margin_of_victory": mov_d,
            "elo_plus_pitcher": elo_pd,
            "glicko": (st.g_r[h] + 24) - st.g_r[a],
            "bradley_terry": st.bt[hi] - st.bt[ai] + st.bt_hfa,
            "massey": st.massey[hi] - st.massey[ai] + 0.15,
            "colley": st.colley[hi] - st.colley[ai],
            "kalman_state_space": st.k_m[h] - st.k_m[a] + 0.15,
            "bayes_hierarchical": st.b_m[h] - st.b_m[a] + 0.15,
            # --- run-scoring processes ---
            "poisson_skellam": skellam_home(lam_h, lam_a),
            "dixon_coles": dixon_coles_home(lam_h, lam_a),
            "negative_binomial": nb_home(lam_h, lam_a),
            # --- pitcher-aware ---
            "starter_quality_only": sp_a - sp_h,
            "starter_plus_offense": (sp_a - sp_h) + 0.5 * (st.att[h] - st.att[a]),
            "poisson_pitcher_adj": skellam_home(plam_h, plam_a),
            # --- situational / out-of-the-box ---
            "rest_advantage": rest_h - rest_a,
            "streak_momentum": st.streak[h] - st.streak[a],
            "head_to_head": (hh - hl) / max(hh + hl, 1),
            "home_only_edge": 1.0 if True else 0.0,
        }
        sig_rows.append(dict(gamePk=g.gamePk, season=g.season, date=g.date,
                             home_win=g.home_win, **s))
        # ---------- ML feature vector ----------
        feat_rows.append(dict(
            gamePk=g.gamePk, season=g.season, home_win=g.home_win,
            elo=elo_d, mov=mov_d, glicko=(st.g_r[h] - st.g_r[a]),
            bt=st.bt[hi] - st.bt[ai], massey=st.massey[hi] - st.massey[ai],
            colley=st.colley[hi] - st.colley[ai], kalman=st.k_m[h] - st.k_m[a],
            bayes=st.b_m[h] - st.b_m[a],
            winpct=st.winpct(h) - st.winpct(a), pyth=st.pyth(h) - st.pyth(a),
            rdiff=st.rdiff(h) - st.rdiff(a), form=st.form10(h) - st.form10(a),
            att_h=st.att[h], att_a=st.att[a], dfn_h=st.dfn[h], dfn_a=st.dfn[a],
            sp_h=sp_h, sp_a=sp_a, sp_gap=sp_a - sp_h,
            poisson=skellam_home(lam_h, lam_a),
            rest=rest_h - rest_a, streak=st.streak[h] - st.streak[a],
            h2h=(hh - hl) / max(hh + hl, 1),
            gp=min(st.gp[h], 162),
        ))
        st.update(g)

    return pd.DataFrame(sig_rows), pd.DataFrame(feat_rows)


# -------------------------------------------------------------- evaluation
def platt(s_tr, y_tr, s_te):
    s_tr = np.asarray(s_tr, float).reshape(-1, 1)
    if np.std(s_tr) < 1e-12:
        return np.full(len(s_te), float(np.mean(y_tr)))
    lr = LogisticRegression(max_iter=1000).fit(s_tr, y_tr)
    return lr.predict_proba(np.asarray(s_te, float).reshape(-1, 1))[:, 1]


def auc(y, p):
    y = np.asarray(y); p = np.asarray(p)
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    csum = np.cumsum(cnt); r = ((csum - cnt + csum + 1) / 2.0)[inv]
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def ece(y, p, bins=10):
    y = np.asarray(y); p = np.asarray(p); e = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= 1)
        if m.sum():
            e += m.sum() / len(y) * abs(p[m].mean() - y[m].mean())
    return e


def score(name, y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return dict(model=name, acc=float(((p >= 0.5) == (np.asarray(y) == 1)).mean()),
                auc=auc(y, p), brier=float(np.mean((p - y) ** 2)),
                logloss=float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
                ece=ece(y, p))


def main():
    df = pd.read_csv(os.path.join(DATA, "games.csv"))
    global LG_RUNS
    LG_RUNS = float((df.home_score.sum() + df.away_score.sum()) / (2 * len(df)))
    print(f"{len(df):,} games | league runs/team/game = {LG_RUNS:.3f} | "
          f"home win rate = {df.home_win.mean():.4f}")
    print("walking forward ...")
    sigs, feats = walk(df)

    tr = sigs[sigs.season.isin(TRAIN_SEASONS)]
    te = sigs[sigs.season == TEST_SEASON]
    ytr, yte = tr.home_win.values, te.home_win.values
    print(f"train {len(tr):,} (2021-23)   test {len(te):,} (2024)")

    results = []
    skip = {"gamePk", "season", "date", "home_win", "home_only_edge"}
    for col in sigs.columns:
        if col in skip:
            continue
        results.append(score(col, yte, platt(tr[col].values, ytr, te[col].values)))

    # ---------------------------- machine learning ----------------------------
    FEATS = [c for c in feats.columns if c not in ("gamePk", "season", "home_win")]
    ftr, fte = feats[feats.season.isin(TRAIN_SEASONS)], feats[feats.season == TEST_SEASON]
    Xtr, Xte, ytr2 = ftr[FEATS].values, fte[FEATS].values, ftr.home_win.values

    ml = {
        "ML_logistic": make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "ML_logistic_L1": make_pipeline(StandardScaler(), LogisticRegression(penalty="l1", solver="liblinear", C=0.3, max_iter=3000)),
        "ML_random_forest": RandomForestClassifier(n_estimators=500, min_samples_leaf=40, n_jobs=-1, random_state=0),
        "ML_extra_trees": ExtraTreesClassifier(n_estimators=500, min_samples_leaf=40, n_jobs=-1, random_state=0),
        "ML_hist_gbm": HistGradientBoostingClassifier(random_state=0, learning_rate=0.04, max_iter=400,
                                                      max_leaf_nodes=12, l2_regularization=2.0,
                                                      early_stopping=True, validation_fraction=0.15),
        "ML_xgboost": XGBClassifier(n_estimators=350, max_depth=3, learning_rate=0.04, subsample=0.8,
                                    colsample_bytree=0.8, reg_lambda=3.0, eval_metric="logloss", verbosity=0),
        "ML_lightgbm": LGBMClassifier(n_estimators=400, num_leaves=12, learning_rate=0.04, subsample=0.8,
                                      colsample_bytree=0.8, reg_lambda=3.0, verbose=-1),
        "ML_neural_net": make_pipeline(StandardScaler(), MLPClassifier((24,), alpha=1e-1, max_iter=1500,
                                                                       early_stopping=True, random_state=0)),
    }
    test_probs = {}
    for name, est in ml.items():
        try:
            est.fit(Xtr, ytr2)
            p = est.predict_proba(Xte)[:, 1]
            test_probs[name] = p
            results.append(score(name, yte, p))
        except Exception as e:
            print(f"  {name} failed: {str(e)[:60]}")

    # ---------------------------- ensembles ----------------------------
    # stacked super-learner (out-of-fold, grouped by game)
    gkf = GroupKFold(4).split(Xtr, ytr2, ftr.gamePk.values)
    base = {k: ml[k] for k in ("ML_logistic", "ML_hist_gbm", "ML_random_forest", "ML_xgboost")}
    OOF, TST = [], []
    for est in base.values():
        OOF.append(cross_val_predict(est, Xtr, ytr2, cv=GroupKFold(4).split(Xtr, ytr2, ftr.gamePk.values),
                                     method="predict_proba", n_jobs=-1)[:, 1])
        est.fit(Xtr, ytr2); TST.append(est.predict_proba(Xte)[:, 1])
    meta = LogisticRegression(max_iter=2000).fit(np.column_stack(OOF), ytr2)
    results.append(score("ENS_stack_super_learner", yte, meta.predict_proba(np.column_stack(TST))[:, 1]))

    # simple average of the strongest diverse signals
    strong = ["elo_margin_of_victory", "bradley_terry", "poisson_skellam", "elo_plus_pitcher"]
    avg_tr = np.mean([platt(tr[c].values, ytr, tr[c].values) for c in strong], axis=0)
    avg_te = np.mean([platt(tr[c].values, ytr, te[c].values) for c in strong], axis=0)
    results.append(score("ENS_mean_of_4_models", yte, avg_te))
    # model + ML blend
    results.append(score("ENS_elo_x_ml_logistic", yte,
                         0.5 * platt(tr["elo_margin_of_victory"].values, ytr, te["elo_margin_of_victory"].values)
                         + 0.5 * test_probs["ML_logistic"]))

    # ---------------------------- report ----------------------------
    R = pd.DataFrame(results).sort_values("auc", ascending=False).reset_index(drop=True)
    R.to_csv(os.path.join(HERE, "bakeoff_results.csv"), index=False)
    base_acc = float(yte.mean())
    print("\n" + "=" * 84)
    print(f"MLB GAME-OUTCOME BAKE-OFF   test = {TEST_SEASON}   "
          f"{len(te):,} games   (always-home = {base_acc:.1%})")
    print("=" * 84)
    print(f"{'#':>2}  {'algorithm':30s} {'AUC':>6} {'acc':>7} {'Brier':>7} {'logloss':>8} {'ECE':>6}")
    for i, r in enumerate(R.itertuples(), 1):
        print(f"{i:>2}  {r.model:30s} {r.auc:>6.4f} {r.acc:>7.1%} {r.brier:>7.4f} "
              f"{r.logloss:>8.4f} {r.ece:>6.3f}")
    print(f"\nsaved -> bakeoff_results.csv")


if __name__ == "__main__":
    main()
