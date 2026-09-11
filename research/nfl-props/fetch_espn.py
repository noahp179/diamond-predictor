"""
Data collection for the NFL player-prop backtest.

One source, ESPN's public API, because it is the same source the app reads at
runtime — a model trained on numbers the app cannot rebuild live is a model the
app cannot serve.

  scoreboard?dates=YYYY&seasontype=2&week=N  -> the regular-season game list
  summary?event=<id>                         -> box score, market line, injuries

Three tidy tables come out, one row per (game, player), (game, team) and game:

  player_games.csv  carries/targets/receptions/yards/TDs + pass line for QBs
  team_games.csv    team offensive volume and what the defense allowed
  games.csv         date, week, home/away, final score, closing total + spread

Raw JSON is cached under a scratch dir so re-runs are instant and resumable;
only the compact CSVs land in the repo (and research/*/data is gitignored, so
regenerate with this script rather than committing them).
"""
import os, sys, json, csv, time
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

SEASONS = [int(s) for s in (sys.argv[1:] or ["2021", "2022", "2023", "2024", "2025"])]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
CACHE_DIR = os.environ.get("ESPN_CACHE", "/tmp/nflprops-cache")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
SESSION = requests.Session()
SESSION.headers.update({"accept": "application/json"})


def get(url, tries=4):
    for i in range(tries):
        try:
            r = SESSION.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def cached_summary(eid):
    fp = os.path.join(CACHE_DIR, f"{eid}.json")
    if os.path.exists(fp):
        try:
            with open(fp) as f:
                return json.load(f)
        except Exception:
            pass
    d = get(f"{BASE}/summary?event={eid}")
    if d is not None:
        with open(fp, "w") as f:
            json.dump(d, f)
    return d


def game_list(season):
    """Every completed regular-season game in a season, with its week."""
    out = []
    for week in range(1, 19):
        d = get(f"{BASE}/scoreboard?dates={season}&seasontype=2&week={week}&limit=100")
        if not d:
            continue
        for ev in d.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            st = ((comp.get("status") or {}).get("type") or {})
            if not st.get("completed"):
                continue
            out.append({"eid": ev["id"], "season": season, "week": week, "date": ev.get("date", "")})
    return out


def num(v):
    try:
        return float(str(v).split("/")[0].replace(",", ""))
    except Exception:
        return 0.0


def parse(meta, d):
    """(player rows, team rows, game row) for one game, or None if unusable."""
    if not d:
        return None
    comp = ((d.get("header") or {}).get("competitions") or [{}])[0]
    box = (d.get("boxscore") or {}).get("players")
    if not comp or not isinstance(box, list) or len(box) != 2:
        return None

    sides = {}
    for c in comp.get("competitors", []):
        sides[c.get("team", {}).get("abbreviation")] = {
            "home": c.get("homeAway") == "home",
            "score": num(c.get("score")),
        }
    if len(sides) != 2:
        return None
    abbrs = list(sides)

    # closing market line: pickcenter carries the pre-game number for both
    # upcoming and finished games (the core odds feed empties out once old).
    total = spread = ""
    for it in d.get("pickcenter") or []:
        if isinstance(it.get("overUnder"), (int, float)) and isinstance(it.get("spread"), (int, float)):
            total, spread = it["overUnder"], it["spread"]  # spread is the HOME spread
            break

    players, teams = [], []
    for tb in box:
        abbr = (tb.get("team") or {}).get("abbreviation")
        if abbr not in sides:
            return None
        opp = abbrs[0] if abbrs[1] == abbr else abbrs[1]
        by_id = {}
        for cat in tb.get("statistics") or []:
            name, keys = cat.get("name"), cat.get("keys") or []
            if name not in ("passing", "rushing", "receiving"):
                continue
            for a in cat.get("athletes") or []:
                ath = a.get("athlete") or {}
                pid = ath.get("id")
                if not pid:
                    continue
                row = by_id.setdefault(pid, {
                    "player_id": pid, "player": ath.get("displayName", ""),
                    "car": 0.0, "ry": 0.0, "rtd": 0.0,
                    "tgt": 0.0, "rec": 0.0, "cy": 0.0, "ctd": 0.0,
                    "patt": 0.0, "cmp": 0.0, "py": 0.0, "ptd": 0.0, "intc": 0.0,
                })
                s = dict(zip(keys, a.get("stats") or []))
                if name == "rushing":
                    row["car"], row["ry"], row["rtd"] = (
                        num(s.get("rushingAttempts")), num(s.get("rushingYards")),
                        num(s.get("rushingTouchdowns")))
                elif name == "receiving":
                    row["rec"], row["cy"], row["ctd"], row["tgt"] = (
                        num(s.get("receptions")), num(s.get("receivingYards")),
                        num(s.get("receivingTouchdowns")), num(s.get("receivingTargets")))
                elif name == "passing":
                    ca = str(s.get("completions/passingAttempts") or "0/0").split("/")
                    row["cmp"], row["patt"] = num(ca[0]), num(ca[1] if len(ca) > 1 else 0)
                    row["py"], row["ptd"], row["intc"] = (
                        num(s.get("passingYards")), num(s.get("passingTouchdowns")),
                        num(s.get("interceptions")))
        rows = list(by_id.values())
        for r in rows:
            r.update(eid=meta["eid"], season=meta["season"], week=meta["week"],
                     date=meta["date"][:10], team=abbr, opp=opp,
                     is_home=int(sides[abbr]["home"]))
        players += rows
        teams.append({
            "eid": meta["eid"], "season": meta["season"], "week": meta["week"],
            "date": meta["date"][:10], "team": abbr, "opp": opp,
            "is_home": int(sides[abbr]["home"]), "pts": sides[abbr]["score"],
            "car": sum(r["car"] for r in rows), "ry": sum(r["ry"] for r in rows),
            "tgt": sum(r["tgt"] for r in rows), "rec": sum(r["rec"] for r in rows),
            "cy": sum(r["cy"] for r in rows), "patt": sum(r["patt"] for r in rows),
            "py": sum(r["py"] for r in rows),
            "rtd": sum(r["rtd"] for r in rows), "ctd": sum(r["ctd"] for r in rows),
        })

    game = {"eid": meta["eid"], "season": meta["season"], "week": meta["week"],
            "date": meta["date"][:10], "total": total, "home_spread": spread,
            "home": next(a for a in abbrs if sides[a]["home"]),
            "away": next(a for a in abbrs if not sides[a]["home"])}
    return players, teams, game


CORE_ODDS = ("https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
             "/events/{eid}/competitions/{eid}/odds")


def is_live_book(name):
    """In-play books quote a different game. A 24-7 fourth quarter reads -910
    live against +180 pre-game, and only the pre-game number describes the
    matchup the model is asked about."""
    n = (name or "").lower()
    return "live" in n or "in-play" in n or "in play" in n


def core_odds(eid):
    """Pre-game total and home spread from the core odds feed.

    The game summary's `pickcenter` is the first choice, but it empties out for
    older games and its coverage is patchy by season (2024 has none at all).
    The core feed still carries them, so it backfills the gap rather than
    leaving four fifths of one season without a line.
    """
    fp = os.path.join(CACHE_DIR, f"odds-{eid}.json")
    d = None
    if os.path.exists(fp):
        try:
            with open(fp) as f:
                d = json.load(f)
        except Exception:
            d = None
    if d is None:
        d = get(CORE_ODDS.format(eid=eid))
        if d is not None:
            with open(fp, "w") as f:
                json.dump(d, f)
    if not d:
        return None
    for it in d.get("items") or []:
        if is_live_book((it.get("provider") or {}).get("name")):
            continue
        ou, sp = it.get("overUnder"), it.get("spread")
        if isinstance(ou, (int, float)) and isinstance(sp, (int, float)):
            return ou, sp
    return None


def backfill_odds(games):
    missing = [g for g in games if not g["total"]]
    if not missing:
        return
    print(f"backfilling market lines for {len(missing)} games")
    filled = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(core_odds, g["eid"]): g for g in missing}
        for fut in as_completed(futs):
            got = fut.result()
            if got:
                futs[fut]["total"], futs[fut]["home_spread"] = got
                filled += 1
    have = sum(1 for g in games if g["total"])
    print(f"  filled {filled}; {have}/{len(games)} games now carry a line")


def write(path, rows):
    if not rows:
        return
    cols = list(rows[0].keys())
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"  {os.path.basename(path)}: {len(rows):,} rows")


def main():
    metas = []
    for s in SEASONS:
        g = game_list(s)
        print(f"season {s}: {len(g)} completed games")
        metas += g

    players, teams, games = [], [], []
    done = skipped = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(cached_summary, m["eid"]): m for m in metas}
        for fut in as_completed(futs):
            m = futs[fut]
            out = parse(m, fut.result())
            done += 1
            if out is None:
                skipped += 1
                continue
            p, t, g = out
            players += p
            teams += t
            games.append(g)
            if done % 200 == 0:
                print(f"  parsed {done}/{len(metas)}")
    print(f"parsed {done} games ({skipped} unusable)")

    players.sort(key=lambda r: (r["date"], r["eid"], r["team"], r["player_id"]))
    teams.sort(key=lambda r: (r["date"], r["eid"], r["team"]))
    backfill_odds(games)
    games.sort(key=lambda r: (r["date"], r["eid"]))
    write(os.path.join(DATA_DIR, "player_games.csv"), players)
    write(os.path.join(DATA_DIR, "team_games.csv"), teams)
    write(os.path.join(DATA_DIR, "games.csv"), games)


if __name__ == "__main__":
    main()
