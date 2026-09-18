"""
Data collection for the NFL touchdown bakeoff.

Two sources, because neither alone is enough:

  nflverse   the schedule, ESPN's game id, and the CLOSING MARKET LINE. That
             last one is why this file exists. The shipped NFL model leans on
             the book's implied team total, and ESPN's own `pickcenter` keeps
             historical lines only patchily — sampled by month, 2021 and 2022
             return a total and spread for every game, 2023 through most of
             2025 for none. nflverse carries spread_line and total_line for
             7,292 completed games with no gaps at all.

  ESPN       the per-game box score: carries, targets, yards, touchdowns.

Rebuilding the market features rather than dropping them is what makes the
bakeoff a fair fight — the challengers get the same 18 features the shipped
model was fitted on, so any difference is the algorithm rather than the inputs.

SPREAD CONVENTION. nflverse `spread_line` is positive when the HOME team is
favoured; ESPN's `spread` is negative in the same situation (book convention).
The live module does its arithmetic in ESPN's convention, so the sign is
flipped here on the way in and every downstream formula matches
nfl-td.server.ts line for line.

Raw JSON is parsed on arrival and only the compact record is cached.
"""
import os, sys, json, csv, time
from concurrent.futures import ThreadPoolExecutor
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache")
os.makedirs(CACHE, exist_ok=True)

ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
NFLVERSE = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SEASONS = [int(s) for s in (sys.argv[1:] or [2021, 2022, 2023, 2024, 2025, 2026])]


def get(url, tries=4, timeout=30):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def schedule():
    """Completed games with an ESPN id and a market line."""
    fp = os.path.join(CACHE, "nflverse_games.csv")
    if not os.path.exists(fp):
        urllib.request.urlretrieve(NFLVERSE, fp)
    out = []
    with open(fp) as f:
        for r in csv.DictReader(f):
            try:
                season = int(r["season"])
            except (ValueError, KeyError):
                continue
            if season not in SEASONS or not r.get("espn") or r.get("result") in ("", None):
                continue
            try:
                spread_line = float(r["spread_line"])
                total = float(r["total_line"])
                hs, as_ = int(r["home_score"]), int(r["away_score"])
            except (ValueError, KeyError, TypeError):
                continue
            out.append({
                "game_id": str(r["espn"]),
                "season": season,
                "week": int(r["week"]),
                "date": r["gameday"],
                "home": r["home_team"],
                "away": r["away_team"],
                "home_score": hs,
                "away_score": as_,
                # ESPN convention: negative when the home team is favoured.
                "home_spread": -spread_line,
                "total": total,
            })
    out.sort(key=lambda g: (g["date"], g["game_id"]))
    return out


def num(v):
    try:
        return float(str(v).split("/")[0])
    except Exception:
        return 0.0


def parse_summary(d):
    """Per-team player usage. NFL box scores DO carry receivingTargets, which
    college's do not — so target share is available here and the feature set
    matches the shipped model rather than substituting receptions."""
    comp = ((d.get("header") or {}).get("competitions") or [{}])[0]
    box = (d.get("boxscore") or {}).get("players")
    if not comp or not isinstance(box, list) or len(box) != 2:
        return None
    home_abbr = None
    for c in comp.get("competitors", []):
        if c.get("homeAway") == "home":
            home_abbr = (c.get("team") or {}).get("abbreviation")
    teams = []
    for tb in box:
        abbr = (tb.get("team") or {}).get("abbreviation")
        if not abbr:
            continue
        players = {}
        for cat in tb.get("statistics") or []:
            keys = cat.get("keys") or []
            name = cat.get("name")
            if name not in ("rushing", "receiving"):
                continue
            for a in cat.get("athletes") or []:
                ath = a.get("athlete") or {}
                pid = ath.get("id")
                if not pid:
                    continue
                p = players.setdefault(str(pid), {
                    "id": str(pid), "name": ath.get("displayName") or "",
                    "car": 0.0, "tgt": 0.0, "ry": 0.0, "cy": 0.0, "rtd": 0.0, "ctd": 0.0,
                })
                s = {k: (a.get("stats") or [None] * len(keys))[i] for i, k in enumerate(keys)}
                if name == "rushing":
                    p["car"] = num(s.get("rushingAttempts"))
                    p["ry"] = num(s.get("rushingYards"))
                    p["rtd"] = num(s.get("rushingTouchdowns"))
                else:
                    p["tgt"] = num(s.get("receivingTargets"))
                    p["cy"] = num(s.get("receivingYards"))
                    p["ctd"] = num(s.get("receivingTouchdowns"))
        pl = list(players.values())
        teams.append({
            "abbr": abbr, "isHome": abbr == home_abbr, "players": pl,
            "rushTd": sum(p["rtd"] for p in pl), "recTd": sum(p["ctd"] for p in pl),
        })
    return {"teams": teams} if len(teams) == 2 else None


def fetch_box(gid):
    fp = os.path.join(CACHE, f"box_{gid}.json")
    if os.path.exists(fp):
        try:
            return json.load(open(fp))
        except Exception:
            pass
    v = None
    try:
        v = parse_summary(get(f"{ESPN}/summary?event={gid}"))
    except Exception as e:
        print(f"  ! box {gid}: {str(e)[:60]}", flush=True)
    json.dump(v, open(fp, "w"))
    return v


def main():
    games = schedule()
    print(f"{len(games)} completed games with an ESPN id and a market line", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        boxes = list(ex.map(lambda g: fetch_box(g["game_id"]), games))
    ok = sum(1 for b in boxes if b)
    print(f"{ok}/{len(games)} box scores parsed in {time.time()-t0:.0f}s", flush=True)

    grows, prows = [], []
    for g, b in zip(games, boxes):
        grows.append({k: g[k] for k in ("game_id", "season", "week", "date", "home", "away",
                                        "home_score", "away_score", "home_spread", "total")})
        if not b:
            continue
        # ESPN abbreviations and nflverse's do not always agree (LA/LAR, WSH/WAS),
        # so sides are matched by the box score's own home flag, never by name.
        for t in b["teams"]:
            opp = [x for x in b["teams"] if x is not t][0]
            prows.append({
                "game_id": g["game_id"], "season": g["season"], "week": g["week"],
                "date": g["date"], "team": g["home"] if t["isHome"] else g["away"],
                "is_home": int(t["isHome"]),
                "team_rush_td": int(t["rushTd"]), "team_rec_td": int(t["recTd"]),
                "opp_rush_td": int(opp["rushTd"]), "opp_rec_td": int(opp["recTd"]),
                "player_id": "", "player": "", "car": 0, "tgt": 0,
                "rush_yds": 0, "rec_yds": 0, "rush_td": 0, "rec_td": 0, "scored": 0,
            })
            # one row per player, plus the team row above carrying team totals
            for p in t["players"]:
                if p["car"] + p["tgt"] <= 0:
                    continue
                prows.append({
                    "game_id": g["game_id"], "season": g["season"], "week": g["week"],
                    "date": g["date"], "team": g["home"] if t["isHome"] else g["away"],
                    "is_home": int(t["isHome"]),
                    "team_rush_td": int(t["rushTd"]), "team_rec_td": int(t["recTd"]),
                    "opp_rush_td": int(opp["rushTd"]), "opp_rec_td": int(opp["recTd"]),
                    "player_id": p["id"], "player": p["name"],
                    "car": int(p["car"]), "tgt": int(p["tgt"]),
                    "rush_yds": int(p["ry"]), "rec_yds": int(p["cy"]),
                    "rush_td": int(p["rtd"]), "rec_td": int(p["ctd"]),
                    "scored": int(p["rtd"] + p["ctd"] > 0),
                })

    def write(name, rows):
        with open(os.path.join(DATA, name), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {name}: {len(rows):,} rows", flush=True)

    write("nfl_games.csv", grows)
    write("nfl_player_games.csv", [r for r in prows if r["player_id"]])


if __name__ == "__main__":
    main()
