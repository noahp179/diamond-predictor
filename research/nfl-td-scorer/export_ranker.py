"""
Fit the shipped NFL model and refit every downstream constant in one pass.

The board carries more than a weight vector. It carries a calibration, a claim
about what a five-leg slip is worth, a per-pair correlation correction, and a
selection floor — and every one of those was measured against the LOGISTIC. If
only the weights are swapped, the card keeps quoting numbers that describe a
model no longer running. So everything downstream is re-measured here, against
the model actually being deployed, and written out together.

WHAT SHIPS
  weights     seed-averaged over 20 pair samples. No single sample is
              privileged, and averaging removes the 0.5-point seed jitter.
  platt       fitted on a held-back tail of the training seasons the ranker
              never saw. Monotone, so it cannot reorder a card.
  shrink      0.20, selected by rolling-origin inside the training seasons
              (shrink_pick.py) to zero the signed lead-pick bias. Also
              monotone; it changes what the board CLAIMS, never what it picks.

The deployed weights are fitted on ALL seasons including the test ones — but
every number reported alongside them comes from the 2021-24 fit evaluated on
2025-26, so nothing quoted has seen its own answer.
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
OUT = os.path.join(HERE, "..", "..", "src", "lib", "nfl-td-ranker.json")
SEEDS = list(range(20))
SHRINK = 0.20
CORR_FLOOR = 0.30  # the range NFL slips actually draw from
PARLAY_SIZES = [5, 10, 15, 20]
# Re-derived for THIS model's probability scale by floor_pick.py on the
# training seasons. The logistic's 0.55/0.45 floors describe a scale the
# shrunk ranker does not reach, and carrying them over silently emptied
# the board at fifteen and twenty legs.
SIZE_FLOOR = {5: 0.45, 10: 0.40, 15: 0.35, 20: 0.30}


def fit_bundle(df, seasons):
    """Everything a deployment needs, fitted on `seasons` alone."""
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    X, y, g = sc.transform(tr[B.FEATURES].values), tr.scored.values, tr.game_id.values
    W = np.mean([fit_ranker(X, y, g, s)[0] for s in SEEDS], axis=0)
    # Platt on a held-back tail the ranker inside it never saw
    cut = int(len(tr) * 0.80)
    m_fit = np.arange(len(tr)) < cut
    Wc = np.mean([fit_ranker(X[m_fit], y[m_fit], g[m_fit], s)[0] for s in SEEDS], axis=0)
    pl = LogisticRegression(max_iter=2000).fit((X[~m_fit] @ Wc).reshape(-1, 1), y[~m_fit])
    return {
        "mean": sc.mean_, "std": sc.scale_, "w": W,
        "a": float(pl.coef_[0][0]), "b": float(pl.intercept_[0]),
        "base": float(y.mean()),
    }


def predict(bundle, raw):
    z = (raw - bundle["mean"]) / bundle["std"]
    s = z @ bundle["w"]
    p = 1 / (1 + np.exp(-(bundle["a"] * s + bundle["b"])))
    return (1 - SHRINK) * p + SHRINK * bundle["base"]


def main():
    df = B.load()

    # ---------------------------------------------------------------- honest
    # Held-out evaluation: fitted on 2021-24, every number below judged on
    # 2025-26, which that fit never saw.
    ho = fit_bundle(df, B.TRAIN)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    p_te = predict(ho, te[B.FEATURES].values)
    yte = te.scored.values
    hits, _ = B.per_game_top1(te, p_te)
    d = te[["game_id", "date", "team", "player_id", "scored"]].copy()
    d["p"] = p_te
    lead = d.loc[d.groupby("game_id").p.idxmax()]

    print("--- held-out (fit 2021-24, judged 2025-26) ---")
    print(f"  top-1 per game   {hits.mean()*100:.1f}%  ({hits.sum()}/{len(hits)})")
    print(f"  lead picks       stated {lead.p.mean()*100:.1f}%  "
          f"actual {lead.scored.mean()*100:.1f}%")
    print(f"  auc {roc_auc_score(yte, p_te):.4f}  logloss {log_loss(yte, p_te):.4f}  "
          f"brier {brier_score_loss(yte, p_te):.4f}  ece {B.ece(yte, p_te):.4f}")

    # ------------------------------------------------------- correlation
    # For every pair the board might plausibly put on one slip, compare how
    # often BOTH scored against the product of their two stated probabilities.
    # The different-games bucket is the control: if independence is priced
    # right, its ratio is 1.0, and only then do the other two mean anything.
    print(f"\n--- per-pair correlation, NFL, p>={CORR_FLOOR} ---")
    cand = d[d.p >= CORR_FLOOR]
    buckets = {k: {"n": 0, "both": 0, "product": 0.0}
               for k in ("same_team", "same_game", "diff")}
    for _, slate in cand.groupby("date"):
        s = slate.sort_values("p", ascending=False).drop_duplicates("player_id").head(40)
        for a, b in itertools.combinations(list(s.itertuples()), 2):
            k = ("same_team" if a.team == b.team
                 else "same_game" if a.game_id == b.game_id else "diff")
            bk = buckets[k]
            bk["n"] += 1
            bk["both"] += int(a.scored) * int(b.scored)
            bk["product"] += a.p * b.p
    print(f"{'pair type':>22} {'pairs':>9} {'both':>7} {'product':>9} {'ratio':>7}")
    ratios = {}
    for k, label in (("same_team", "same team"),
                     ("same_game", "same game, opposed"),
                     ("diff", "different games (control)")):
        bk = buckets[k]
        if not bk["n"]:
            continue
        r = bk["both"] / bk["product"] if bk["product"] else float("nan")
        ratios[k] = r
        print(f"{label:>22} {bk['n']:>9,} {bk['both']:>7} {bk['product']:>9.1f} {r:>7.3f}")
    ctrl = ratios.get("diff", 1.0)
    pair_factor = {"sameTeam": ratios.get("same_team", ctrl) / ctrl,
                   "opposed": ratios.get("same_game", ctrl) / ctrl}
    print(f"\n  against the control: sameTeam {pair_factor['sameTeam']:.3f}  "
          f"opposed {pair_factor['opposed']:.3f}")

    # ------------------------------------------------------------- parlay
    # What a slip of each size is actually worth, built the way the board
    # builds one: best per game, up to two per game, floor by size.
    print("\n--- parlay backtest on the held-out seasons ---")
    print(f"{'size':>5} {'weeks filled':>13} {'stated':>9} {'1 in':>8} {'won':>5} "
          f"{'expected':>9}")
    size_evidence = {}
    for size in PARLAY_SIZES:
        floor = SIZE_FLOOR[size]
        slips, stated = [], []
        for _, slate in d.groupby("date"):
            s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
            s = s[s.p >= floor]
            # at most two legs from any one game, best first
            keep, per_game = [], {}
            for r in s.itertuples():
                if per_game.get(r.game_id, 0) >= 2:
                    continue
                per_game[r.game_id] = per_game.get(r.game_id, 0) + 1
                keep.append(r)
                if len(keep) == size:
                    break
            if len(keep) < size:
                continue
            same_team = sum(1 for a, b in itertools.combinations(keep, 2)
                            if a.game_id == b.game_id and a.team == b.team)
            opposed = sum(1 for a, b in itertools.combinations(keep, 2)
                          if a.game_id == b.game_id and a.team != b.team)
            prob = float(np.prod([r.p for r in keep]))
            prob *= pair_factor["sameTeam"] ** same_team * pair_factor["opposed"] ** opposed
            stated.append(prob)
            slips.append(int(all(r.scored for r in keep)))
        if not slips:
            print(f"{size:>5} {'0':>13}   never buildable")
            size_evidence[size] = None
            continue
        st = float(np.mean(stated))
        exp = st * len(slips)
        print(f"{size:>5} {len(slips):>13} {st*100:>8.3f}% {1/st if st else 0:>8.0f} "
              f"{sum(slips):>5} {exp:>9.2f}")
        size_evidence[size] = {
            "stated": st, "oneIn": int(round(1 / st)) if st else 0,
            "slips": len(slips), "won": int(sum(slips)), "expected": exp,
        }

    # ------------------------------------------------------------- deploy
    # The shipped fit uses every season. Judged numbers above come from the
    # 2021-24 fit; these weights are what the board will actually run.
    full = fit_bundle(df, B.TRAIN + B.TEST)
    raw = df[B.FEATURES].values
    p_all = predict(full, raw)

    # three self-test vectors for the TypeScript port to reproduce exactly
    idx = [0, len(df) // 2, len(df) - 1]
    selftest = [{"x": [float(v) for v in raw[i]], "p": float(p_all[i])} for i in idx]

    art = {
        "features": B.FEATURES,
        "mean": [float(v) for v in full["mean"]],
        "std": [float(v) for v in full["std"]],
        "w": [float(v) for v in full["w"]],
        "platt_a": full["a"], "platt_b": full["b"],
        "shrink": SHRINK, "base": full["base"],
        "constants": json.load(open(os.path.join(HERE, "td-model.json")))["constants"],
        "notes": ("within-game pairwise ranker, seed-averaged over 20 pair samples; "
                  "s = w.z on standardised features, P = shrink(platt(s)). "
                  "No intercept: the fit is on within-game feature differences."),
        "selftest": selftest,
        "heldout": {
            "top1": float(hits.mean()), "games": int(len(hits)),
            "lead_stated": float(lead.p.mean()), "lead_actual": float(lead.scored.mean()),
            "auc": float(roc_auc_score(yte, p_te)),
            "logloss": float(log_loss(yte, p_te)),
            "brier": float(brier_score_loss(yte, p_te)),
            "ece": float(B.ece(yte, p_te)),
        },
        "pair_factor": pair_factor,
        "pair_control": ctrl,
        "size_evidence": {str(k): v for k, v in size_evidence.items()},
    }
    json.dump(art, open(OUT, "w"), indent=1)
    print(f"\nwrote {os.path.relpath(OUT, os.path.join(HERE, '..', '..'))}")
    print("\n--- shipped weights (standardised units) ---")
    for f, w in sorted(zip(B.FEATURES, full["w"]), key=lambda t: -abs(t[1])):
        print(f"  {f:<26} {w:>+7.4f}")
    print(f"\n  platt a={full['a']:.5f} b={full['b']:.5f}  shrink={SHRINK}  "
          f"base={full['base']:.5f}")


if __name__ == "__main__":
    main()
