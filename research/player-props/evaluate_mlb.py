"""
evaluate_mlb.py — the baseball simulator's player props, backtested.

    python3 research/player-props/evaluate_mlb.py [DATA_DIR]

Reads the replays scripts/props-backtest-mlb.ts wrote with MLB_ROSTER=lineup
(sim_lineup_mlb_{2024,2025,2026}.*.jsonl): every game of 2025 and 2026 played
1,000 times from what was known that morning, with the posted starting nine —
the population the live board's graded picks come from, since a projected
starter who sits is a void. For every market the MLB boards show:

  - sim       the simulator's share, raw;
  - sim_cal   through an isotonic map fitted on 2025 alone, scored on 2026;
  - base      the 2025 base rate for everyone (the bar to clear).

Batter markets are graded on the starting nine, pitcher markets on the two
starters. A market ships calibrated when the map beat the raw simulator on
2026 (the games it never saw), with the map refitted on both seasons; the
projections' maps (mean:<stat>, simulated average -> actual average) are
fitted the same way. Playoff games are scored separately and never fitted.

Writes research/player-props/results/mlb_markets_backtest.json and merges the
MLB maps and backtest summary into src/lib/sim-props-calibration.json and
src/lib/sim-props-backtest.json.
"""

from __future__ import annotations

import glob
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import marketlib as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src", "lib")
RES = os.path.join(HERE, "results")
DATA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data")

# The simulator's lines (src/lib/sim/props.ts) and the rungs the boards show.
LINES = {
    "h": [1, 2, 3],
    "tb": [1, 2, 3, 4],
    "hr": [1, 2],
    "r": [1, 2],
    "rbi": [1, 2, 3],
    "hrr": [1, 2, 3, 4, 5],
    "sb": [1, 2],
    "k": [3, 4, 5, 6, 7, 8, 9, 10],
    "outs": [12, 15, 16, 17, 18, 19, 21],
    "er": [1, 2, 3, 4],
}
BOARD = {
    "h": [0, 1, 2],
    "tb": [1, 2, 3],
    "hr": [0],
    "r": [0, 1],
    "rbi": [0, 1],
    "hrr": [1, 2, 3],
    "sb": [0],
    "k": [1, 2, 3, 4, 5],
    "outs": [1, 2, 3, 4],
    "er": [0, 1, 2],
}
PITCHER = {"k", "outs", "er"}
NAME = {
    "h": ("hit", "hits"),
    "tb": ("total base", "total bases"),
    "hr": ("home run", "home runs"),
    "r": ("run", "runs"),
    "rbi": ("RBI", "RBI"),
    "hrr": ("H+R+RBI", "H+R+RBI"),
    "sb": ("stolen base", "stolen bases"),
    "k": ("strikeout", "strikeouts"),
    "outs": ("out", "outs"),
    "er": ("earned run", "earned runs"),
}
SING = {"h": "1+ hit", "hr": "Anytime HR", "r": "1+ run", "rbi": "1+ RBI", "sb": "1+ stolen base", "er": "1+ earned run"}
SLUG_BOARD = {"h": "hits", "tb": "bases", "hr": "homers", "r": "runs-rbi", "rbi": "runs-rbi", "hrr": "hrr",
              "sb": "steals", "k": "strikeouts", "outs": "pitching", "er": "pitching"}


def label(stat: str, line: int) -> str:
    if line == 1 and stat in SING:
        return SING[stat]
    return f"{line}+ {NAME[stat][1]}"


def load(season: int) -> list[dict]:
    games = []
    for f in sorted(glob.glob(os.path.join(DATA, f"sim_lineup_mlb_{season}.*.jsonl"))):
        with open(f) as fh:
            games += [json.loads(line) for line in fh if line.strip()]
    return games


def rows(games: list[dict], stat: str, idx: int):
    """(game id, day, sim share, sim mean, outcome) for each graded player."""
    line = LINES[stat][idx]
    out = []
    for g in games:
        for pid, pl in g["players"].items():
            act = pl.get("act") or {}
            m = pl.get(stat)
            if not m:
                continue
            if stat in PITCHER:
                if act.get("role") != "sp" or act.get(stat) is None:
                    continue
            elif act.get("role") != "lineup" or not act.get("pa"):
                continue
            out.append((g["id"], g["day"], float(m["over"][idx]), float(m["mean"]), float(act[stat] >= line)))
    return out


def evaluate(train: list[dict], test: list[dict], post: list[dict]) -> dict:
    res = {"markets": {}, "postseason": {}}
    for stat, idxs in BOARD.items():
        for idx in idxs:
            key = f"{stat}:{idx}"
            tr, te, po = rows(train, stat, idx), rows(test, stat, idx), rows(post, stat, idx)
            if not tr or not te:
                continue
            x_tr = np.array([r[2] for r in tr])
            y_tr = np.array([r[4] for r in tr])
            x_te = np.array([r[2] for r in te])
            y_te = np.array([r[4] for r in te])
            g_te = [r[0] for r in te]
            iso = L.iso().fit(x_tr, y_tr)
            cal_te = iso.predict(x_te)
            base = np.full_like(y_te, y_tr.mean())
            methods = {
                "sim": L.metrics(y_te, x_te, g_te),
                "sim_cal": L.metrics(y_te, cal_te, g_te),
                "base": L.metrics(y_te, base, g_te),
            }
            chosen = L.choose(methods)
            m = {
                "key": key,
                "stat": stat,
                "line": LINES[stat][idx],
                "label": label(stat, LINES[stat][idx]),
                "slug": f"{stat}{LINES[stat][idx]}",
                "board": SLUG_BOARD[stat],
                "chosen": chosen,
                "methods": {k: {kk: vv for kk, vv in v.items() if kk not in ("calibration", "top_bands")}
                            for k, v in methods.items()},
                "calibration": methods[chosen]["calibration"],
                "boot_cal_vs_raw": L.paired_boot(y_te, cal_te, x_te, g_te),
                "n": len(te),
                "games": len({r[0] for r in te}),
            }
            # what ships: the map refitted on both seasons
            x_all = np.concatenate([x_tr, x_te])
            y_all = np.concatenate([y_tr, y_te])
            if chosen == "sim_cal":
                fit = L.iso().fit(x_all, y_all)
                xs, ys = fit.X_thresholds_, fit.y_thresholds_
                if len(xs) > 40:
                    keep = np.unique(np.round(np.linspace(0, len(xs) - 1, 40)).astype(int))
                    xs, ys = xs[keep], ys[keep]
                m["curve"] = {"x": [round(float(v), 5) for v in xs], "y": [round(float(v), 5) for v in ys],
                              "n": int(len(x_all))}
            # the playoffs, as the board would have shown them (never fitted)
            if po:
                x_po = np.array([r[2] for r in po])
                y_po = np.array([r[4] for r in po])
                shown = L.iso().fit(x_all, y_all).predict(x_po) if chosen == "sim_cal" else x_po
                res["postseason"][key] = {"n": len(po), "said": float(shown.mean()), "hit": float(y_po.mean()),
                                          "by_year": {}}
                for yr in ("2024", "2025", "2026"):
                    sel = np.array([r[1].startswith(yr) for r in po])
                    if sel.any():
                        res["postseason"][key]["by_year"][yr] = {
                            "n": int(sel.sum()), "said": float(shown[sel].mean()), "hit": float(y_po[sel].mean())}
            res["markets"][key] = m
    return res


GROUPS = {"bat": ["h", "tb", "hr", "r", "rbi", "hrr", "sb"], "k": ["k"], "outs": ["outs"], "er": ["er"]}
NEGLIGIBLE = 0.06


def _sig(z):
    return 1 / (1 + np.exp(-z))


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def playoff_adjustment(res: dict, post: list[dict]) -> dict:
    """One log-odds shift per group on the simulator's share, before the
    market's calibration map, so the board's playoff numbers match what
    playoff games did. Checked by fitting on 2024-25 and scoring 2026; a group
    ships its shift (refitted on 2024-26) only if 2024-25 calls for one and it
    helps 2026. Averages get a factor the same way."""
    from sklearn.isotonic import IsotonicRegression

    curve = {}
    for key, m in res["markets"].items():
        if "curve" in m:
            c = m["curve"]
            curve[key] = (np.array(c["x"]), np.array(c["y"]))

    def shown(key, raw):
        if key not in curve:
            return raw
        x, y = curve[key]
        return np.interp(raw, x, y, left=None, right=None) if len(x) else raw

    out = {"groups": {}, "means": {}}
    for grp, stats in GROUPS.items():
        pools = {"2024-25": [], "2026": [], "all": []}
        for st in stats:
            for idx in BOARD[st]:
                key = f"{st}:{idx}"
                for r in rows(post, st, idx):
                    rec = (key, r[2], r[4])
                    pools["all"].append(rec)
                    pools["2026" if r[1].startswith("2026") else "2024-25"].append(rec)

        def fit(pool):
            keys = [k for k, _, _ in pool]
            raw = np.array([p for _, p, _ in pool])
            y = np.array([t for _, _, t in pool])
            lo, hi = -3.0, 3.0
            for _ in range(60):
                mid = (lo + hi) / 2
                adj = _sig(_logit(raw) + mid)
                said = np.mean([shown(k, np.array([a]))[0] for k, a in zip(keys, adj)])
                lo, hi = (mid, hi) if said < y.mean() else (lo, mid)
            return (lo + hi) / 2

        def score(pool, d):
            keys = [k for k, _, _ in pool]
            raw = np.array([p for _, p, _ in pool])
            y = np.array([t for _, _, t in pool])
            adj = _sig(_logit(raw) + d) if d else raw
            p = np.array([shown(k, np.array([a]))[0] for k, a in zip(keys, adj)])
            return float(p.mean()), float(y.mean()), float(np.mean((p - y) ** 2))

        if not pools["2024-25"] or not pools["2026"]:
            continue
        d_val = fit(pools["2024-25"])
        raw_said, hit, raw_b = score(pools["2026"], 0.0)
        adj_said, _, adj_b = score(pools["2026"], d_val)
        earned = abs(d_val) >= NEGLIGIBLE and adj_b < raw_b
        out["groups"][grp] = {
            "fit_2024_25": d_val, "test_raw_said": raw_said, "test_adj_said": adj_said, "test_hit": hit,
            "test_raw_brier": raw_b, "test_adj_brier": adj_b,
            "ship": round(fit(pools["all"]), 4) if earned else 0.0,
        }
    for st in BOARD:
        xs, ys, yrs = [], [], []
        for g in post:
            for pl in g["players"].values():
                act = pl.get("act") or {}
                m = pl.get(st)
                if not m:
                    continue
                if st in PITCHER:
                    if act.get("role") != "sp" or act.get(st) is None:
                        continue
                elif act.get("role") != "lineup" or not act.get("pa"):
                    continue
                xs.append(float(m["mean"]))
                ys.append(float(act[st]))
                yrs.append(g["day"][:4])
        xs, ys, yrs = np.array(xs), np.array(ys), np.array(yrs)
        if not len(xs):
            continue
        tr, te = yrs != "2026", yrs == "2026"
        f_val = float(ys[tr].sum() / max(1e-9, xs[tr].sum()))
        mae_raw = float(np.mean(np.abs(xs[te] - ys[te])))
        mae_adj = float(np.mean(np.abs(xs[te] * f_val - ys[te])))
        f_all = float(ys.sum() / max(1e-9, xs.sum()))
        earned = abs(f_val - 1) >= 0.03 and mae_adj < mae_raw
        out["means"][st] = {"fit_2024_25": f_val, "mae_raw": mae_raw, "mae_adj": mae_adj,
                            "ship": round(f_all, 4) if earned else 1.0}
    return out


def mean_map(mean_tr, act_tr, mean_te, act_te) -> dict:
    from sklearn.isotonic import IsotonicRegression

    ok_tr = ~np.isnan(act_tr)
    ok_te = ~np.isnan(act_te)
    iso = IsotonicRegression(out_of_bounds="clip").fit(mean_tr[ok_tr], act_tr[ok_tr])
    pred = iso.predict(mean_te[ok_te])
    raw_mae = float(np.mean(np.abs(mean_te[ok_te] - act_te[ok_te])))
    cal_mae = float(np.mean(np.abs(pred - act_te[ok_te])))
    allx = np.concatenate([mean_tr[ok_tr], mean_te[ok_te]])
    ally = np.concatenate([act_tr[ok_tr], act_te[ok_te]])
    fit = IsotonicRegression(out_of_bounds="clip").fit(allx, ally)
    xs, ys = fit.X_thresholds_, fit.y_thresholds_
    if len(xs) > 40:
        keep = np.unique(np.round(np.linspace(0, len(xs) - 1, 40)).astype(int))
        xs, ys = xs[keep], ys[keep]
    return {
        "sim_mean": float(mean_te[ok_te].mean()),
        "actual_mean": float(act_te[ok_te].mean()),
        "mae_raw": raw_mae,
        "mae_cal": cal_mae,
        "ship": cal_mae < raw_mae,
        "curve": {"x": [round(float(v), 4) for v in xs], "y": [round(float(v), 4) for v in ys], "n": int(len(allx))},
    }


def collect_means(games: list[dict], stat: str):
    """(sim mean, actual) for every graded player of a stat."""
    xs, ys = [], []
    for g in games:
        for pl in g["players"].values():
            act = pl.get("act") or {}
            m = pl.get(stat)
            if not m:
                continue
            if stat in PITCHER:
                if act.get("role") != "sp" or act.get(stat) is None:
                    continue
            elif act.get("role") != "lineup" or not act.get("pa"):
                continue
            xs.append(float(m["mean"]))
            ys.append(float(act[stat]))
    return np.array(xs), np.array(ys)



def calibration_rows(rows):
    """Decile rows labelled 'about X%', with neighbours that round to the same
    X pooled into one row (MLB's hit chances sit in a narrow range, so two
    deciles can both read 'about 60%')."""
    out = []
    for r in rows:
        band = f"about {round(r['predicted'] * 100)}%"
        if out and out[-1]["band"] == band:
            o = out[-1]
            n = o["n"] + r["n"]
            o["predicted"] = (o["predicted"] * o["n"] + r["predicted"] * r["n"]) / n
            o["actual"] = (o["actual"] * o["n"] + r["actual"] * r["n"]) / n
            o["n"] = n
        else:
            out.append({"band": band, "n": r["n"], "predicted": r["predicted"], "actual": r["actual"]})
    return [{**o, "predicted": round(o["predicted"], 4), "actual": round(o["actual"], 4)} for o in out]

def main() -> None:
    regular = lambda gs: [g for g in gs if g.get("stype") == 2]  # noqa: E731
    playoffs = lambda gs: [g for g in gs if g.get("stype") == 3]  # noqa: E731
    g25, g26, g24 = load(2025), load(2026), load(2024)
    train, test = regular(g25), regular(g26)
    post = playoffs(g24) + playoffs(g25) + playoffs(g26)
    print(f"train 2025: {len(train)} games, test 2026: {len(test)}, playoffs 2024-26: {len(post)}")

    res = {"markets": {}, "means": {}, "postseason": {}}
    full = evaluate(train, test, post)
    res["markets"], res["postseason"] = full["markets"], full["postseason"]
    for stat in BOARD:
        mtr, atr = collect_means(train, stat)
        mte, ate = collect_means(test, stat)
        res["means"][stat] = mean_map(mtr, atr, mte, ate)

    os.makedirs(RES, exist_ok=True)
    with open(os.path.join(RES, "mlb_markets_backtest.json"), "w") as fh:
        json.dump(res, fh, indent=1)

    print(f"\n{'market':>8} {'label':>18} {'n':>7} | {'raw brier':>9} {'cal brier':>9} {'base':>8} | {'auc':>5} | "
          f"{'top3 hit':>8} {'said':>6} | ship")
    for key, m in res["markets"].items():
        M, c = m["methods"], m["chosen"]
        print(f"{key:>8} {m['label']:>18} {m['n']:>7} | {M['sim']['brier']:.4f}    {M['sim_cal']['brier']:.4f}    "
              f"{M['base']['brier']:.4f} | {M[c]['auc']:.3f} | {M[c]['top_hit']:.1%}   {M[c]['top_said']:.1%} | {c}")
    print("\nprojections (2026 starters): sim mean vs actual, mean abs error raw -> mapped")
    for stat, mm in res["means"].items():
        print(f"  {stat:>5}: {mm['sim_mean']:.3f} vs {mm['actual_mean']:.3f}, MAE {mm['mae_raw']:.3f} -> {mm['mae_cal']:.3f}"
              f" {'(ships)' if mm['ship'] else ''}")
    print("\nplayoffs 2024-26, as the board would show them:")
    for key, p in res["postseason"].items():
        yrs = " ".join(f"{y}: {v['said']:.0%}/{v['hit']:.0%}" for y, v in p["by_year"].items())
        print(f"  {key:>7} n={p['n']:>4} said {p['said']:.1%} came in {p['hit']:.1%}   ({yrs})")

    res["playoff"] = playoff_adjustment(res, post)
    print("\nplayoff adjustment (fit 2024-25, scored on 2026; ships refitted on 2024-26):")
    for grp, v in res["playoff"]["groups"].items():
        print(f"  {grp:>6}: shift(2024-25) {v['fit_2024_25']:+.3f} -> 2026 said {v['test_raw_said']:.1%} -> "
              f"{v['test_adj_said']:.1%}, came in {v['test_hit']:.1%}; brier {v['test_raw_brier']:.4f} -> "
              f"{v['test_adj_brier']:.4f} | ships {v['ship']:+.3f}")
    for stat, v in res["playoff"]["means"].items():
        print(f"  mean {stat:>5}: x{v['fit_2024_25']:.3f} (2024-25) -> 2026 MAE {v['mae_raw']:.3f} -> {v['mae_adj']:.3f}"
              f" | ships x{v['ship']:.3f}")

    # ---- merge into the site's files
    cal_path = os.path.join(SRC, "sim-props-calibration.json")
    cal = json.load(open(cal_path))
    curves = {k: m["curve"] for k, m in res["markets"].items() if "curve" in m}
    for stat, mm in res["means"].items():
        if mm["ship"]:
            curves[f"mean:{stat}"] = mm["curve"]
    cal["curves"]["mlb"] = curves
    cal.setdefault("playoff", {})["mlb"] = {
        "note": "Playoff games only: a log-odds shift on the simulator's share before calibration, per "
        "stat, and a factor on its averages. Fitted on the 2024-2026 postseasons; "
        "research/player-props/evaluate_mlb.py.",
        "shift": {st: v["ship"] for grp, v in res["playoff"]["groups"].items() if v["ship"]
                  for st in GROUPS[grp]},
        "mean": {st: v["ship"] for st, v in res["playoff"]["means"].items() if v["ship"] != 1.0},
    }
    with open(cal_path, "w") as fh:
        json.dump(cal, fh, separators=(",", ":"))

    bt_path = os.path.join(SRC, "sim-props-backtest.json")
    bt = json.load(open(bt_path))
    out = {}
    for key, m in res["markets"].items():
        c = m["chosen"]
        out[key] = {
            "label": m["label"],
            "season": "the 2026 MLB regular season",
            "n": m["n"],
            "games": m["games"],
            "chosen": c,
            "top_unit": "Top 3 a game came in",
            "methods": {k: {kk: round(v[kk], 4) if isinstance(v.get(kk), float) else v.get(kk)
                            for kk in ("brier", "log_loss", "auc", "top_hit", "top_said")}
                        for k, v in m["methods"].items() if k in ("sim", "sim_cal")},
            "calibration": calibration_rows(m["calibration"]),
            "board": m["board"],
            "slug": m["slug"],
            "bands": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in b.items()}
                      for b in m["methods"][c]["bands"]],
        }
    bt["mlb"] = out
    with open(bt_path, "w") as fh:
        json.dump(bt, fh, separators=(",", ":"))
    print(f"\nmerged {len(curves)} MLB maps into {cal_path} and {len(out)} markets into {bt_path}")


if __name__ == "__main__":
    main()
