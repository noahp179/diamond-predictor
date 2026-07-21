"""
Collect MLB batter-game data for the home-run-hitter model, from the free,
comprehensive MLB Stats API (statsapi.mlb.com). One boxscore call per game gives
every batter's HR / AB / PA / batting-order slot and every pitcher's HR allowed /
batters faced, plus the venue and the two starting pitchers.

Outputs (research/mlb-hr/data):
  batter_games.csv - one row per (game, batter): usage + HR outcome + opp starter
  pitcher_games.csv - one row per (game, pitcher): HR allowed, batters faced
  game_meta.csv     - one row per game: date, venue, home/away, starters
Raw JSON is cached to scratchpad so re-runs are instant.
"""
import os, json, time, warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

warnings.filterwarnings("ignore")
SEASONS = [2023, 2024]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = "/tmp/claude-0/-home-user-diamond-predictor/baf68327-288b-55a2-bd0e-f7a6ee6b3fda/scratchpad/mlbhr/cache"
os.makedirs(DATA, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
API = "https://statsapi.mlb.com/api/v1"


def get(url, tries=4):
    for a in range(tries):
        try:
            r = requests.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.2 * (a + 1))
    return None


def schedule(season):
    d = get(f"{API}/schedule?sportId=1&gameType=R&startDate={season}-03-01&endDate={season}-11-10")
    games = []
    for day in (d or {}).get("dates", []):
        for g in day.get("games", []):
            if g.get("status", {}).get("codedGameState") not in ("F", "O"):  # final only
                continue
            games.append(dict(
                gamePk=g["gamePk"], date=g["gameDate"][:10], season=season,
                venue=g.get("venue", {}).get("name", ""),
                home=g["teams"]["home"]["team"]["id"], away=g["teams"]["away"]["team"]["id"],
                home_sp=g["teams"]["home"].get("probablePitcher", {}).get("id"),
                away_sp=g["teams"]["away"].get("probablePitcher", {}).get("id"),
            ))
    return games


def boxscore(gamePk):
    fp = os.path.join(CACHE, f"{gamePk}.json")
    if os.path.exists(fp):
        try:
            return json.load(open(fp))
        except Exception:
            pass
    d = get(f"{API}/game/{gamePk}/boxscore")
    if d:
        json.dump(d, open(fp, "w"))
    return d


def parse(meta, bx):
    if not bx:
        return [], []
    bats, pits = [], []
    starter = {}
    for side in ("home", "away"):
        t = bx.get("teams", {}).get(side, {})
        pitchers = t.get("pitchers", [])
        starter[side] = pitchers[0] if pitchers else None
    for side in ("home", "away"):
        t = bx.get("teams", {}).get(side, {})
        team_id = t.get("team", {}).get("id")
        opp_side = "away" if side == "home" else "home"
        opp_sp = (meta["home_sp"] if side == "away" else meta["away_sp"]) or starter[opp_side]
        for _, pl in t.get("players", {}).items():
            person = pl.get("person", {})
            bat = pl.get("stats", {}).get("batting", {})
            pit = pl.get("stats", {}).get("pitching", {})
            order = pl.get("battingOrder")
            if bat and bat.get("plateAppearances") is not None and bat.get("gamesPlayed"):
                pa = int(bat.get("plateAppearances") or 0)
                if pa > 0:
                    bats.append(dict(
                        gamePk=meta["gamePk"], date=meta["date"], season=meta["season"],
                        batter_id=person.get("id"), name=person.get("fullName", ""),
                        team_id=team_id, is_home=int(side == "home"),
                        hr=int(bat.get("homeRuns") or 0), ab=int(bat.get("atBats") or 0), pa=pa,
                        doubles=int(bat.get("doubles") or 0), triples=int(bat.get("triples") or 0),
                        bb=int(bat.get("baseOnBalls") or 0),
                        order_slot=(int(order) // 100 if order and int(order) % 100 == 0 else 0),
                        opp_sp=opp_sp, venue=meta["venue"],
                    ))
            if pit and pit.get("battersFaced") is not None:
                pits.append(dict(
                    gamePk=meta["gamePk"], date=meta["date"], season=meta["season"],
                    pitcher_id=person.get("id"), team_id=team_id,
                    is_starter=int(person.get("id") == starter[side]),
                    hr_allowed=int(pit.get("homeRuns") or 0), bf=int(pit.get("battersFaced") or 0),
                ))
    return bats, pits


def main():
    import pandas as pd
    metas = []
    for s in SEASONS:
        g = schedule(s)
        print(f"{s}: {len(g)} final games")
        metas += g
    print(f"total games: {len(metas)}")

    results = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(boxscore, m["gamePk"]): m for m in metas}
        done = 0
        for fut in as_completed(futs):
            results[futs[fut]["gamePk"]] = fut.result()
            done += 1
            if done % 500 == 0:
                print(f"  {done}/{len(metas)} ({time.time()-t0:.0f}s)")

    all_bats, all_pits, miss = [], [], 0
    for m in metas:
        bx = results.get(m["gamePk"])
        if not bx:
            miss += 1
            continue
        b, p = parse(m, bx)
        all_bats += b
        all_pits += p
    print(f"missing boxscores: {miss}")
    pd.DataFrame(metas).to_csv(os.path.join(DATA, "game_meta.csv"), index=False)
    pd.DataFrame(all_bats).to_csv(os.path.join(DATA, "batter_games.csv"), index=False)
    pd.DataFrame(all_pits).to_csv(os.path.join(DATA, "pitcher_games.csv"), index=False)
    print(f"batter-games: {len(all_bats):,}  pitcher-games: {len(all_pits):,}")


if __name__ == "__main__":
    main()
