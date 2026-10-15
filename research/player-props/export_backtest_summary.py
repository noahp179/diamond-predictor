"""
export_backtest_summary.py — the backtest numbers the boards print.

    python3 research/player-props/export_backtest_summary.py

Collects research/player-props/results/*_backtest.json (NBA, NHL) and
*_td_backtest.json (NFL, college) into src/lib/sim-props-backtest.json:
for each league and market, every method's error score (Brier), ranking
(AUC) and the hit rate of the picks a board would show, which method the
board uses, and its "when it said X%, did X% happen" table.
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
OUT = os.path.join(HERE, "..", "..", "src", "lib", "sim-props-backtest.json")


def bands(cal: list[dict]) -> list[dict]:
    out = []
    for c in cal:
        p = c["predicted"]
        out.append({"band": f"about {round(p * 100)}%", "n": c["n"], "predicted": p, "actual": c["actual"]})
    return out


def slim(m: dict, top: str = "top") -> dict:
    return {
        "brier": m["brier"],
        "log_loss": m["log_loss"],
        "auc": m["auc"],
        "top_hit": m[f"{top}_hit"] if f"{top}_hit" in m else m.get("top1_hit"),
        "top_said": m[f"{top}_said"] if f"{top}_said" in m else m.get("top1_said"),
    }


def basketball_hockey(sport: str, season: str, keys: dict[str, str], first_key: str | None) -> dict:
    path = os.path.join(RES, f"{sport}_backtest.json")
    if not os.path.exists(path):
        return {}
    d = json.load(open(path))
    out = {}
    for t in d["targets"]:
        key = keys.get(t["label"])
        if not key:
            continue
        is_first = key == "first"
        chosen = "sim" if is_first else ("sim_cal" if "sim_cal" in t["methods"] else "sim")
        top = "game_top1" if is_first else "top"
        any_m = next(iter(t["methods"].values()))
        if not any_m.get("games"):
            preds = os.path.join(HERE, "data", f"preds_{sport}.json")
            if os.path.exists(preds):
                any_m["games"] = len({r["gid"] for r in json.load(open(preds))["rows"]})
        out[key] = {
            "label": t["label"],
            "season": season,
            "n": any_m["n"],
            "games": any_m.get("games") or 0,
            "chosen": chosen,
            "top_unit": "Top pick per game came in" if is_first else "Top 10 a day came in",
            "methods": {m: slim(v, top) for m, v in t["methods"].items()},
            "calibration": bands(t["methods"][chosen]["calibration"]),
        }
    return out


def football(league: str, season: str) -> dict:
    path = os.path.join(RES, f"{league}_td_backtest.json")
    if not os.path.exists(path):
        return {}
    d = json.load(open(path))
    out = {}
    a = d["anytime"]
    chosen_any = "sim_cal" if league == "nfl" else "model"
    out["td:0"] = {
        "label": "Anytime touchdown",
        "season": season,
        "n": a[chosen_any]["n"],
        "games": a[chosen_any]["games"],
        "chosen": chosen_any,
        "top_unit": "Top pick per game scored",
        "methods": {m: slim(v, "top1") for m, v in a.items()},
        "calibration": bands(a[chosen_any]["calibration"]),
    }
    f = d.get("first_td") or {}
    if f:
        chosen_first = "sim" if league == "nfl" else "model_share"
        out["first"] = {
            "label": "First touchdown",
            "season": season,
            "n": f[chosen_first]["n"],
            "games": f[chosen_first]["games"],
            "chosen": chosen_first,
            "top_unit": "Top pick per game scored first",
            "methods": {m: slim(v, "top1") for m, v in f.items()},
            "calibration": bands(f[chosen_first]["calibration"]),
        }
    return out


TOP_UNIT = {"top3": "Top 3 per game came in", "top1": "Top pick per game came in"}


def slim_new(m: dict, unit: str) -> dict:
    hit, said = ("top1_hit", "top1_said") if unit == "top1" else ("top_hit", "top_said")
    return {"brier": m["brier"], "log_loss": m["log_loss"], "auc": m["auc"], "top_hit": m[hit], "top_said": m[said]}


def new_markets(out: dict, league: str, path: str, season: str) -> None:
    """Every market of evaluate_markets.py / evaluate_nfl_props.py: added where
    the published summary has no entry, and its fixed confidence bands added
    to every entry (the Analytics page reads them)."""
    if not os.path.exists(path):
        return
    d = json.load(open(path))
    h2h = d.get("head_to_head", {})
    for slug, m in d["markets"].items():
        key, chosen, unit = m["key"], m["chosen"], m.get("top_unit", "top3")
        ch = m["methods"][chosen]
        entry = out.setdefault(league, {}).get(key)
        if entry is None:
            entry = {
                "label": m["label"],
                "season": season,
                "n": ch["n"],
                "games": ch["games"],
                "chosen": chosen,
                "top_unit": TOP_UNIT[unit],
                "methods": {k: slim_new(v, unit) for k, v in m["methods"].items()},
                "calibration": bands(ch["calibration"]),
            }
            out[league][key] = entry
        entry["board"] = m.get("board")
        entry["slug"] = slug
        if entry["chosen"] in m["methods"]:
            entry["bands"] = m["methods"][entry["chosen"]]["bands"]
        if slug in h2h:
            h = h2h[slug]
            b = h.get("boot_chosen_vs_model") or h.get("boot_simcal_vs_model")
            c = h.get("chosen", chosen)
            entry["h2h"] = {
                "n": h["n"],
                "model": slim_new(h["methods"]["model"], unit),
                "chosen": slim_new(h["methods"][c], unit),
                "diff": b["diff"],
                "lo": b["lo"],
                "hi": b["hi"],
            }


def main() -> None:
    nba_keys = {f"{n}+ points": f"pts:{i}" for i, n in enumerate([10, 15, 20, 25, 30])}
    nhl_keys = {"1+ point": "pts:0", "2+ points": "pts:1", "1+ goal": "g:0", "First goal": "first"}
    out = {
        "nba": basketball_hockey("nba", "the 2025-26 NBA season", nba_keys, None),
        "nhl": basketball_hockey("nhl", "the 2025-26 NHL season", nhl_keys, "first"),
        "nfl": football("nfl", "the 2025 NFL season and 2026 to date"),
        "cfb": football("cfb", "the 2025 college season and 2026 to date"),
    }
    new_markets(out, "nba", os.path.join(RES, "nba_markets_backtest.json"), "the 2025-26 NBA season")
    new_markets(out, "nhl", os.path.join(RES, "nhl_markets_backtest.json"), "the 2025-26 NHL season")
    new_markets(out, "nfl", os.path.join(RES, "nfl_props_backtest.json"), "the 2025 NFL season and 2026 to date")
    runs = {}
    for sport in ("nba", "nhl"):
        p = os.path.join(RES, f"{sport}_runs_study.json")
        if os.path.exists(p):
            runs[sport] = json.load(open(p))
    out["runs"] = runs
    # Four significant decimals is more than any number on the page shows,
    # and the file ships to the browser.
    def rnd(x):
        if isinstance(x, float):
            return round(x, 4)
        if isinstance(x, dict):
            return {k: rnd(v) for k, v in x.items()}
        if isinstance(x, list):
            return [rnd(v) for v in x]
        return x

    out = rnd(out)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, {k: list(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
