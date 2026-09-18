"""
A same-team correction that knows who hogs touchdowns.

WHERE THE COUNT ACTUALLY MATTERS
--------------------------------
multi_td.py established that training the RANKER on touchdown counts makes the
board worse: every variant lost top-1, monotonically in how much count
information went in, while gaining AUC. The card asks "who scores here", and
counts answer "who scores a lot".

But multi_td_corr.py found the counts mattering somewhere else entirely. For
ordered teammate pairs, conditioning only on the first player's count:

    A scored 0        B beat his stated probability by  0.982x
    A scored once     B came in at                      0.900x
    A scored twice+   B came in at                      0.778x

That is the goal line being a finite resource, measured cleanly — the
conditioning never touches B's outcome. And the board's same-team factor is a
single flat 0.826, which is the average of those cases applied to all of them.
It over-penalises a pair whose other leg is a low-rate receiver and
under-penalises one whose other leg is a goal-line back who will take two.

A's count is not known before kickoff. His expected count is: that is what a
Poisson on the same eighteen features estimates. So the correction can key on
the partner's expected touchdowns instead of ignoring him.

DISCIPLINE
----------
The relationship is fitted on 2021-24 and judged on 2025-26 — the flat 0.826
was itself measured on 2025-26, so comparing a curve fitted there against it
would be rigged in the curve's favour. The comparison is whether a same-team
pair's stated co-scoring probability lands closer to what happened.
"""
import os, json, itertools
import numpy as np
import pandas as pd
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

import bakeoff_nfl as B
from export_ranker import fit_bundle, predict

HERE = os.path.dirname(os.path.abspath(__file__))
FLAT = 0.8257863512612426  # what the board ships today


def teammate_pairs(d):
    """Every unordered same-team pair on a slate, with both legs' numbers."""
    rows = []
    for (gid, team), grp in d.groupby(["game_id", "team"]):
        g = list(grp.itertuples())
        if len(g) < 2:
            continue
        for a, b in itertools.combinations(g, 2):
            rows.append({
                "game_id": gid, "date": a.date,
                "p_a": a.p, "p_b": b.p, "lam_a": a.lam, "lam_b": b.lam,
                "both": int(a.scored) * int(b.scored),
                "pp": a.p * b.p,
            })
    return pd.DataFrame(rows)


def main():
    df = B.load()

    # --- fit everything on the training seasons only
    bundle = fit_bundle(df, B.TRAIN)
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    pois = PoissonRegressor(alpha=1e-3, max_iter=3000).fit(
        sc.transform(tr[B.FEATURES].values), tr.td_count.values
    )

    def frame(sub):
        f = sub[["game_id", "date", "team", "player_id", "scored", "td_count"]].copy()
        f["p"] = predict(bundle, sub[B.FEATURES].values)
        f["lam"] = np.clip(pois.predict(sc.transform(sub[B.FEATURES].values)), 1e-6, None)
        return f

    trf = frame(tr)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    tef = frame(te)

    ptr = teammate_pairs(trf)
    pte = teammate_pairs(tef)
    print(f"same-team pairs: {len(ptr):,} training, {len(pte):,} test\n")

    # --- how does the penalty vary with the PARTNER's expected count?
    # For a pair, the quantity that should matter is how much of the team's
    # scoring the two of them are jointly expected to absorb.
    print("--- training seasons: same-team ratio by the pair's combined expected TDs ---")
    ptr["lam_sum"] = ptr.lam_a + ptr.lam_b
    pte["lam_sum"] = pte.lam_a + pte.lam_b
    qs = pd.qcut(ptr.lam_sum, 5, duplicates="drop")
    print(f"{'lam_a+lam_b':>16} {'pairs':>7} {'both':>6} {'product':>9} {'ratio':>7}")
    pts = []
    for q, g in ptr.groupby(qs, observed=True):
        if g.pp.sum() <= 0:
            continue
        r = g.both.sum() / g.pp.sum()
        pts.append((g.lam_sum.mean(), r, len(g)))
        print(f"{str(q):>16} {len(g):>7,} {int(g.both.sum()):>6} {g.pp.sum():>9.1f} {r:>7.3f}")

    # --- fit a straight line in lam_sum, which is all this much data supports
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    ws = np.array([p[2] for p in pts], dtype=float)
    slope, intercept = np.polyfit(xs, ys, 1, w=ws)
    print(f"\n  fitted on training seasons: factor = {intercept:.4f} {slope:+.4f} * (lam_a+lam_b)")
    print(f"  (a flat factor is the same line with slope 0)")

    def keyed(lam_sum):
        return np.clip(intercept + slope * lam_sum, 0.3, 1.0)

    # --- judge on the test seasons: whose stated co-score is closer?
    print("\n--- test seasons: which correction states the truth better? ---")
    obs = pte.both.values
    base = pte.pp.values
    cands = {
        "no correction (1.000)": np.ones(len(pte)),
        f"flat {FLAT:.3f} (shipped)": np.full(len(pte), FLAT),
        "keyed to expected TDs": keyed(pte.lam_sum.values),
    }
    print(f"{'correction':<26} {'stated':>8} {'actual':>8} {'ratio':>7} {'logloss':>9} {'bucket err':>11}")
    out = {}
    for name, f in cands.items():
        pred = np.clip(base * f, 1e-9, 1 - 1e-9)
        ll = float(-np.mean(obs * np.log(pred) + (1 - obs) * np.log(1 - pred)))
        # calibration across expected-TD buckets: the failure a flat factor makes
        qq = pd.qcut(pte.lam_sum, 5, duplicates="drop")
        errs, wts = [], []
        for q, g in pd.DataFrame({"q": qq, "o": obs, "p": pred}).groupby("q", observed=True):
            errs.append(abs(g.o.mean() - g.p.mean())); wts.append(len(g))
        berr = float(np.average(errs, weights=wts))
        out[name] = {"stated": float(pred.mean()), "actual": float(obs.mean()),
                     "ratio": float(obs.mean() / pred.mean()), "logloss": ll,
                     "bucket_err": berr}
        print(f"{name:<26} {pred.mean()*100:>7.2f}% {obs.mean()*100:>7.2f}% "
              f"{obs.mean()/pred.mean():>7.3f} {ll:>9.5f} {berr*100:>10.3f}%")

    print("\n  'ratio' near 1.000 means the overall level is right; 'bucket err' is")
    print("  how wrong it is WITHIN a slice of expected-TD, which is exactly what")
    print("  a flat factor cannot fix and the whole reason to key it.")

    json.dump({"fit": {"intercept": float(intercept), "slope": float(slope)},
               "train_buckets": [{"lam_sum": float(a), "ratio": float(b), "pairs": int(c)}
                                 for a, b, c in pts],
               "test": out},
              open(os.path.join(HERE, "pair_count.json"), "w"), indent=1)
    print("\nwrote pair_count.json")


if __name__ == "__main__":
    main()


def control_check():
    """Was that even correlation?

    The keyed correction fitted a strong trend on the training seasons — the
    same-team ratio climbing from 0.548 to 0.937 across quintiles of combined
    expected touchdowns — and then lost to the flat factor on the test seasons,
    on every measure including the within-bucket one it was built to win.

    A trend that does not transfer is usually not the thing you named it. The
    suspicion here: combined expected touchdowns is nearly a restatement of the
    two legs' probabilities, so slicing on it is mostly slicing on p. If the
    model is miscalibrated at low p, `product` is wrong there for reasons that
    have nothing to do with two players sharing a team, and the ratio moves
    anyway.

    The test: run the identical slice over DIFFERENT-GAMES pairs, where there
    is no correlation to find by construction. If the control shows the same
    shape, the shape is calibration and keying on it corrects the wrong thing
    twice.
    """
    df = B.load()
    bundle = fit_bundle(df, B.TRAIN)
    tr = df[df.season.isin(B.TRAIN)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    pois = PoissonRegressor(alpha=1e-3, max_iter=3000).fit(
        sc.transform(tr[B.FEATURES].values), tr.td_count.values
    )
    f = tr[["game_id", "date", "team", "player_id", "scored"]].copy()
    f["p"] = predict(bundle, tr[B.FEATURES].values)
    f["lam"] = np.clip(pois.predict(sc.transform(tr[B.FEATURES].values)), 1e-6, None)

    rng = np.random.default_rng(3)
    same, diff = [], []
    for _, slate in f.groupby("date"):
        g = list(slate.itertuples())
        if len(g) < 4:
            continue
        # same-team pairs
        for (gid, team), grp in slate.groupby(["game_id", "team"]):
            t = list(grp.itertuples())
            for a, b in itertools.combinations(t, 2):
                same.append((a.lam + b.lam, a.p * b.p, int(a.scored) * int(b.scored)))
        # an equally sized sample of DIFFERENT-GAME pairs from the same slate
        idx = rng.integers(0, len(g), size=(min(len(g) * 4, 4000), 2))
        for i, j in idx:
            a, b = g[i], g[j]
            if a.game_id == b.game_id:
                continue
            diff.append((a.lam + b.lam, a.p * b.p, int(a.scored) * int(b.scored)))

    S = pd.DataFrame(same, columns=["lam_sum", "pp", "both"])
    D = pd.DataFrame(diff, columns=["lam_sum", "pp", "both"])
    # one set of edges for both, so the slices are comparable
    edges = np.quantile(S.lam_sum, np.linspace(0, 1, 6))
    edges[0], edges[-1] = -np.inf, np.inf

    print("\n--- the same slice, run over pairs that CANNOT be correlated ---")
    print(f"{'lam_a+lam_b':>18} {'same-team':>10} {'control':>9} {'same/ctrl':>10}")
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        s = S[(S.lam_sum > lo) & (S.lam_sum <= hi)]
        c = D[(D.lam_sum > lo) & (D.lam_sum <= hi)]
        if s.pp.sum() <= 0 or c.pp.sum() <= 0 or len(c) < 200:
            continue
        rs = s.both.sum() / s.pp.sum()
        rc = c.both.sum() / c.pp.sum()
        rows.append({"lo": float(lo), "hi": float(hi), "same": float(rs),
                     "control": float(rc), "rel": float(rs / rc)})
        lab = f"({lo:.2f}, {hi:.2f}]" if np.isfinite(lo) and np.isfinite(hi) else "tail"
        print(f"{lab:>18} {rs:>10.3f} {rc:>9.3f} {rs/rc:>10.3f}")
    rel = [r["rel"] for r in rows]
    print(f"\n  same-team ratio swings {min(r['same'] for r in rows):.3f}–"
          f"{max(r['same'] for r in rows):.3f} across the slices.")
    print(f"  the CONTROL swings {min(r['control'] for r in rows):.3f}–"
          f"{max(r['control'] for r in rows):.3f} — over pairs in different games.")
    print(f"  against the control the same-team penalty is {min(rel):.3f}–{max(rel):.3f},")
    print(f"  spread {max(rel) - min(rel):.3f} against {max(r['same'] for r in rows) - min(r['same'] for r in rows):.3f} raw.")
    json.dump(rows, open(os.path.join(HERE, "pair_count_control.json"), "w"), indent=1)
    print("  wrote pair_count_control.json")


if __name__ == "__main__":
    control_check()
