"""
Collect MLB player-game data for the player-prop models, from MLB's free Stats
API (statsapi.mlb.com). One boxscore call per game gives every batter's full
line (H / TB / HR / RBI / R / SB / BB / K / PA) with the batting-order slot, and
every pitcher's line (K / outs / BF / H / BB / ER) with who started.

Outputs (research/mlb-props/data):
  batter_games.csv  - one row per (game, batter): the full prop-relevant line
  pitcher_games.csv - one row per (game, pitcher): K / outs / BF, starter flag
  game_meta.csv     - one row per game: date, venue, home/away teams + starters

Raw JSON is cached to the scratchpad so re-runs are instant.
"""

import os, json, time, warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

warnings.filterwarnings("ignore")

SEASONS = [2024, 2025, 2026]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.environ.get(
    "MLB_PROPS_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/8eb2dd74-712a-5179-bb60-2ffb42ffa173/scratchpad/mlbprops/cache",
)
os.makedirs(DATA, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
API = "https://statsapi.mlb.com/api/v1"

SESSION = requests.Session()


def get(url, tries=4):
    for a in range(tries):
        try:
            r = SESSION.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.0 * (a + 1))
    return None


def schedule(season):
    d = get(
        f"{API}/schedule?sportId=1&gameType=R&startDate={season}-03-01&endDate={season}-11-10"
    )
    games = []
    for day in (d or {}).get("dates", []):
        for g in day.get("games", []):
            if g.get("status", {}).get("codedGameState") not in ("F", "O"):  # finals only
                continue
            games.append(
                dict(
                    gamePk=g["gamePk"],
                    date=g["gameDate"][:10],
                    season=season,
                    venue=g.get("venue", {}).get("name", ""),
                    home=g["teams"]["home"]["team"]["id"],
                    away=g["teams"]["away"]["team"]["id"],
                    home_sp=(g["teams"]["home"].get("probablePitcher") or {}).get("id"),
                    away_sp=(g["teams"]["away"].get("probablePitcher") or {}).get("id"),
                )
            )
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


def i(v):
    try:
        return int(v or 0)
    except Exception:
        return 0


def outs_from_ip(ip):
    """'5.2' innings pitched -> 17 outs."""
    try:
        whole, _, frac = str(ip).partition(".")
        return int(whole) * 3 + int(frac or 0)
    except Exception:
        return 0


def parse(meta, bx):
    if not bx:
        return [], []
    bats, pits = [], []
    starter = {}
    for side in ("home", "away"):
        t = bx.get("teams", {}).get(side, {})
        ps = t.get("pitchers", [])
        starter[side] = ps[0] if ps else None

    for side in ("home", "away"):
        t = bx.get("teams", {}).get(side, {})
        team_id = t.get("team", {}).get("id")
        opp_side = "away" if side == "home" else "home"
        opp_team = bx.get("teams", {}).get(opp_side, {}).get("team", {}).get("id")
        # The opposing starter actually used (schedule "probable" can be wrong).
        opp_sp = starter[opp_side] or (
            meta["home_sp"] if side == "away" else meta["away_sp"]
        )
        for _, pl in t.get("players", {}).items():
            person = pl.get("person", {})
            pid = person.get("id")
            bat = pl.get("stats", {}).get("batting", {}) or {}
            pit = pl.get("stats", {}).get("pitching", {}) or {}
            order = pl.get("battingOrder")
            slot = i(order) // 100 if order and i(order) % 100 == 0 else 0

            pa = i(bat.get("plateAppearances"))
            if bat and pa > 0:
                h = i(bat.get("hits"))
                d2 = i(bat.get("doubles"))
                d3 = i(bat.get("triples"))
                hr = i(bat.get("homeRuns"))
                bats.append(
                    dict(
                        gamePk=meta["gamePk"],
                        date=meta["date"],
                        season=meta["season"],
                        batter_id=pid,
                        name=person.get("fullName", ""),
                        team_id=team_id,
                        opp_team=opp_team,
                        is_home=int(side == "home"),
                        pa=pa,
                        ab=i(bat.get("atBats")),
                        h=h,
                        d2=d2,
                        d3=d3,
                        hr=hr,
                        tb=h + d2 + 2 * d3 + 3 * hr,
                        rbi=i(bat.get("rbi")),
                        r=i(bat.get("runs")),
                        sb=i(bat.get("stolenBases")),
                        bb=i(bat.get("baseOnBalls")),
                        k=i(bat.get("strikeOuts")),
                        hbp=i(bat.get("hitByPitch")),
                        slot=slot,
                        opp_sp=opp_sp,
                        venue=meta["venue"],
                    )
                )

            if pit and pit.get("battersFaced") is not None:
                pits.append(
                    dict(
                        gamePk=meta["gamePk"],
                        date=meta["date"],
                        season=meta["season"],
                        pitcher_id=pid,
                        name=person.get("fullName", ""),
                        team_id=team_id,
                        opp_team=opp_team,
                        is_home=int(side == "home"),
                        is_starter=int(pid == starter[side]),
                        k=i(pit.get("strikeOuts")),
                        outs=outs_from_ip(pit.get("inningsPitched")),
                        bf=i(pit.get("battersFaced")),
                        h_allowed=i(pit.get("hits")),
                        bb_allowed=i(pit.get("baseOnBalls")),
                        hr_allowed=i(pit.get("homeRuns")),
                        er=i(pit.get("earnedRuns")),
                        venue=meta["venue"],
                    )
                )
    return bats, pits


def main():
    import pandas as pd

    metas = []
    for s in SEASONS:
        g = schedule(s)
        print(f"{s}: {len(g)} final games", flush=True)
        metas += g
    print(f"total games: {len(metas)}", flush=True)

    results = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=24) as ex:
        futs = {ex.submit(boxscore, m["gamePk"]): m for m in metas}
        done = 0
        for fut in as_completed(futs):
            results[futs[fut]["gamePk"]] = fut.result()
            done += 1
            if done % 500 == 0:
                print(f"  {done}/{len(metas)} ({time.time()-t0:.0f}s)", flush=True)

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
