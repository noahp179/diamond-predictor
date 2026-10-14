"""
Shared plumbing for the football-td fetchers: HTTP with retries, raw-summary
archiving, and a lossless-for-the-boxscore compact parse of an ESPN summary.

Not run directly. Imported by fetch_nfl.py, fetch_cfb.py and fetch_rosters.py.

COMPACT BOX FORMAT (data/box/{nfl|cfb}/{event_id}.json, also the fetch cache)
-------------------------------------------------------------------------------
One JSON object per game, `null` if ESPN had no usable box score:

  {
    "event_id": "401772766", "league": "nfl",
    "season": 2025, "season_type": 2, "week": 9,      # from summary header
    "date_utc": "2025-11-02T18:00Z", "neutral": false, "status": "STATUS_FINAL",
    "teams": [                                         # boxscore.players order
      {"team_id": "11", "abbr": "IND", "home_away": "away", "score": 20,
       "athletes": {"<pid>": {"name": "Jonathan Taylor", "jersey": "28"}, ...},
       "categories": {                                 # ESPN order preserved
         "rushing": {"keys": ["rushingAttempts", ...],
                     "athletes": [["<pid>", ["14", "45", "3.2", "0", "9"]], ...],
                     "totals": ["19", "55", ...]},
         "receiving": {...}, "passing": {...}, "fumbles": {...},
         "defensive": {...}, "interceptions": {...}, "kickReturns": {...},
         "puntReturns": {...}, "kicking": {...}, "punting": {...}},
       "team_stats": {"totalYards": "342", "possessionTime": "28:01", ...}},
      {...the other team...}],
    "scoring_plays": [{"type": "Rushing Touchdown", "team_id": "11",
                       "period": 1, "clock": "8:05", "away": 7, "home": 0,
                       "text": "Daniel Jones 1 Yd Rush (Michael Badgley Kick)"}, ...]
  }

Stat cells are kept as ESPN's strings ("31/50", "5-29", "--"); `num()` below is
the conversion every pipeline in the repo uses (first number before a '/').
Category athlete lists keep ESPN's order, which matters: the original research
parsers insert players rushing-first, and the NFL ranker's pair sampling (and
therefore its weights) depends on that row order.
"""
import gzip, json, os, time, urllib.request, random
from datetime import datetime, timedelta, timezone

UA = {"accept": "application/json", "user-agent": "Mozilla/5.0 (research)"}


def get_bytes(url, tries=6, timeout=40):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 404):
                raise
        except Exception as e:  # timeouts, resets
            last = e
        time.sleep(1.0 * (attempt + 1) + random.random())
    raise last


def get_json(url, **kw):
    return json.loads(get_bytes(url, **kw))


def save_raw(path, raw_bytes):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with gzip.open(tmp, "wb", compresslevel=6) as f:
        f.write(raw_bytes)
    os.replace(tmp, path)


def load_raw(path):
    with gzip.open(path, "rb") as f:
        return json.loads(f.read())


def write_json_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def num(v):
    """ESPN stat cells are strings, sometimes 'made/attempts'."""
    try:
        return float(str(v).split("/")[0])
    except Exception:
        return 0.0


def et_date(iso):
    """The league day, exactly as research/cfb/fetch_espn.py computes it
    (fixed UTC-5, so an 8pm ET Saturday kickoff stays on Saturday)."""
    s = str(iso)
    fmt = "%Y-%m-%dT%H:%M%z" if len(s.replace("Z", "")) <= 16 else "%Y-%m-%dT%H:%M:%S%z"
    dt = datetime.strptime(s.replace("Z", "+0000"), fmt)
    return dt.astimezone(timezone(timedelta(hours=-5))).strftime("%Y-%m-%d")


def compact_box(d, league, event_id):
    """Compact, boxscore-lossless parse of one ESPN summary (see module doc)."""
    header = d.get("header") or {}
    comp = (header.get("competitions") or [{}])[0]
    box = (d.get("boxscore") or {}).get("players")
    if not comp or not isinstance(box, list) or not box:
        return None
    ha, scores = {}, {}
    for c in comp.get("competitors", []) or []:
        tid = str((c.get("team") or {}).get("id") or c.get("id") or "")
        ha[tid] = c.get("homeAway")
        try:
            scores[tid] = int(c.get("score")) if str(c.get("score", "")).strip() != "" else None
        except Exception:
            scores[tid] = None
    team_stats = {}
    for tb in (d.get("boxscore") or {}).get("teams") or []:
        tid = str((tb.get("team") or {}).get("id") or "")
        team_stats[tid] = {s.get("name"): s.get("displayValue")
                           for s in tb.get("statistics") or [] if s.get("name")}
    teams = []
    for tb in box:
        t = tb.get("team") or {}
        tid = str(t.get("id") or "")
        athletes, cats = {}, {}
        for cat in tb.get("statistics") or []:
            name = cat.get("name")
            if not name:
                continue
            rows = []
            for a in cat.get("athletes") or []:
                ath = a.get("athlete") or {}
                pid = ath.get("id")
                if not pid:
                    continue
                pid = str(pid)
                if pid not in athletes:
                    athletes[pid] = {"name": ath.get("displayName") or "",
                                     "jersey": ath.get("jersey")}
                rows.append([pid, a.get("stats") or []])
            cats[name] = {"keys": cat.get("keys") or [], "athletes": rows,
                          "totals": cat.get("totals") or []}
        teams.append({
            "team_id": tid, "abbr": t.get("abbreviation"),
            "home_away": ha.get(tid), "score": scores.get(tid),
            "athletes": athletes, "categories": cats,
            "team_stats": team_stats.get(tid, {}),
        })
    sp = []
    for p in d.get("scoringPlays") or []:
        sp.append({
            "type": (p.get("type") or {}).get("text"),
            "team_id": str((p.get("team") or {}).get("id") or ""),
            "period": (p.get("period") or {}).get("number"),
            "clock": (p.get("clock") or {}).get("displayValue"),
            "away": p.get("awayScore"), "home": p.get("homeScore"),
            "text": p.get("text"),
        })
    season = header.get("season") or {}
    return {
        "event_id": str(event_id), "league": league,
        "season": season.get("year"), "season_type": season.get("type"),
        "week": header.get("week"),
        "date_utc": comp.get("date"), "neutral": comp.get("neutralSite") is True,
        "status": ((comp.get("status") or {}).get("type") or {}).get("name"),
        "teams": teams, "scoring_plays": sp,
    }


def usage_from_box(box, rec_key):
    """The research parsers' per-team player usage, rebuilt from a compact box.

    Reproduces parse_summary() in research/nfl-td-scorer/fetch_nfl.py
    (rec_key='receivingTargets') and research/cfb/fetch_espn.py
    (rec_key='receptions') exactly: only the rushing and receiving categories,
    players inserted in ESPN order (rushing first), stats looked up by key."""
    out = []
    for t in box["teams"]:
        if not t.get("abbr"):
            continue
        players = {}
        for name, cat in t["categories"].items():
            if name not in ("rushing", "receiving"):
                continue
            keys = cat["keys"]
            for pid, stats in cat["athletes"]:
                p = players.setdefault(pid, {
                    "id": pid, "name": t["athletes"].get(pid, {}).get("name", ""),
                    "car": 0.0, "rc": 0.0, "ry": 0.0, "cy": 0.0, "rtd": 0.0, "ctd": 0.0,
                })
                lst = stats or [None] * len(keys)
                s = {k: (lst[i] if i < len(lst) else None) for i, k in enumerate(keys)}
                if name == "rushing":
                    p["car"] = num(s.get("rushingAttempts"))
                    p["ry"] = num(s.get("rushingYards"))
                    p["rtd"] = num(s.get("rushingTouchdowns"))
                else:
                    p["rc"] = num(s.get(rec_key))
                    p["cy"] = num(s.get("receivingYards"))
                    p["ctd"] = num(s.get("receivingTouchdowns"))
        pl = list(players.values())
        out.append({
            "abbr": t["abbr"], "id": t["team_id"], "home_away": t["home_away"],
            "players": pl,
            "rushTd": sum(p["rtd"] for p in pl), "recTd": sum(p["ctd"] for p in pl),
        })
    return out


# Wide per-player offensive line, for data/{league}_player_box.csv
PLAYER_BOX_COLS = [
    ("passing", "completions/passingAttempts", "pass_cmp", lambda v: num(v)),
    ("passing", "completions/passingAttempts", "pass_att",
     lambda v: num(str(v).split("/")[1]) if "/" in str(v) else 0.0),
    ("passing", "passingYards", "pass_yds", num),
    ("passing", "passingTouchdowns", "pass_td", num),
    ("passing", "interceptions", "pass_int", num),
    ("passing", "sacks-sackYardsLost", "sacked", lambda v: num(str(v).split("-")[0])),
    ("rushing", "rushingAttempts", "rush_att", num),
    ("rushing", "rushingYards", "rush_yds", num),
    ("rushing", "rushingTouchdowns", "rush_td", num),
    ("rushing", "longRushing", "rush_long", num),
    ("receiving", "receptions", "rec", num),
    ("receiving", "receivingTargets", "tgt", num),
    ("receiving", "receivingYards", "rec_yds", num),
    ("receiving", "receivingTouchdowns", "rec_td", num),
    ("receiving", "longReception", "rec_long", num),
    ("fumbles", "fumbles", "fum", num),
    ("fumbles", "fumblesLost", "fum_lost", num),
    ("kickReturns", "kickReturnTouchdowns", "kr_td", num),
    ("puntReturns", "puntReturnTouchdowns", "pr_td", num),
    ("interceptions", "interceptionTouchdowns", "int_td", num),
    ("defensive", "defensiveTouchdowns", "def_td", num),
]


def player_box_rows(box):
    """One wide row per (team, athlete) with an offensive or return stat line."""
    rows = []
    for t in box["teams"]:
        opp = [x for x in box["teams"] if x is not t]
        opp = opp[0] if opp else {}
        lines = {}
        for cat_name, cat in t["categories"].items():
            keys = cat["keys"]
            for pid, stats in cat["athletes"]:
                s = {k: stats[i] for i, k in enumerate(keys) if i < len(stats)}
                lines.setdefault(pid, {})[cat_name] = s
        for pid, cats in lines.items():
            r = {"event_id": box["event_id"], "team_id": t["team_id"], "team": t["abbr"],
                 "opp_id": opp.get("team_id", ""), "home_away": t["home_away"],
                 "player_id": pid, "player": t["athletes"].get(pid, {}).get("name", ""),
                 "jersey": t["athletes"].get(pid, {}).get("jersey") or ""}
            any_off = False
            for cat_name, key, col, fn in PLAYER_BOX_COLS:
                v = cats.get(cat_name, {}).get(key)
                r[col] = int(fn(v)) if v not in (None, "", "--") else 0
                if v not in (None, "", "--") and cat_name in (
                        "passing", "rushing", "receiving", "fumbles", "kickReturns",
                        "puntReturns", "interceptions"):
                    any_off = True
            if any_off or r["def_td"]:
                rows.append(r)
    return rows
