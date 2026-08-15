"""
Match-winner bake-off for one tour — every algorithm worth trying.

Tennis is a two-way problem with no draw, so the metrics are log loss, Brier and
accuracy rather than the ranked probability score football needs. Log loss is
the one that matters: it punishes confident wrongness, which is exactly the
failure mode of a rating system that has not seen a player recently.

ORIENTATION, AND WHY IT IS NOT RANDOM
-------------------------------------
The raw feed gives winner and loser, so a naive row leaks the answer. Every
match is re-cast as a single row with a DETERMINISTIC orientation — the player
with the smaller id is always "A" — and the target is whether A won. Player ids
are assigned by ESPN in registration order and carry no information about who
wins, so this is unbiased and, unlike a random coin, it is reproducible.

Every feature is then built to be ANTISYMMETRIC (A-minus-B). A model fed
antisymmetric features cannot learn "player A tends to win"; there is no such
tendency to learn.

Families covered:
  baselines      coin flip, always-the-seed, seed difference
  ratings        Elo (3 K values), surface Elo, blended surface/global Elo,
                 margin-aware (games) Elo, Glicko, Bradley-Terry
  form           career/season/last-N win rate, surface win rate, games-won
                 ratio, current win streak
  context        head-to-head, common opponents, fatigue (matches this event),
                 rest days, seed, draw size, round, best-of
  machine        logistic (L1/L2), random forest, extra trees, hist-GBM, MLP,
                 kNN, naive Bayes, SVM
  ensembles      probability mean, logit mean, a pre-specified diverse five

Protocol: one chronological walk-forward pass; state for a match is built only
from earlier matches. One-dimensional signals are mapped to a probability by a
logistic fitted on the calibration seasons only. Every season from 2023 takes a
turn as the test set and the results are pooled.

Usage: python3 bakeoff_tennis.py --tour atp
"""

import argparse
import math
import os
import warnings
from collections import defaultdict, deque

import numpy as np
import pandas as pd
from sklearn.ensemble import (ExtraTreesClassifier, HistGradientBoostingClassifier,
                              RandomForestClassifier)
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from tours import ROLLING_TEST, add_tour_arg, get as get_tour

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")
RNG = 0

ELO_INIT = 1500.0
SURFACES = ("hard", "clay", "grass", "unknown")


# ----------------------------------------------------------------- metrics
def logloss(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p):
    return float(np.mean((p - y) ** 2))


def accuracy(y, p):
    return float(np.mean((p >= 0.5) == (y == 1)))


def auc(y, p):
    y = np.asarray(y)
    o = np.argsort(p)
    r = np.empty(len(p), float)
    r[o] = np.arange(1, len(p) + 1)
    r = pd.DataFrame({"p": p, "r": r}).groupby("p").r.transform("mean").values
    n1 = y.sum()
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def ece(y, p, bins=10):
    """Expected calibration error — how far the stated probability is from truth."""
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    tot = 0.0
    for b in range(bins):
        m = idx == b
        if m.sum():
            tot += m.sum() / len(p) * abs(p[m].mean() - y[m].mean())
    return float(tot)


def score(name, y, p):
    return dict(model=name, logloss=logloss(y, p), brier=brier(y, p),
                acc=accuracy(y, p), auc=auc(y, p), ece=ece(y, p))


# -------------------------------------------------------------------- state
class State:
    """Everything known about every player, updated match by match."""

    def __init__(self):
        self.elo = defaultdict(lambda: ELO_INIT)          # K = 24
        self.elo_fast = defaultdict(lambda: ELO_INIT)     # K = 40
        self.elo_slow = defaultdict(lambda: ELO_INIT)     # K = 12
        self.elo_games = defaultdict(lambda: ELO_INIT)    # margin-aware
        self.elo_surf = {s: defaultdict(lambda: ELO_INIT) for s in SURFACES}
        self.g_r = defaultdict(lambda: ELO_INIT)          # Glicko rating
        self.g_rd = defaultdict(lambda: 350.0)
        self.bt = defaultdict(float)                      # Bradley-Terry strength
        self.n = defaultdict(int)
        self.w = defaultdict(int)
        self.n_surf = defaultdict(int)                    # (player, surface)
        self.w_surf = defaultdict(int)
        self.gw = defaultdict(float)                      # games won / played
        self.gp = defaultdict(float)
        self.last = defaultdict(lambda: deque(maxlen=20))  # recent results
        self.streak = defaultdict(int)
        self.h2h = defaultdict(lambda: [0, 0])            # (a,b) -> [a wins, b wins]
        self.beat = defaultdict(set)                      # players each has beaten
        self.lost_to = defaultdict(set)
        self.last_date = {}
        self.event_matches = defaultdict(int)             # (player, tournamentId)

    # ---- read-side helpers, all antisymmetric A - B
    def rate(self, store, p):
        return store[p]

    def winrate(self, p, k=6.0):
        return (self.w[p] + k * 0.5) / (self.n[p] + k)

    def surf_winrate(self, p, s, k=6.0):
        return (self.w_surf[(p, s)] + k * 0.5) / (self.n_surf[(p, s)] + k)

    def form(self, p, n=10):
        d = list(self.last[p])[-n:]
        return sum(d) / len(d) if d else 0.5

    def gwr(self, p, k=20.0):
        return (self.gw[p] + k * 0.5) / (self.gp[p] + k)

    def h2h_edge(self, a, b):
        wa, wb = self.h2h[(a, b)]
        return (wa - wb) / (wa + wb) if (wa + wb) else 0.0

    def common(self, a, b):
        """Common-opponent edge: players A beat that B lost to, and vice versa."""
        up = len(self.beat[a] & self.lost_to[b])
        dn = len(self.beat[b] & self.lost_to[a])
        return (up - dn) / (up + dn) if (up + dn) else 0.0

    def rest(self, p, date):
        d = self.last_date.get(p)
        if d is None:
            return 30.0
        return min((pd.Timestamp(date) - pd.Timestamp(d)).days, 60)

    # ---- write side
    def update(self, m, a, b, ya):
        """Fold a match in. `a`/`b` are ids, `ya` is 1 when a won."""
        wa, wb = (a, b) if ya else (b, a)
        surf = m.surface
        games_a, games_b = (m.w_games, m.l_games) if ya else (m.l_games, m.w_games)
        total = max(games_a + games_b, 1)

        for store, k in ((self.elo, 24.0), (self.elo_fast, 40.0), (self.elo_slow, 12.0)):
            ea = 1 / (1 + 10 ** ((store[b] - store[a]) / 400))
            d = k * (ya - ea)
            store[a] += d
            store[b] -= d

        # Margin-aware: a 6-0 6-0 win moves ratings more than 7-6 7-6.
        ea = 1 / (1 + 10 ** ((self.elo_games[b] - self.elo_games[a]) / 400))
        mult = 0.5 + abs(games_a - games_b) / total
        d = 24.0 * mult * (ya - ea)
        self.elo_games[a] += d
        self.elo_games[b] -= d

        st = self.elo_surf[surf if surf in self.elo_surf else "unknown"]
        ea = 1 / (1 + 10 ** ((st[b] - st[a]) / 400))
        d = 24.0 * (ya - ea)
        st[a] += d
        st[b] -= d

        # Glicko: uncertainty shrinks with matches played.
        q = math.log(10) / 400
        for p, opp, res in ((a, b, ya), (b, a, 1 - ya)):
            g = 1 / math.sqrt(1 + 3 * q * q * self.g_rd[opp] ** 2 / math.pi ** 2)
            e = 1 / (1 + 10 ** (-g * (self.g_r[p] - self.g_r[opp]) / 400))
            dsq = 1 / (q * q * g * g * e * (1 - e))
            denom = 1 / self.g_rd[p] ** 2 + 1 / dsq
            self.g_r[p] += (q / denom) * g * (res - e)
            self.g_rd[p] = max(math.sqrt(1 / denom), 30.0)

        # Bradley-Terry by stochastic gradient on the logistic likelihood.
        pa = 1 / (1 + math.exp(-(self.bt[a] - self.bt[b])))
        self.bt[a] += 0.05 * (ya - pa)
        self.bt[b] -= 0.05 * (ya - pa)

        for p, res, gwon, gplayed in ((a, ya, games_a, total), (b, 1 - ya, games_b, total)):
            self.n[p] += 1
            self.w[p] += res
            self.n_surf[(p, surf)] += 1
            self.w_surf[(p, surf)] += res
            self.gw[p] += gwon
            self.gp[p] += gplayed
            self.last[p].append(res)
            self.streak[p] = self.streak[p] + 1 if res else 0
            self.last_date[p] = m.date
            self.event_matches[(p, m.tournamentId)] += 1

        self.h2h[(a, b)][0 if ya else 1] += 1
        self.h2h[(b, a)][1 if ya else 0] += 1
        self.beat[wa].add(wb)
        self.lost_to[wb].add(wa)


SIGNALS = [
    "elo", "elo_fast", "elo_slow", "elo_games", "elo_surface", "elo_blend",
    "glicko", "bradley_terry", "seed_diff", "winrate", "surface_winrate",
    "form_last10", "games_won_ratio", "head_to_head", "common_opponents",
    "streak", "fatigue", "rest_days", "experience",
]


def walk(df):
    """Chronological pass. Returns per-signal arrays and the ML feature matrix."""
    st = State()
    sig = {k: np.zeros(len(df)) for k in SIGNALS}
    y = np.zeros(len(df), int)

    for i, m in enumerate(df.itertuples()):
        a, b = m.player_a, m.player_b
        ya = int(m.a_won)
        y[i] = ya
        surf = m.surface if m.surface in st.elo_surf else "unknown"

        sig["elo"][i] = st.elo[a] - st.elo[b]
        sig["elo_fast"][i] = st.elo_fast[a] - st.elo_fast[b]
        sig["elo_slow"][i] = st.elo_slow[a] - st.elo_slow[b]
        sig["elo_games"][i] = st.elo_games[a] - st.elo_games[b]
        s_gap = st.elo_surf[surf][a] - st.elo_surf[surf][b]
        sig["elo_surface"][i] = s_gap
        # Blend: surface ratings are thin early, so they are mixed with global.
        sig["elo_blend"][i] = 0.5 * s_gap + 0.5 * (st.elo[a] - st.elo[b])
        sig["glicko"][i] = st.g_r[a] - st.g_r[b]
        sig["bradley_terry"][i] = st.bt[a] - st.bt[b]
        # An unseeded player is worse than any seed; 40 stands in for "unseeded".
        sa = m.a_seed if m.a_seed == m.a_seed else 40.0
        sb = m.b_seed if m.b_seed == m.b_seed else 40.0
        sig["seed_diff"][i] = sb - sa
        sig["winrate"][i] = st.winrate(a) - st.winrate(b)
        sig["surface_winrate"][i] = st.surf_winrate(a, surf) - st.surf_winrate(b, surf)
        sig["form_last10"][i] = st.form(a) - st.form(b)
        sig["games_won_ratio"][i] = st.gwr(a) - st.gwr(b)
        sig["head_to_head"][i] = st.h2h_edge(a, b)
        sig["common_opponents"][i] = st.common(a, b)
        sig["streak"][i] = min(st.streak[a], 10) - min(st.streak[b], 10)
        sig["fatigue"][i] = (st.event_matches[(a, m.tournamentId)]
                             - st.event_matches[(b, m.tournamentId)])
        sig["rest_days"][i] = st.rest(a, m.date) - st.rest(b, m.date)
        sig["experience"][i] = math.log1p(st.n[a]) - math.log1p(st.n[b])

        st.update(m, a, b, ya)

    feats = np.column_stack([sig[k] for k in SIGNALS] + [
        df.bestOf.values.astype(float),
        df.drawSize.values.astype(float),
        pd.to_numeric(df.roundId, errors="coerce").fillna(0).values.astype(float),
    ])
    return sig, feats, y


# ------------------------------------------------------------- calibration
def calibrate(sig_tr, y_tr, sig_te):
    """One signal -> a probability, via a logistic fitted on training only."""
    X = np.asarray(sig_tr, float).reshape(-1, 1)
    if np.std(X) < 1e-12:
        return np.full(len(sig_te), float(np.mean(y_tr)))
    lr = LogisticRegression(max_iter=2000).fit(X, y_tr)
    return lr.predict_proba(np.asarray(sig_te, float).reshape(-1, 1))[:, 1]


def zoo():
    return {
        "ML_logistic_L2": lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
        "ML_logistic_L1": lambda: make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=3000, penalty="l1", solver="liblinear")),
        "ML_random_forest": lambda: RandomForestClassifier(
            n_estimators=400, min_samples_leaf=20, random_state=RNG, n_jobs=-1),
        "ML_extra_trees": lambda: ExtraTreesClassifier(
            n_estimators=400, min_samples_leaf=20, random_state=RNG, n_jobs=-1),
        "ML_hist_gbm": lambda: HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, random_state=RNG),
        "ML_neural_net": lambda: make_pipeline(
            StandardScaler(), MLPClassifier(hidden_layer_sizes=(32, 16), max_iter=600,
                                            random_state=RNG)),
        "ML_kNN": lambda: make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=200)),
        "ML_naive_bayes": lambda: make_pipeline(StandardScaler(), GaussianNB()),
        "ML_svm_rbf": lambda: make_pipeline(
            StandardScaler(), SVC(probability=True, random_state=RNG)),
    }


# The ensemble members are named BEFORE any result is read, so the ensemble is
# not selected on the test set. One per family, deliberately diverse.
ENSEMBLE_FIVE = ["elo_blend", "glicko", "surface_winrate", "seed_diff", "ML_logistic_L2"]


def evaluate_season(df, sig, feats, y, test_season):
    tr = (df.season < test_season).values
    te = (df.season == test_season).values
    if te.sum() == 0 or tr.sum() < 500:
        return {}, np.array([])

    P = {}
    P["BASE_coin_flip"] = np.full(int(te.sum()), 0.5)
    P["BASE_base_rate"] = np.full(int(te.sum()), float(y[tr].mean()))
    for k in SIGNALS:
        P[k] = calibrate(sig[k][tr], y[tr], sig[k][te])
    for name, make in zoo().items():
        try:
            P[name] = make().fit(feats[tr], y[tr]).predict_proba(feats[te])[:, 1]
        except Exception as e:
            print(f"    {name} failed: {str(e)[:50]}")

    stack = [P[k] for k in SIGNALS if k in P]
    P["ENS_mean_prob"] = np.mean(stack, axis=0)
    lg = np.mean([np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
                  for p in stack], axis=0)
    P["ENS_logit_mean"] = 1 / (1 + np.exp(-lg))
    five = [P[k] for k in ENSEMBLE_FIVE if k in P]
    P["ENS_diverse5"] = np.mean(five, axis=0)
    return P, y[te]


def main():
    ap = add_tour_arg(argparse.ArgumentParser(description=__doc__))
    tour = get_tour(ap.parse_args().tour)
    os.makedirs(RESULTS, exist_ok=True)
    data = os.path.join(HERE, "data", tour.slug)

    raw = pd.read_csv(os.path.join(data, "matches.csv")).sort_values(["date", "matchId"])
    df = orient(raw).reset_index(drop=True)
    print(f"{tour.name}: {len(df):,} matches, {df.season.min()}-{df.season.max()}  "
          f"A-won {df.a_won.mean():.3f} (0.500 == no orientation bias)")
    print(f"surface: " + "  ".join(f"{k} {v:.1%}" for k, v in
                                   df.surface.value_counts(normalize=True).items()))
    print("walking forward ...", flush=True)
    sig, feats, y = walk(df)

    pooled, ys = {}, []
    for ts in ROLLING_TEST:
        print(f"  test {ts} ...", flush=True)
        P, yte = evaluate_season(df, sig, feats, y, ts)
        if not P:
            continue
        ys.append(yte)
        for n, p in P.items():
            pooled.setdefault(n, []).append(p)

    yy = np.concatenate(ys)
    keep = {n: np.concatenate(v) for n, v in pooled.items() if len(v) == len(ys)}
    R = pd.DataFrame([score(n, yy, p) for n, p in keep.items()]).sort_values("logloss")
    R.insert(0, "tour", tour.slug)
    R.to_csv(os.path.join(RESULTS, f"{tour.slug}_bakeoff.csv"), index=False)

    print("\n" + "=" * 92)
    print(f"{tour.name} MATCH-WINNER BAKE-OFF — pooled {ROLLING_TEST[0]}-{ROLLING_TEST[-1]}, "
          f"{len(yy):,} matches (lower log loss is better)")
    print("=" * 92)
    print(f"{'#':>2}  {'algorithm':24} {'logloss':>9} {'brier':>8} {'acc':>7} {'AUC':>7} {'ECE':>7}")
    for i, r in enumerate(R.itertuples(), 1):
        print(f"{i:>2}  {r.model:24} {r.logloss:>9.4f} {r.brier:>8.4f} {r.acc:>7.1%} "
              f"{r.auc:>7.4f} {r.ece:>7.4f}")
    print(f"\nsaved -> results/{tour.slug}_bakeoff.csv")

    # The surface question, answered rather than assumed.
    g = R.set_index("model")
    if "elo_surface" in g.index and "elo" in g.index:
        d = g.loc["elo", "logloss"] - g.loc["elo_surface", "logloss"]
        db = g.loc["elo", "logloss"] - g.loc["elo_blend", "logloss"]
        print("\n" + "=" * 92)
        print("DOES THE HAND-BUILT SURFACE TABLE EARN ITS PLACE?")
        print("=" * 92)
        print(f"  global Elo        {g.loc['elo', 'logloss']:.4f}")
        print(f"  surface-only Elo  {g.loc['elo_surface', 'logloss']:.4f}   "
              f"({'better' if d > 0 else 'WORSE'} by {abs(d):.4f})")
        print(f"  blended Elo       {g.loc['elo_blend', 'logloss']:.4f}   "
              f"({'better' if db > 0 else 'WORSE'} by {abs(db):.4f})")
        print("  If the labels were noise, splitting by them could not help.")


def orient(raw):
    """
    One row per match, oriented so the smaller player id is always A.

    This is what removes the leak: the raw feed names a winner and a loser, so
    any row keyed on those columns knows the answer. Ordering by id instead is
    arbitrary with respect to who wins, and unlike a random coin it is stable
    across runs.
    """
    w = raw.winner_id.astype(str)
    l = raw.loser_id.astype(str)
    a_is_winner = w < l          # string compare is fine: it only needs to be a total order
    out = pd.DataFrame({
        "matchId": raw.matchId, "season": raw.season, "date": raw.date,
        "tournamentId": raw.tournamentId, "surface": raw.surface.fillna("unknown"),
        "drawSize": raw.drawSize, "roundId": raw.roundId, "bestOf": raw.bestOf,
        "retired": raw.retired,
        "player_a": np.where(a_is_winner, w, l),
        "player_b": np.where(a_is_winner, l, w),
        "a_name": np.where(a_is_winner, raw.winner, raw.loser),
        "b_name": np.where(a_is_winner, raw.loser, raw.winner),
        "a_seed": np.where(a_is_winner, raw.winner_seed, raw.loser_seed),
        "b_seed": np.where(a_is_winner, raw.loser_seed, raw.winner_seed),
        "a_won": a_is_winner.astype(int),
        "w_games": raw.w_games, "l_games": raw.l_games,
        "w_sets": raw.w_sets, "l_sets": raw.l_sets,
    })
    return out


if __name__ == "__main__":
    main()
