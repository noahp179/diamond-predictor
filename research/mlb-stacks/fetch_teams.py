"""
One row per team-game: who batted, against whom, where, and how many runs they
actually scored.

MLB's schedule endpoint already carries the final score and the probable
starters, so three calls (one per season) give the whole team-offence dataset.
That matters for parity: the live pipeline reads the *same* endpoint for
tonight's slate, so the venue, the probable starter and the opponent it sees
are the ones the model was fitted on.

Outputs (research/mlb-stacks/data):
  team_games.csv  - two rows per game (home and away), with runs scored/allowed

Everything richer than the score - the team's own TB/PA, K/PA, the opposing
starter's per-batter-faced rates - is aggregated in features_team.py from the
box scores research/mlb-props/fetch_props.py already downloads, so this script
never re-fetches them.
"""

import os
import time

import pandas as pd
import requests

SEASONS = [2024, 2025, 2026]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
os.makedirs(DATA, exist_ok=True)
API = "https://statsapi.mlb.com/api/v1"
SESSION = requests.Session()


def get(url, tries=4):
    for a in range(tries):
        try:
            r = SESSION.get(url, timeout=60)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.0 * (a + 1))
    return None


def season_rows(season):
    d = get(
        f"{API}/schedule?sportId=1&gameType=R"
        f"&startDate={season}-03-01&endDate={season}-11-10"
        f"&hydrate=probablePitcher,linescore"
    )
    rows = []
    for day in (d or {}).get("dates", []):
        for g in day.get("games", []):
            if g.get("status", {}).get("codedGameState") not in ("F", "O"):
                continue
            t = g["teams"]
            if t["home"].get("score") is None or t["away"].get("score") is None:
                continue
            common = dict(
                gamePk=g["gamePk"],
                date=g["gameDate"][:10],
                season=season,
                venue=g.get("venue", {}).get("name", ""),
            )
            for side, other in (("home", "away"), ("away", "home")):
                rows.append(
                    dict(
                        common,
                        team_id=t[side]["team"]["id"],
                        team=t[side]["team"].get("name", ""),
                        opp_team=t[other]["team"]["id"],
                        is_home=int(side == "home"),
                        runs=int(t[side]["score"]),
                        opp_runs=int(t[other]["score"]),
                        sp=(t[side].get("probablePitcher") or {}).get("id"),
                        opp_sp=(t[other].get("probablePitcher") or {}).get("id"),
                    )
                )
    return rows


def main():
    rows = []
    for s in SEASONS:
        r = season_rows(s)
        print(f"{s}: {len(r)//2} final games", flush=True)
        rows += r
    df = pd.DataFrame(rows).sort_values(["date", "gamePk", "is_home"])
    df.to_csv(os.path.join(DATA, "team_games.csv"), index=False)
    print(
        f"team-games: {len(df):,}  mean runs {df.runs.mean():.2f}  "
        f"opp starter known {df.opp_sp.notna().mean():.1%}"
    )
    for n in (4, 5, 6):
        print(f"  P(runs >= {n}) = {(df.runs >= n).mean():.3f}")


if __name__ == "__main__":
    main()
