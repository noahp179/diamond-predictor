"""
Who scored each game's FIRST touchdown, NFL and college.

    OMP_NUM_THREADS=2 python3 research/football-td/fetch_first_td.py [nfl] [cfb]
    (after fetch_nfl.py / fetch_cfb.py)

Two sources, each checked against the other where both exist:

  summary   from what is already on disk. With a raw summary
            (data/raw/{league}/{id}.json.gz) the first touchdown is the drive
            play with scoringPlay and scoringType "touchdown" that has the lowest
            sequenceNumber — the drives, not `scoringPlays`, because
            `scoringPlays` can OMIT a defensive fumble-return touchdown (e.g.
            NFL 401772730, 401872925: a Q1 strip-sack return is in the drives
            and in the core feed but not in scoringPlays). Without a raw file
            (NFL 2021-23) the compact box's `scoringPlays` is used. The scorer
            is named only in text ("Daniel Jones 1 Yd Rush (...)"), so the name
            before "<n> Yd" is matched against the scoring team's box-score
            athletes (case/punctuation/suffix-insensitive, unique match only).

  core      ESPN's core play feed, the label source of the shipped td1 model
            (research/nfl-td-scorer/fetch_first_td.py):
            sports.core.api.espn.com/.../events/{id}/competitions/{id}/plays —
            the lowest-sequence touchdown play's `scorer` participant (an
            athlete id, no name matching); offensive when the scorer is also
            the rusher or receiver.

NFL uses the core feed for EVERY game (so the td1 labels are the shipped
model's labels; the summary result is kept in summary_player_id /
summary_agrees). College uses the summary and falls back to the core feed only
when the summary cannot be resolved to an athlete id.

KIND: "offense" (rushing/receiving TD by the rusher/receiver — the players the
TD models price), "defense/special teams" (interception / fumble / kick / punt
/ blocked-kick returns, fumble recoveries, laterals), "none" (no touchdown).

Outputs (one row per game)
  data/nfl_first_td.csv   NFL 2021-2026, every game in data/nfl_games.csv
                          (2021-23 are td1 training labels; 2024-26 have raw)
  data/cfb_first_td.csv   college, every game with a raw summary (2024-2026)
columns: event_id, season, date, first_td_player_id, first_td_player,
         first_td_team_id, kind, play_type, period, clock, text, source
         (core_plays | summary_text | summary | unresolved), summary_player_id,
         summary_agrees (1/0 where both sources ran)
"""
import os, sys, csv, json, re, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

DATA = os.path.join(HERE, "data")
LEAGUE_PATH = {"nfl": "nfl", "cfb": "college-football"}
OFFENSIVE_TYPES = ("rushing touchdown", "passing touchdown")


def offensive_type(typ):
    """Summary play types for a rushing/receiving TD. College summaries also use
    plain "Rush", "Pass Reception", "Pass Completion" for scoring plays."""
    t = str(typ).lower()
    return bool(re.search(r"rush|pass", t)) and not re.search(
        r"return|fumble|interception|punt|kick|blocked|safety", t)
SUFFIX = {"jr", "sr", "ii", "iii", "iv", "v"}


def norm(name):
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z ]", " ", s.replace(".", "").replace("'", ""))
    return " ".join(w for w in s.split() if w not in SUFFIX)


def scorer_name(text):
    t = str(text or "").strip()
    m = re.match(r"^(.+?)\s+-?\d+\s*(?:Yd|Yds|Yard|Yards)\b", t, re.I)
    if not m:
        m = re.match(r"^(.+?)\s+(?:Fumble|Interception|Kickoff|Punt|Blocked|Recovered|Run|Pass)\b",
                     t, re.I)
    return m.group(1).strip() if m else None


def match(box, tid, name):
    if not name:
        return None
    n = norm(name)
    teams = [t for t in box["teams"] if t["team_id"] == str(tid)] or box["teams"]
    hits = {pid for t in teams for pid, a in t["athletes"].items() if norm(a.get("name")) == n}
    if len(hits) == 1:
        return hits.pop()
    # "A.J." vs "AJ", initials: first initial + last name, unique on the team
    parts = n.split()
    if len(parts) >= 2:
        hits = {pid for t in teams for pid, a in t["athletes"].items()
                if norm(a.get("name")).split()[-1:] == parts[-1:]
                and norm(a.get("name"))[:1] == parts[0][:1]}
        if len(hits) == 1:
            return hits.pop()
    return None


def core_scorer(league, gid):
    """First touchdown from ESPN's core play feed (cached): scorer id via the
    `scorer` participant, offensive if he is also the rusher/receiver."""
    fp = os.path.join(DATA, "cache", f"first_td_core_{league}", f"{gid}.json")
    if os.path.exists(fp):
        v = json.load(open(fp))
        if "offensive" in v:
            return v
    core = f"https://sports.core.api.espn.com/v2/sports/football/leagues/{LEAGUE_PATH[league]}"
    url = f"{core}/events/{gid}/competitions/{gid}/plays?limit=400"
    out = {"had_td": 0, "scorer_id": None, "team_id": None, "offensive": None,
           "play_type": None, "seq": None, "period": None, "clock": None, "text": None}
    try:
        d = C.get_json(url)
        items = d.get("items", []) or []
        for p in range(2, min(int(d.get("pageCount") or 1), 6) + 1):
            items += (C.get_json(url + f"&page={p}").get("items", []) or [])
        tds = [x for x in items if x.get("scoringPlay")
               and (x.get("scoringType") or {}).get("name") == "touchdown"]
        if tds:
            first = min(tds, key=lambda x: int(x.get("sequenceNumber") or 0))
            roles = {}
            for pt in first.get("participants") or []:
                ref = (pt.get("athlete") or {}).get("$ref", "")
                if "/athletes/" in ref:
                    roles[pt.get("type")] = ref.split("/athletes/")[1].split("?")[0]
            sid = roles.get("scorer")
            ref = (first.get("team") or {}).get("$ref", "")
            out.update({
                "had_td": 1, "scorer_id": sid,
                "team_id": ref.split("/teams/")[1].split("?")[0] if "/teams/" in ref else None,
                "offensive": int(any(r in ("rusher", "receiver") and roles[r] == sid
                                     for r in roles)) if sid else 0,
                "play_type": (first.get("type") or {}).get("text"),
                "seq": int(first.get("sequenceNumber") or 0),
                "period": (first.get("period") or {}).get("number"),
                "clock": (first.get("clock") or {}).get("displayValue"),
                "text": first.get("text")})
    except Exception as e:
        out["error"] = str(e)[:80]
        return out
    C.write_json_atomic(fp, out)
    return out


def summary_first(league, gid, box):
    """First touchdown from the summary: the raw summary's drive plays in
    sequence order when the raw file is on disk (they include defensive
    fumble-return TDs that `scoringPlays` sometimes omits), otherwise the
    compact box's `scoringPlays`. Returns (play_type, team_id, text, period,
    clock, in_scoring_plays) or None."""
    sps = [s for s in box.get("scoring_plays", [])
           if "touchdown" in str(s.get("type", "")).lower()]
    rp = os.path.join(DATA, "raw", league, f"{gid}.json.gz")
    if os.path.exists(rp):
        d = C.load_raw(rp)
        plays = [p for dr in ((d.get("drives") or {}).get("previous") or [])
                 for p in dr.get("plays", []) or []]
        tds = [p for p in plays if p.get("scoringPlay")
               and (p.get("scoringType") or {}).get("name") == "touchdown"]
        if tds:
            first = min(tds, key=lambda p: int(p.get("sequenceNumber") or 0))
            by_id = {str(s.get("id")): s for s in (d.get("scoringPlays") or [])}
            s = by_id.get(str(first.get("id")))
            if s is not None:
                return (str((s.get("type") or {}).get("text", "")),
                        str((s.get("team") or {}).get("id", "")), s.get("text"),
                        (s.get("period") or {}).get("number"),
                        (s.get("clock") or {}).get("displayValue"), True)
            return (str((first.get("type") or {}).get("text", "")), None, first.get("text"),
                    (first.get("period") or {}).get("number"),
                    (first.get("clock") or {}).get("displayValue"), False)
        if plays:
            return None
    if sps:
        s = sps[0]
        return (str(s.get("type", "")), s.get("team_id", ""), s.get("text"),
                s.get("period", ""), s.get("clock", ""), True)
    return None


def resolve(league, gid, season, date):
    """Summary first; the core play feed for every NFL game (the label source
    of the shipped td1 model) and for any college game the summary cannot
    resolve to an athlete id."""
    box = json.load(open(os.path.join(DATA, "box", league, f"{gid}.json")))
    rec = {"event_id": gid, "season": season, "date": date, "first_td_player_id": "",
           "first_td_player": "", "first_td_team_id": "", "kind": "none", "play_type": "",
           "period": "", "clock": "", "text": "", "source": "summary",
           "summary_player_id": "", "summary_agrees": ""}
    if not box:
        rec["kind"], rec["source"] = "unknown", "no_box"
        return rec
    sf = summary_first(league, gid, box)
    spid = None
    if sf is not None:
        typ, tid, text, per, clk, in_sp = sf
        spid = match(box, tid, scorer_name(text)) if tid else None
        rec.update({"first_td_team_id": tid or "", "play_type": typ, "period": per,
                    "clock": clk, "text": text, "source": "summary_text",
                    "kind": "offense" if offensive_type(typ) else "defense/special teams"})
        rec["summary_player_id"] = spid or ""
    use_core = league == "nfl" or (sf is not None and spid is None)
    if use_core:
        c = core_scorer(league, gid)
        if c.get("error"):
            rec["source"] = "summary_text" if spid else "unresolved"
        elif c.get("had_td"):
            rec.update({"first_td_player_id": c.get("scorer_id") or "",
                        "first_td_team_id": c.get("team_id") or rec["first_td_team_id"],
                        "play_type": c.get("play_type") or rec["play_type"],
                        "period": c.get("period"), "clock": c.get("clock"),
                        "text": c.get("text") or rec["text"], "source": "core_plays",
                        "kind": "offense" if c.get("offensive") else "defense/special teams"})
        elif sf is None:
            rec["source"] = "core_plays"
    if rec["source"] == "summary_text":
        rec["first_td_player_id"] = spid or ""
        if not spid:
            rec["source"] = "unresolved"
    if rec["source"] == "core_plays" and sf is not None:
        rec["summary_agrees"] = int(str(rec["summary_player_id"]) == str(rec["first_td_player_id"]))
    pid = rec["first_td_player_id"]
    if pid:
        for t in box["teams"]:
            a = t["athletes"].get(str(pid))
            if a:
                rec["first_td_player"] = a.get("name", "")
    return rec


def games_for(league):
    if league == "nfl":
        with open(os.path.join(DATA, "nfl_games.csv")) as f:
            return [(r["game_id"], int(r["season"]), r["date"]) for r in csv.DictReader(f)]
    raw = {fn.split(".")[0] for fn in os.listdir(os.path.join(DATA, "raw", "cfb"))}
    with open(os.path.join(DATA, "games.csv")) as f:
        return [(r["game_id"], int(r["season"]), r["date"]) for r in csv.DictReader(f)
                if r["game_id"] in raw]


def main():
    for league in (sys.argv[1:] or ["nfl", "cfb"]):
        os.makedirs(os.path.join(DATA, "cache", f"first_td_core_{league}"), exist_ok=True)
        from concurrent.futures import ThreadPoolExecutor
        gl = games_for(league)
        with ThreadPoolExecutor(4) as ex:   # network-bound; CPU kept light
            recs = list(ex.map(lambda g: resolve(league, *g), gl))
        cols = ["event_id", "season", "date", "first_td_player_id", "first_td_player",
                "first_td_team_id", "kind", "play_type", "period", "clock", "text", "source",
                "summary_player_id", "summary_agrees"]
        out = os.path.join(DATA, f"{league}_first_td.csv")
        with open(out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(recs)
        count = lambda k: {v: sum(1 for r in recs if r[k] == v) for v in sorted({r[k] for r in recs})}
        print(f"[{league}] wrote {out}: {len(recs)} games; kind {count('kind')}; "
              f"source {count('source')}", flush=True)


if __name__ == "__main__":
    main()
