"""
Fetch the MLB game spine for the game-outcome bake-off: every completed regular
season game 2021-2024 with final scores, venue, and both starting pitchers.

One schedule call per season (hydrated with probablePitcher + linescore), so the
whole dataset is ~4 requests. Output: data/games.csv
"""
import os, time, warnings
import requests
import pandas as pd

warnings.filterwarnings("ignore")
SEASONS = [2021, 2022, 2023, 2024]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
os.makedirs(DATA, exist_ok=True)
API = "https://statsapi.mlb.com/api/v1"


def get(url, tries=4):
    for a in range(tries):
        try:
            r = requests.get(url, timeout=60)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.5 * (a + 1))
    return None


def season_games(season):
    url = (f"{API}/schedule?sportId=1&gameType=R"
           f"&startDate={season}-03-01&endDate={season}-11-15"
           f"&hydrate=probablePitcher,linescore")
    d = get(url)
    out = []
    for day in (d or {}).get("dates", []):
        for g in day.get("games", []):
            if g.get("status", {}).get("codedGameState") not in ("F", "O"):
                continue
            h, a = g["teams"]["home"], g["teams"]["away"]
            if h.get("score") is None or a.get("score") is None:
                continue
            out.append(dict(
                gamePk=g["gamePk"], date=g["gameDate"][:10], season=season,
                venue=g.get("venue", {}).get("name", ""),
                home=h["team"]["id"], away=a["team"]["id"],
                home_name=h["team"].get("name", ""), away_name=a["team"].get("name", ""),
                home_score=int(h["score"]), away_score=int(a["score"]),
                home_sp=(h.get("probablePitcher") or {}).get("id"),
                away_sp=(a.get("probablePitcher") or {}).get("id"),
                innings=(g.get("linescore", {}) or {}).get("currentInning", 9),
                doubleheader=g.get("doubleHeader", "N"),
            ))
    return out


def main():
    rows = []
    for s in SEASONS:
        g = season_games(s)
        print(f"{s}: {len(g)} completed games")
        rows += g
    df = pd.DataFrame(rows).sort_values(["date", "gamePk"]).reset_index(drop=True)
    df["home_win"] = (df.home_score > df.away_score).astype(int)
    df.to_csv(os.path.join(DATA, "games.csv"), index=False)
    print(f"\ntotal {len(df):,} games")
    print(f"home win rate: {df.home_win.mean():.4f}")
    print(f"probable pitcher coverage: home {df.home_sp.notna().mean():.1%} "
          f"away {df.away_sp.notna().mean():.1%}")
    print(f"avg runs/game: {(df.home_score + df.away_score).mean():.2f}")


if __name__ == "__main__":
    main()
