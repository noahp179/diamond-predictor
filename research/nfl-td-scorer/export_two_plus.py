"""
The 2+ touchdown model, fitted and priced honestly.

WHAT THIS MARKET IS
-------------------
Two or more touchdowns by one player in one game. It happens to 3.7% of the
candidates on a board — about one row in 27 — against 21.4% for anytime.

MULTI-TD.md measured the shape of it before building anything, and the shape is
unusual: the model ranks this market BETTER than it ranks anytime (AUC 0.79
against 0.68), because multi-touchdown games concentrate in an identifiable
type — the workhorse back who takes the goal-line carries in a game his team
wins comfortably. But ranking well and being likely are different properties.
The best candidate in a game converts about one time in seven.

So this ships at five and ten legs only, and the card states the real numbers
rather than flattering them.

WHICH MODEL
-----------
The anytime board runs a within-game pairwise ranker because the card asks a
within-game question, and the same argument applies here. Both are fitted and
compared on top-1 rather than assumed.

CALIBRATION is the part that matters most in a rare market. A model that
overstates a 14% pick as 25% compounds catastrophically over ten legs — a
ten-leg slip is the tenth power of the error. Platt on a held-back tail of the
training seasons, then the same rolling-origin shrink selection the anytime
board uses, on the same criterion: zero the signed bias on the picks the board
actually publishes.
"""
import os, json, itertools
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import bakeoff_nfl as B
from rank_study import fit_ranker

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "nfl-td2-model.json")
SEEDS = list(range(20))
SIZES = [5, 10]
CORR_FLOOR = 0.10   # the range a 2+ board actually draws from
MAX_PER_GAME = 2


def label(df):
    return (df.td_count >= 2).astype(int).values


def fit_ranker_bundle(df, seasons, y_of, shrink):
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    X, y, g = sc.transform(tr[B.FEATURES].values), y_of(tr), tr.game_id.values
    W = np.mean([fit_ranker(X, y, g, s)[0] for s in SEEDS], axis=0)
    cut = int(len(tr) * 0.80)
    m_fit = np.arange(len(tr)) < cut
    Wc = np.mean([fit_ranker(X[m_fit], y[m_fit], g[m_fit], s)[0] for s in SEEDS], axis=0)
    pl = LogisticRegression(max_iter=2000).fit((X[~m_fit] @ Wc).reshape(-1, 1), y[~m_fit])
    return {"kind": "rank", "mean": sc.mean_, "std": sc.scale_, "w": W,
            "a": float(pl.coef_[0][0]), "b": float(pl.intercept_[0]),
            "base": float(y.mean()), "shrink": shrink}


def fit_logit_bundle(df, seasons, y_of, shrink):
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    X, y = sc.transform(tr[B.FEATURES].values), y_of(tr)
    m = LogisticRegression(max_iter=3000, C=1.0).fit(X, y)
    return {"kind": "logit", "mean": sc.mean_, "std": sc.scale_,
            "w": m.coef_[0], "intercept": float(m.intercept_[0]),
            "a": 1.0, "b": 0.0, "base": float(y.mean()), "shrink": shrink}


def predict(bundle, raw):
    z = (raw - bundle["mean"]) / bundle["std"]
    s = z @ bundle["w"]
    if bundle["kind"] == "logit":
        s = s + bundle["intercept"]
    p = 1 / (1 + np.exp(-(bundle["a"] * s + bundle["b"])))
    lam = bundle["shrink"]
    return (1 - lam) * p + lam * bundle["base"]


def lead_stats(sub, p, y):
    d = pd.DataFrame({"game_id": sub.game_id.values, "y": y, "p": p})
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    return float(lead.p.mean()), float(lead.y.mean()), len(lead)


def leg_stats(sub, p, y, per_slate=max(SIZES)):
    """The population a SLIP actually draws from: the best `per_slate`
    candidates on each slate, one row per player.

    This is the criterion the shrink is chosen on, and it is deliberately not
    the lead-pick criterion the anytime board uses. That board publishes one
    pick per game, so the leads are what it must get right. This model exists
    only to fill five- and ten-leg slips, so the legs are what it must get
    right — and the two populations are not the same. A lead-pick average is
    dragged down by games whose best 2+ candidate is a 4% long shot and no slip
    would ever take; tuning on it left the top of the range understated by 18%
    per leg, which compounds to 2.3x over five."""
    d = pd.DataFrame({"date": sub.date.values, "player_id": sub.player_id.values,
                      "y": y, "p": p})
    legs = (d.sort_values("p", ascending=False)
             .drop_duplicates(["date", "player_id"])
             .groupby("date").head(per_slate))
    return float(legs.p.mean()), float(legs.y.mean()), len(legs)


def pick_shrink(df, y_of, fitter):
    """Rolling origin inside the training seasons, on the signed bias of the
    picks the board publishes — the same criterion the anytime board used, and
    chosen without any sight of the test seasons."""
    splits = [([2021], 2022), ([2021, 2022], 2023), ([2021, 2022, 2023], 2024)]
    grid = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40]
    gaps = {l: [] for l in grid}
    for fit_seasons, judge in splits:
        bundle = fitter(df, fit_seasons, y_of, 0.0)
        j = df[df.season == judge].reset_index(drop=True)
        raw = j[B.FEATURES].values
        yj = y_of(j)
        base = bundle["base"]
        z = (raw - bundle["mean"]) / bundle["std"]
        s = z @ bundle["w"] + (bundle.get("intercept", 0.0) if bundle["kind"] == "logit" else 0.0)
        p0 = 1 / (1 + np.exp(-(bundle["a"] * s + bundle["b"])))
        for lam in grid:
            st, ac, _ = leg_stats(j, (1 - lam) * p0 + lam * base, yj)
            gaps[lam].append(ac - st)
    best = min(grid, key=lambda l: abs(np.mean(gaps[l])))
    return best, {str(l): [float(x) for x in gaps[l]] for l in grid}


def main():
    df = B.load()
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    yte = label(te)
    ytr = label(df[df.season.isin(B.TRAIN)].reset_index(drop=True))
    print(f"2+ TD base rate: train {ytr.mean()*100:.2f}%, test {yte.mean()*100:.2f}%\n")

    # ------------------------------------------------ which formulation wins
    print("--- ranker vs logistic on the 2+ question (fit 2021-24, judge 2025-26) ---")
    print(f"{'model':<12} {'top1':>7} {'auc':>8} {'logloss':>9} {'lead stated':>12} {'lead actual':>12}")
    cands = {}
    for name, fitter in (("ranker", fit_ranker_bundle), ("logistic", fit_logit_bundle)):
        b0 = fitter(df, B.TRAIN, label, 0.0)
        p = predict(b0, te[B.FEATURES].values)
        hits, _ = B.per_game_top1(te.assign(scored=yte), p)
        st, ac, n = lead_stats(te, p, yte)
        cands[name] = {"top1": float(hits.mean()), "auc": float(roc_auc_score(yte, p))}
        print(f"{name:<12} {hits.mean()*100:>6.1f}% {roc_auc_score(yte,p):>8.4f} "
              f"{log_loss(yte,p):>9.4f} {st*100:>11.1f}% {ac*100:>11.1f}%")
    winner = max(cands, key=lambda k: cands[k]["top1"])
    fitter = fit_ranker_bundle if winner == "ranker" else fit_logit_bundle
    print(f"\n  -> {winner} on top-1")

    # ------------------------------------------------------------- shrink
    shrink, gaps = pick_shrink(df, label, fitter)
    print(f"\n--- shrink chosen by rolling origin inside 2021-24: {shrink:.2f} ---")
    for l in sorted(gaps, key=float):
        g = np.array(gaps[l])
        print(f"  {float(l):.2f}  per-season gap {['%+.1f' % (x*100) for x in g]}  "
              f"mean {g.mean()*100:+.2f}")

    # --------------------------------------------- held-out, with the shrink
    ho = fitter(df, B.TRAIN, label, shrink)
    p_te = predict(ho, te[B.FEATURES].values)
    hits, _ = B.per_game_top1(te.assign(scored=yte), p_te)
    st, ac, n = lead_stats(te, p_te, yte)
    lst, lac, ln = leg_stats(te, p_te, yte)
    print(f"\n--- held out (fit 2021-24, judged 2025-26) ---")
    print(f"  top-1 per game   {hits.mean()*100:.1f}%  ({int(hits.sum())}/{len(hits)})")
    print(f"  lead picks       stated {st*100:.1f}%  actual {ac*100:.1f}%  (n={n})")
    print(f"  SLIP LEGS        stated {lst*100:.1f}%  actual {lac*100:.1f}%  (n={ln}) "
          f"-> a 5-leg slip is off by x{(lac/lst)**5:.2f}")
    print(f"  auc {roc_auc_score(yte, p_te):.4f}  logloss {log_loss(yte, p_te):.4f}  "
          f"brier {brier_score_loss(yte, p_te):.4f}  ece {B.ece(yte, p_te):.4f}")
    print(f"  probability range {p_te.min():.3f} .. {p_te.max():.3f}")

    # ------------------------------------------------------- correlation
    d = te[["game_id", "date", "team", "player_id"]].copy()
    d["scored"] = yte
    d["p"] = p_te
    print(f"\n--- per-pair correlation on the 2+ market, p>={CORR_FLOOR} ---")
    cand = d[d.p >= CORR_FLOOR]
    buckets = {k: {"n": 0, "both": 0, "product": 0.0} for k in ("same_team", "same_game", "diff")}
    for _, slate in cand.groupby("date"):
        s = slate.sort_values("p", ascending=False).drop_duplicates("player_id").head(40)
        for a, b in itertools.combinations(list(s.itertuples()), 2):
            k = ("same_team" if a.team == b.team
                 else "same_game" if a.game_id == b.game_id else "diff")
            bk = buckets[k]
            bk["n"] += 1
            bk["both"] += int(a.scored) * int(b.scored)
            bk["product"] += a.p * b.p
    print(f"{'pair type':>26} {'pairs':>8} {'both':>6} {'product':>9} {'ratio':>7}")
    ratios = {}
    for k, lab in (("same_team", "same team"), ("same_game", "same game, opposed"),
                   ("diff", "different games (control)")):
        bk = buckets[k]
        if not bk["n"] or bk["product"] <= 0:
            continue
        r = bk["both"] / bk["product"]
        ratios[k] = r
        print(f"{lab:>26} {bk['n']:>8,} {bk['both']:>6} {bk['product']:>9.2f} {r:>7.3f}")
    ctrl = ratios.get("diff", 1.0)
    pair_factor = {"sameTeam": ratios.get("same_team", ctrl) / ctrl,
                   "opposed": ratios.get("same_game", ctrl) / ctrl}
    # A rare market gives the estimator very little to work with; a factor read
    # off a handful of co-scoring pairs is noise dressed as a measurement.
    thin = buckets["same_team"]["both"] < 10 or buckets["same_game"]["both"] < 10
    if thin:
        print("\n  too few co-scoring pairs to estimate a correction from — a 2+ board")
        print("  sees a handful of them in two seasons. Falling back to the anytime")
        print("  board's factors, which are measured on 100x the pairs and describe")
        print("  the same underlying mechanism (a finite goal line, a shared game).")
        pair_factor = {"sameTeam": 0.826, "opposed": 0.883}
    else:
        print(f"\n  against the control: sameTeam {pair_factor['sameTeam']:.3f}  "
              f"opposed {pair_factor['opposed']:.3f}")

    # ------------------------------------------------------------ parlays
    print("\n--- 5 and 10 leg slips on the held-out seasons ---")
    print(f"{'size':>5} {'floor':>6} {'weeks':>6} {'stated':>9} {'1 in':>10} {'won':>4} {'expected':>9}")
    size_evidence, floors = {}, {}
    for size in SIZES:
        # pick the highest floor that still fills 70% of weeks with enough games
        best_floor, best_rows = 0.02, None
        for floor in [0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25]:
            filled = 0
            need = int(np.ceil(size / MAX_PER_GAME))
            weeks = 0
            for _, slate in d.groupby("date"):
                if slate.game_id.nunique() < need:
                    continue
                weeks += 1
                s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
                s = s[s.p >= floor]
                per, keep = {}, 0
                for r in s.itertuples():
                    if per.get(r.game_id, 0) >= MAX_PER_GAME:
                        continue
                    per[r.game_id] = per.get(r.game_id, 0) + 1
                    keep += 1
                    if keep == size:
                        break
                filled += int(keep == size)
            if weeks and filled / weeks >= 0.70:
                best_floor = floor
        floors[size] = best_floor

        slips, stated = [], []
        for _, slate in d.groupby("date"):
            s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
            s = s[s.p >= best_floor]
            per, keep = {}, []
            for r in s.itertuples():
                if per.get(r.game_id, 0) >= MAX_PER_GAME:
                    continue
                per[r.game_id] = per.get(r.game_id, 0) + 1
                keep.append(r)
                if len(keep) == size:
                    break
            if len(keep) < size:
                continue
            st_pairs = sum(1 for a, b in itertools.combinations(keep, 2)
                           if a.game_id == b.game_id and a.team == b.team)
            op_pairs = sum(1 for a, b in itertools.combinations(keep, 2)
                           if a.game_id == b.game_id and a.team != b.team)
            prob = float(np.prod([r.p for r in keep]))
            prob *= pair_factor["sameTeam"] ** st_pairs * pair_factor["opposed"] ** op_pairs
            stated.append(prob)
            slips.append(int(all(r.scored for r in keep)))
        if not slips:
            size_evidence[size] = None
            print(f"{size:>5} {best_floor:>6.2f} {'0':>6}   never buildable")
            continue
        stv = float(np.mean(stated))
        size_evidence[size] = {"stated": stv, "oneIn": int(round(1 / stv)) if stv else 0,
                               "slips": len(slips), "won": int(sum(slips)),
                               "expected": stv * len(slips)}
        print(f"{size:>5} {best_floor:>6.2f} {len(slips):>6} {stv*100:>8.4f}% "
              f"{1/stv if stv else 0:>10,.0f} {sum(slips):>4} {stv*len(slips):>9.3f}")

    # ------------------------------------------------------------- deploy
    full = fitter(df, B.TRAIN + B.TEST, label, shrink)
    raw = df[B.FEATURES].values
    p_all = predict(full, raw)
    idx = [0, len(df) // 2, len(df) - 1]
    art = {
        "market": "td2",
        "features": B.FEATURES,
        "kind": full["kind"],
        "mean": [float(v) for v in full["mean"]],
        "std": [float(v) for v in full["std"]],
        "w": [float(v) for v in full["w"]],
        "intercept": float(full.get("intercept", 0.0)),
        "platt_a": full["a"], "platt_b": full["b"],
        "shrink": shrink, "base": full["base"],
        "notes": (f"2+ touchdowns; {full['kind']} on the shipped 18 features, "
                  "P = shrink(platt(score))."),
        "selftest": [{"x": [float(v) for v in raw[i]], "p": float(p_all[i])} for i in idx],
        "heldout": {"top1": float(hits.mean()), "games": int(len(hits)),
                    "lead_stated": st, "lead_actual": ac,
                    "leg_stated": lst, "leg_actual": lac,
                    "auc": float(roc_auc_score(yte, p_te)),
                    "logloss": float(log_loss(yte, p_te)),
                    "brier": float(brier_score_loss(yte, p_te)),
                    "ece": float(B.ece(yte, p_te)),
                    "base_rate": float(yte.mean())},
        "pair_factor": pair_factor,
        "pair_borrowed": bool(thin),
        "floors": {str(k): v for k, v in floors.items()},
        "sizes": SIZES,
        "size_evidence": {str(k): v for k, v in size_evidence.items()},
    }
    json.dump(art, open(OUT, "w"), indent=1)
    print(f"\nwrote {os.path.relpath(OUT, os.path.join(HERE, '..', '..'))}")


if __name__ == "__main__":
    main()
