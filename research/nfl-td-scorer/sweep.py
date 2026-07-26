"""Validation sweep on 2022 only (state still built from 2021).
Used to pick round, non-overfit structural constants BEFORE the 2023-24 test."""
import numpy as np
import model, backtest as bt

GRID = [
    # (MATCHUP_POW, SHARE_POW, K_RUSH, K_REC)
    (1.0, 1.0, 45, 45),   # original
    (1.0, 1.0, 25, 30),
    (0.7, 1.0, 25, 30),
    (0.7, 0.85, 25, 30),
    (0.7, 0.85, 20, 25),
    (0.5, 0.85, 25, 30),
    (0.7, 0.75, 25, 30),
]

print(f"{'MPOW':>4} {'SPOW':>4} {'Kr':>3} {'Kt':>3} | {'Brier':>6} {'AUC':>5} {'ECE':>5} "
      f"{'top1':>5} {'top2':>5} {'vol1':>5} {'lift':>5}")
for mp, sp, kr, kt in GRID:
    model.MATCHUP_POW, model.SHARE_POW = mp, sp
    model.K_RUSH, model.K_REC = float(kr), float(kt)
    rec, games = bt.run(score_seasons={2022}, do_report=False, verbose=False)
    y, p = rec.scored.values, rec.p_td.values
    _, ece = bt.calibration(y, p)
    t1, t2, vol = games.top1_hit.mean(), games.top2_hit.mean(), games.vol_top1_hit.mean()
    print(f"{mp:>4} {sp:>4} {kr:>3} {kt:>3} | {bt.brier(y,p):>6.4f} {bt.auc(y,p):>5.3f} "
          f"{ece:>5.3f} {t1:>5.1%} {t2:>5.1%} {vol:>5.1%} {t1-vol:>+5.1%}")
