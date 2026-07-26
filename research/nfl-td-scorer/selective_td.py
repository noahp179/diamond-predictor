"""
Selective conviction for the TD-scorer picks — the NFL analog of the MLB
confidence-tier finding (MLB-GAME-OUTCOME-BAKEOFF.md, priority 2).

The shipped model (logistic + market) is already proven optimal for ranking.
The open product question is different: *of the picks we actually surface, what
share score?* This measures precision at every likelihood / confidence cut so
the TD Scorers page can lead with tiers that mean something.
"""
import os, warnings
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.isotonic import IsotonicRegression

import market as mk, bakeoff as bo

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
FE = bo.FEATURES + mk.MKT


def confidence(g):
    """Mirrors confidenceFor() in src/lib/nfl-td.server.ts exactly.
    Rank 1 is graded on its gap over the runner-up; every other pick is graded
    on its gap under the leader (which clamps its separation term to 0)."""
    p = g["p"].values
    p1 = p[0]
    p2 = p[1] if len(p) > 1 else 0.0
    out = []
    for i, r in enumerate(g.itertuples()):
        ref = p2 if i == 0 else p1
        sep = min(1.0, max(0.0, (r.p - ref) / (r.p + 1e-9) / 0.5))
        mat = min(1.0, r.games_hist / 6)
        vol = min(1.0, r.proj_touches / 18)
        out.append(round(100 * (0.45 * sep + 0.30 * mat + 0.25 * vol)))
    return out


def main():
    f = mk.merged_with_market()
    tr = f[f.season.isin([2021, 2022, 2023])]
    te = f[f.season == 2024].copy()
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)).fit(tr[FE], tr.scored)
    iso = IsotonicRegression(out_of_bounds="clip").fit(
        model.predict_proba(tr[FE])[:, 1], tr.scored.values)
    te["p"] = iso.transform(model.predict_proba(te[FE])[:, 1])

    # per-game ranking + confidence, exactly as the app does it
    parts = []
    for gid, g in te.groupby("game_id"):
        g = g.sort_values("p", ascending=False).reset_index(drop=True)
        g["rank"] = np.arange(1, len(g) + 1)
        g["conf"] = confidence(g)
        parts.append(g)
    te = pd.concat(parts, ignore_index=True)
    ngames = te.game_id.nunique()
    print(f"2024 test season: {ngames} games, {len(te):,} ranked players\n")

    # ---- precision of surfaced picks, by likelihood cut ----
    print("[Precision] of the picks we SURFACE (top-3 per game), what share score?")
    print(f"  {'likelihood >=':>14} {'picks':>7} {'per game':>9} {'HIT RATE':>10}")
    top3 = te[te["rank"] <= 3]
    for t in (0.00, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50):
        s = top3[top3.p >= t]
        if len(s) >= 40:
            print(f"  {t:>13.0%} {len(s):>7d} {len(s)/ngames:>9.1f} {s.scored.mean():>10.1%}")

    # ---- top-1 pick: hit rate by confidence tier ----
    print("\n[Top-1 pick] hit rate by CONFIDENCE tier (coverage = share of games shown)")
    print(f"  {'confidence':>12} {'games':>7} {'coverage':>9} {'HIT RATE':>10}")
    t1 = te[te["rank"] == 1]
    for lo, hi, lab in [(0, 45, "0-45"), (45, 60, "45-60"), (60, 75, "60-75"), (75, 101, "75+")]:
        s = t1[(t1.conf >= lo) & (t1.conf < hi)]
        if len(s) >= 20:
            print(f"  {lab:>12} {len(s):>7d} {len(s)/ngames:>9.1%} {s.scored.mean():>10.1%}")

    print("\n[Top-1 pick] hit rate by confidence THRESHOLD (what a filter would give)")
    print(f"  {'conf >=':>9} {'games':>7} {'coverage':>9} {'HIT RATE':>10}")
    for c in (0, 45, 55, 60, 65, 70, 75, 80):
        s = t1[t1.conf >= c]
        if len(s) >= 20:
            print(f"  {c:>9d} {len(s):>7d} {len(s)/ngames:>9.1%} {s.scored.mean():>10.1%}")

    # ---- combined: high likelihood AND high confidence ----
    print("\n[Both filters] likelihood AND confidence (top-1 picks)")
    print(f"  {'p>=':>6} {'conf>=':>7} {'games':>7} {'coverage':>9} {'HIT RATE':>10}")
    for pt in (0.35, 0.40, 0.45):
        for c in (60, 70):
            s = t1[(t1.p >= pt) & (t1.conf >= c)]
            if len(s) >= 25:
                print(f"  {pt:>6.0%} {c:>7d} {len(s):>7d} {len(s)/ngames:>9.1%} {s.scored.mean():>10.1%}")


if __name__ == "__main__":
    main()
