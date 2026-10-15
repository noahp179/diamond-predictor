"""
tables_markets.py — the tables for every market, from the backtest results.

    python3 research/player-props/tables_markets.py

Reads results/{nba,nhl}_markets_backtest.json and results/nfl_props_backtest.json,
writes results/markets_tables.md: per market, each method's Brier / AUC (the
best Brier in bold), which one the board uses, how its top picks did against
what they were priced at, and for the NFL the head-to-head with the shipped
logistic prop models.
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
ORDER = ["sim", "sim_cal", "avg", "fit", "blend"]
NAME = {"sim": "sim", "sim_cal": "sim, calibrated", "avg": "season avg", "fit": "fitted trees", "blend": "blend"}


def table(d: dict) -> list[str]:
    any_m = next(iter(d["markets"].values()))
    cols = [k for k in ORDER if k in any_m["methods"] or any(k in m["methods"] for m in d["markets"].values())]
    out = [
        "| line | player-games | " + " | ".join(NAME[k] for k in cols) + " | board | top picks came in (said) |",
        "|---|---|" + "---|" * len(cols) + "---|---|",
    ]
    for m in d["markets"].values():
        M, c, unit = m["methods"], m["chosen"], m.get("top_unit", "top3")
        th, ts = ("top1_hit", "top1_said") if unit == "top1" else ("top_hit", "top_said")
        best = min(M, key=lambda k: M[k]["brier"])
        cells = []
        for k in cols:
            if k not in M:
                cells.append("—")
                continue
            b = f"{M[k]['brier']:.4f}"
            cells.append(f"**{b}** / {M[k]['auc']:.3f}" if k == best else f"{b} / {M[k]['auc']:.3f}")
        out.append(
            f"| {m['label']} | {M[c]['n']:,} | " + " | ".join(cells)
            + f" | {'calibrated' if c == 'sim_cal' else 'raw'} | {M[c][th] * 100:.1f}% ({M[c][ts] * 100:.1f}%)"
            + f" {'top pick' if unit == 'top1' else 'top 3'} a game |"
        )
    return out


def significance(d: dict) -> list[str]:
    lines = []
    for other in ("avg", "fit", "blend"):
        better = worse = tie = 0
        for m in d["markets"].values():
            b = m.get(f"boot_simcal_vs_{other}")
            if not b:
                continue
            if b["hi"] < 0:
                better += 1
            elif b["lo"] > 0:
                worse += 1
            else:
                tie += 1
        if better + worse + tie:
            lines.append(
                f"- Calibrated simulator vs {NAME[other]}: better on {better}, worse on {worse}, "
                f"too close to call on {tie} (paired bootstrap over games, 95%)."
            )
    return lines


def main() -> None:
    md = ["# Every market: backtest tables", ""]
    for league, name, title in (
        ("nba", "nba_markets_backtest.json", "NBA, 2025-26 (trained on 2024-25)"),
        ("nhl", "nhl_markets_backtest.json", "NHL, 2025-26 (trained on 2024-25)"),
        ("nfl", "nfl_props_backtest.json", "NFL, 2025 and 2026 to date (calibration cross-fitted by date)"),
    ):
        p = os.path.join(RES, name)
        if not os.path.exists(p):
            continue
        d = json.load(open(p))
        md += [f"## {title}", "", "Each cell is Brier / AUC; the best Brier is bold.", ""] + table(d) + [""]
        md += significance(d) + [""]
        if d.get("head_to_head"):
            md += [
                "### Against the shipped logistic prop models (same player-games)",
                "",
                "| line | player-games | logistic model | simulator (board) | difference [95%] | top picks: model / sim |",
                "|---|---|---|---|---|---|",
            ]
            for slug, h in d["head_to_head"].items():
                m = d["markets"][slug]
                c = h.get("chosen", "sim_cal")
                th = "top1_hit" if m.get("top_unit") == "top1" else "top_hit"
                b = h.get("boot_chosen_vs_model") or h["boot_simcal_vs_model"]
                v = "simulator better" if b["hi"] < 0 else ("model better" if b["lo"] > 0 else "too close to call")
                md.append(
                    f"| {m['label']} | {h['n']:,} | {h['methods']['model']['brier']:.4f} / {h['methods']['model']['auc']:.3f}"
                    f" | {h['methods'][c]['brier']:.4f} / {h['methods'][c]['auc']:.3f}"
                    f" | {b['diff']:+.4f} [{b['lo']:+.4f}, {b['hi']:+.4f}] {v}"
                    f" | {h['methods']['model'][th] * 100:.1f}% / {h['methods'][c][th] * 100:.1f}% |"
                )
            md.append("")
    with open(os.path.join(RES, "markets_tables.md"), "w") as f:
        f.write("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()
