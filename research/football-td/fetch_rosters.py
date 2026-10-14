"""
Player positions (and CFB season rosters) for the football-td deliverables.

    python3 research/football-td/fetch_rosters.py nfl   # after fetch_nfl.py
    python3 research/football-td/fetch_rosters.py cfb   # after fetch_cfb.py

NFL  ESPN's team-roster endpoint ignores `season` for the NFL (it returns the
     current roster), so positions come from nflverse's players.csv, which
     carries ESPN ids (espn_id -> position). Any player in
     data/nfl_player_box.csv (2024-2026) it does not cover is looked up on
     ESPN's athlete endpoint.
       -> data/nfl_positions.csv  player_id, player, position, source

CFB  ESPN's v3 roster endpoint does honour `season` for college, so every team
     on the 2024, 2025 and 2026 FBS schedules (FCS opponents included) is read
     for each season it played.
       -> data/cfb_rosters.csv    season, team_id, player_id, player, position,
                                  jersey, experience (class)
     Positions are taken from the latest season a player appears in; players in
     data/cfb_player_box.csv (2024-2026) missing from every roster fall back to
     the athlete endpoint.
       -> data/cfb_positions.csv  player_id, player, position, source
"""
import os, sys, csv, json, urllib.request
from concurrent.futures import ThreadPoolExecutor
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")
ROSTER_CACHE = os.path.join(CACHE, "cfb_rosters")
ATH_CACHE = os.path.join(CACHE, "athletes")
for d in (CACHE, ROSTER_CACHE, ATH_CACHE):
    os.makedirs(d, exist_ok=True)

NFLVERSE_PLAYERS = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
V3 = "https://site.web.api.espn.com/apis/common/v3/sports/football"


def athlete(league, pid):
    """(name, position) from ESPN's athlete endpoint, cached compactly."""
    fp = os.path.join(ATH_CACHE, f"{league}_{pid}.json")
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        a = C.get_json(f"{V3}/{league}/athletes/{pid}").get("athlete") or {}
        v = {"name": a.get("displayName") or "",
             "position": (a.get("position") or {}).get("abbreviation") or ""}
    except Exception as e:
        v = {"name": "", "position": "", "error": str(e)[:60]}
    C.write_json_atomic(fp, v)
    return v


def nfl():
    fp = os.path.join(CACHE, "nflverse_players.csv")
    if not os.path.exists(fp):
        urllib.request.urlretrieve(NFLVERSE_PLAYERS, fp + ".tmp")
        os.replace(fp + ".tmp", fp)
    pv = pd.read_csv(fp, dtype=str, low_memory=False)
    pv = pv[pv.espn_id.notna()]
    pmap = {r.espn_id.split(".")[0]: (r.display_name, r.position) for r in pv.itertuples()}
    box = pd.read_csv(os.path.join(DATA, "nfl_player_box.csv"), dtype={"player_id": str})
    box = box[box.season >= 2024]
    ids = box.drop_duplicates("player_id")[["player_id", "player"]]
    rows, missing = [], []
    for r in ids.itertuples():
        if r.player_id in pmap and isinstance(pmap[r.player_id][1], str):
            rows.append({"player_id": r.player_id, "player": r.player,
                         "position": pmap[r.player_id][1], "source": "nflverse"})
        else:
            missing.append((r.player_id, r.player))
    print(f"nfl: {len(rows)} positions from nflverse, {len(missing)} via ESPN athlete endpoint")
    with ThreadPoolExecutor(8) as ex:
        got = list(ex.map(lambda m: athlete("nfl", m[0]), missing))
    for (pid, name), v in zip(missing, got):
        rows.append({"player_id": pid, "player": name, "position": v.get("position", ""),
                     "source": "espn_athlete" if v.get("position") else "missing"})
    pd.DataFrame(rows).to_csv(os.path.join(DATA, "nfl_positions.csv"), index=False)
    print(f"wrote data/nfl_positions.csv: {len(rows)} players, "
          f"{sum(1 for r in rows if not r['position'])} without a position")


def cfb_roster(season, tid):
    fp = os.path.join(ROSTER_CACHE, f"{season}_{tid}.json")
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = C.get_json(f"{V3}/college-football/teams/{tid}/roster?season={season}")
    except Exception as e:
        return {"error": str(e)[:80], "athletes": []}
    out = []
    for g in d.get("positionGroups") or []:
        for a in g.get("athletes") or []:
            out.append({
                "player_id": str(a.get("id")), "player": a.get("displayName") or "",
                "position": (a.get("position") or {}).get("abbreviation") or "",
                "jersey": a.get("jersey") or "",
                "experience": ((a.get("experience") or {}).get("abbreviation")
                               or (a.get("experience") or {}).get("displayValue") or ""),
                "group": g.get("type"),
            })
    v = {"season": (d.get("season") or {}).get("year"), "athletes": out}
    C.write_json_atomic(fp, v)
    return v


def cfb():
    jobs = set()
    for s in (2024, 2025, 2026):
        fp = os.path.join(CACHE, f"sched_{s}.json")
        if not os.path.exists(fp):
            continue
        for g in json.load(open(fp)):
            jobs.add((s, g["home"]["id"]))
            jobs.add((s, g["away"]["id"]))
    jobs = sorted(jobs)
    print(f"cfb: {len(jobs)} team-season rosters")
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda j: cfb_roster(*j), jobs))
    rows = []
    errs = 0
    for (s, tid), v in zip(jobs, res):
        if v.get("error"):
            errs += 1
        for a in v.get("athletes", []):
            rows.append({"season": s, "team_id": tid, **a})
    ro = pd.DataFrame(rows)
    ro.to_csv(os.path.join(DATA, "cfb_rosters.csv"), index=False)
    print(f"wrote data/cfb_rosters.csv: {len(ro):,} rows ({errs} roster errors)")

    latest = (ro[ro.position != ""].sort_values("season")
              .drop_duplicates("player_id", keep="last").set_index("player_id"))
    box = pd.read_csv(os.path.join(DATA, "cfb_player_box.csv"), dtype={"player_id": str})
    box = box[box.season >= 2024]
    ids = box.drop_duplicates("player_id")[["player_id", "player"]]
    out, missing = [], []
    for r in ids.itertuples():
        if r.player_id in latest.index:
            out.append({"player_id": r.player_id, "player": r.player,
                        "position": latest.loc[r.player_id, "position"], "source": "roster"})
        else:
            missing.append((r.player_id, r.player))
    print(f"cfb: {len(out)} positions from rosters, {len(missing)} via athlete endpoint")
    with ThreadPoolExecutor(8) as ex:
        got = list(ex.map(lambda m: athlete("college-football", m[0]), missing))
    for (pid, name), v in zip(missing, got):
        out.append({"player_id": pid, "player": name, "position": v.get("position", ""),
                    "source": "espn_athlete" if v.get("position") else "missing"})
    pd.DataFrame(out).to_csv(os.path.join(DATA, "cfb_positions.csv"), index=False)
    print(f"wrote data/cfb_positions.csv: {len(out)} players, "
          f"{sum(1 for r in out if not r['position'])} without a position")


if __name__ == "__main__":
    which = sys.argv[1:] or ["nfl", "cfb"]
    if "nfl" in which:
        nfl()
    if "cfb" in which:
        cfb()
