"""
The first-touchdown model, fitted and priced.

WHICH MODEL, AND WHY NOT THE ONE THAT TOPPED THE TABLE
-------------------------------------------------------
bakeoff_first.py put the Poisson rate on top at 16.3% against the L2 logistic's
15.6%. Not shipped, for two reasons and either would be enough:

  it is not winning     +0.7 points, 95% CI [-0.6, +2.1], and McNemar rests on
                        FOUR discordant games (p = 0.63). Nothing in the whole
                        field had an interval excluding zero.
  it cannot state a number   its calibration error is 0.164 on a 5% base rate.
                        It ranks plausibly and then claims percentages that are
                        wildly wrong. A board that prints a number on every leg
                        and multiplies five of them cannot ship that; the
                        logistic's error is 0.0028.

ONE LEG PER GAME, AND THIS TIME IT IS NOT A PREFERENCE
-------------------------------------------------------
On the anytime board, stacking two legs from one game is a priced choice — two
players can both score, so the slip is possible and just correlated. Here they
cannot. Exactly one player scores the game's first touchdown; verified across
1,424 games, no game has two. Two legs from one game is not a correlated slip,
it is an impossible one, and no multiplicative correction expresses that.

So maxPerGame is FORCED to 1 rather than defaulted, and the sizes are bounded by
how many games are on the slate. Five legs needs five games; ten needs ten,
which an NFL Sunday has and a Thursday does not.

THE CEILING. 5.3% of first touchdowns are scored by a defender or a returner,
and 0.7% of games have no touchdown at all — in those, no candidate the board
could ever name was eligible. Those games are kept in both training and
scoring, so the ceiling on per-game top-1 is 91.4% and every stated probability
already carries that drag. Deleting them would have flattered every number here.
"""
import os, json, itertools
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, log_loss, brier_score_loss

import bakeoff_nfl as B
import bakeoff_first as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "lib", "nfl-td1-model.json")
SIZES = [5, 10]
MAX_PER_GAME = 1          # structural, not a preference — see the docstring


def fit_bundle(df, seasons, shrink):
    tr = df[df.season.isin(seasons)].reset_index(drop=True)
    sc = StandardScaler().fit(tr[B.FEATURES].values)
    X, y = sc.transform(tr[B.FEATURES].values), tr.scored.values
    m = LogisticRegression(max_iter=3000, C=1.0).fit(X, y)
    return {"mean": sc.mean_, "std": sc.scale_, "w": m.coef_[0],
            "intercept": float(m.intercept_[0]), "base": float(y.mean()),
            "shrink": shrink}


def predict(b, raw):
    z = (raw - b["mean"]) / b["std"]
    p = 1 / (1 + np.exp(-(z @ b["w"] + b["intercept"])))
    lam = b["shrink"]
    return (1 - lam) * p + lam * b["base"]


def leg_stats(sub, p, y, per_slate=max(SIZES)):
    """The candidates a slip would actually take: the best `per_slate` on each
    slate, at most one per game, since two from one game cannot both hit."""
    d = pd.DataFrame({"date": sub.date.values, "game_id": sub.game_id.values,
                      "player_id": sub.player_id.values, "y": y, "p": p})
    d = d.sort_values("p", ascending=False).drop_duplicates(["date", "player_id"])
    keep = d.drop_duplicates(["date", "game_id"]).groupby("date").head(per_slate)
    return float(keep.p.mean()), float(keep.y.mean()), len(keep)


def pick_shrink(df):
    """Rolling origin inside the training seasons, zeroing the signed bias on
    the legs a slip takes. No sight of the test seasons."""
    grid = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
    gaps = {l: [] for l in grid}
    for fit_seasons, judge in [([2021], 2022), ([2021, 2022], 2023),
                               ([2021, 2022, 2023], 2024)]:
        b = fit_bundle(df, fit_seasons, 0.0)
        j = df[df.season == judge].reset_index(drop=True)
        z = (j[B.FEATURES].values - b["mean"]) / b["std"]
        p0 = 1 / (1 + np.exp(-(z @ b["w"] + b["intercept"])))
        for lam in grid:
            st, ac, _ = leg_stats(j, (1 - lam) * p0 + lam * b["base"], j.scored.values)
            gaps[lam].append(ac - st)
    best = min(grid, key=lambda l: abs(np.mean(gaps[l])))
    return best, {str(l): [float(x) for x in gaps[l]] for l in grid}


def main():
    df = F.load_first()
    shrink, gaps = pick_shrink(df)
    print(f"--- shrink by rolling origin inside 2021-24: {shrink:.2f} ---")
    for l in sorted(gaps, key=float):
        g = np.array(gaps[l])
        print(f"  {float(l):.2f}  per-season {['%+.1f' % (x*100) for x in g]}  "
              f"mean {g.mean()*100:+.2f}")

    ho = fit_bundle(df, B.TRAIN, shrink)
    te = df[df.season.isin(B.TEST)].reset_index(drop=True)
    yte = te.scored.values
    p_te = predict(ho, te[B.FEATURES].values)
    hits, _ = B.per_game_top1(te, p_te)
    d = te[["game_id", "date", "team", "player_id"]].copy()
    d["scored"], d["p"] = yte, p_te
    lead = d.loc[d.groupby("game_id").p.idxmax()]
    lst, lac, ln = leg_stats(te, p_te, yte)
    ceiling = te.groupby("game_id").scored.max().mean()

    print(f"\n--- held out (fit 2021-24, judged 2025-26) ---")
    print(f"  top-1 per game   {hits.mean()*100:.1f}%  ({int(hits.sum())}/{len(hits)})"
          f"   ceiling {ceiling*100:.1f}%, random {1/te.groupby('game_id').size().mean()*100:.1f}%")
    print(f"  lead picks       stated {lead.p.mean()*100:.1f}%  actual {lead.scored.mean()*100:.1f}%")
    print(f"  slip legs        stated {lst*100:.1f}%  actual {lac*100:.1f}%  (n={ln})")
    print(f"  auc {roc_auc_score(yte, p_te):.4f}  logloss {log_loss(yte, p_te):.4f}  "
          f"brier {brier_score_loss(yte, p_te):.4f}  ece {B.ece(yte, p_te):.4f}")
    print(f"  probability range {p_te.min():.3f} .. {p_te.max():.3f}")

    # --- the structural check, run rather than asserted
    same_game_both = 0
    for _, slate in d.groupby("date"):
        for gid, g in slate.groupby("game_id"):
            same_game_both += int(g.scored.sum() > 1)
    print(f"\n  games where two candidates both scored first: {same_game_both} "
          f"(must be 0 — one leg per game is enforced, not priced)")

    # ------------------------------------------------------------ parlays
    print("\n--- 5 and 10 leg slips, one leg per game, on the held-out seasons ---")
    print(f"{'size':>5} {'floor':>6} {'weeks':>6} {'stated':>9} {'1 in':>9} {'won':>4} {'expected':>9}")
    size_evidence, floors = {}, {}
    for size in SIZES:
        best_floor = 0.0
        for floor in [0.0, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]:
            weeks = filled = 0
            for _, slate in d.groupby("date"):
                if slate.game_id.nunique() < size:
                    continue
                weeks += 1
                s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
                s = s[s.p >= floor].drop_duplicates("game_id")
                filled += int(len(s) >= size)
            if weeks and filled / weeks >= 0.70:
                best_floor = floor
        floors[size] = best_floor

        slips, stated = [], []
        for _, slate in d.groupby("date"):
            s = slate.sort_values("p", ascending=False).drop_duplicates("player_id")
            s = s[s.p >= best_floor].drop_duplicates("game_id").head(size)
            if len(s) < size:
                continue
            # one leg per game means the legs are in different games, which is
            # the independence case — no correction to apply
            prob = float(np.prod(s.p.values))
            stated.append(prob)
            slips.append(int(s.scored.sum() == size))
        if not slips:
            size_evidence[size] = None
            print(f"{size:>5} {best_floor:>6.2f} {'0':>6}   never buildable")
            continue
        stv = float(np.mean(stated))
        size_evidence[size] = {"stated": stv, "oneIn": int(round(1 / stv)) if stv else 0,
                               "slips": len(slips), "won": int(sum(slips)),
                               "expected": stv * len(slips)}
        print(f"{size:>5} {best_floor:>6.2f} {len(slips):>6} {stv*100:>8.5f}% "
              f"{1/stv if stv else 0:>9,.0f} {sum(slips):>4} {stv*len(slips):>9.4f}")

    # ------------------------------------------------------------- deploy
    full = fit_bundle(df, B.TRAIN + B.TEST, shrink)
    raw = df[B.FEATURES].values
    p_all = predict(full, raw)
    idx = [0, len(df) // 2, len(df) - 1]
    art = {
        "market": "td1",
        "features": B.FEATURES,
        "mean": [float(v) for v in full["mean"]],
        "std": [float(v) for v in full["std"]],
        "w": [float(v) for v in full["w"]],
        "intercept": full["intercept"],
        "shrink": shrink, "base": full["base"],
        "maxPerGame": MAX_PER_GAME,
        "notes": ("first touchdown of the game; L2 logistic on the shipped 18 "
                  "features, P = shrink(sigmoid(w.z + b)). One leg per game is "
                  "structural: exactly one player scores first."),
        "selftest": [{"x": [float(v) for v in raw[i]], "p": float(p_all[i])} for i in idx],
        "heldout": {"top1": float(hits.mean()), "games": int(len(hits)),
                    "ceiling": float(ceiling),
                    "lead_stated": float(lead.p.mean()),
                    "lead_actual": float(lead.scored.mean()),
                    "leg_stated": lst, "leg_actual": lac,
                    "auc": float(roc_auc_score(yte, p_te)),
                    "logloss": float(log_loss(yte, p_te)),
                    "brier": float(brier_score_loss(yte, p_te)),
                    "ece": float(B.ece(yte, p_te)),
                    "base_rate": float(yte.mean())},
        "floors": {str(k): v for k, v in floors.items()},
        "sizes": SIZES,
        "size_evidence": {str(k): v for k, v in size_evidence.items()},
    }
    json.dump(art, open(OUT, "w"), indent=1)
    print(f"\nwrote {os.path.relpath(OUT, os.path.join(HERE, '..', '..'))}")


if __name__ == "__main__":
    main()
