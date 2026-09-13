"""
Which features can the live board actually afford?

The backtest was built from box scores, where anything is computable. The live
board is not: it has ~10 seconds to price a 70-game Saturday, which rules out
refetching every box score in the season. Two features turn out to be the
expensive ones — `opp_rush_td_allowed_pg` and `opp_rec_td_allowed_pg` need every
opponent's box score, while everything else comes from one roster call per team
plus the season scoreboards the Elo replay already reads.

So: what do they actually buy? And can points-allowed-per-game, which is free
from the scoreboard, stand in for them?
"""
import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

import features as F
from final import board, TRAIN, TEST

df = pd.read_csv("data/features.csv")
EXPENSIVE = F.EXPENSIVE


def run(cols, label):
    tr = df[df.season.isin(TRAIN)]
    te = df[df.season.isin(TEST)]
    sc = StandardScaler().fit(tr[cols].values)
    lr = LogisticRegression(max_iter=2000).fit(sc.transform(tr[cols].values), tr.scored.values)
    p = lr.predict_proba(sc.transform(te[cols].values))[:, 1]
    auc = roc_auc_score(te.scored.values, p)
    b = board(te, p)
    per_game = b.groupby("game_id").scored.max().mean()
    print(f"  {label:<42} AUC {auc:.4f}  picks/game {len(b)/b.game_id.nunique():.2f}  "
          f"pick hit {b.scored.mean()*100:5.1f}%  game hit {per_game*100:5.1f}%")
    return {"label": label, "auc": float(auc), "pick_hit": float(b.scored.mean()),
            "game_hit": float(per_game), "picks_per_game": float(len(b) / b.game_id.nunique()),
            "features": cols}


out = []
out.append(run(F.ALL_FEATURES, "full (box-score features)"))
out.append(run([c for c in F.ALL_FEATURES if c not in EXPENSIVE], "without opponent TDs allowed"))
# proj_team_pts / proj_total already carry the defence's points allowed, so the
# swap-in is really a test of whether points-allowed says what TDs-allowed said.
out.append(run([c for c in F.ALL_FEATURES if c not in EXPENSIVE] + ["proj_total"],
               "without them, proj_total doubled"))
json.dump(out, open("ablation_metrics.json", "w"), indent=1)
print("\nwrote ablation_metrics.json")
