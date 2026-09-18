"""
Who scored the FIRST touchdown of each game.

The box score says how many touchdowns a player scored; it says nothing about
when. First-touchdown-scorer is a different market and needs the ordering, so
this pulls play-by-play.

WHERE THE ORDERING LIVES, AND WHY NOT THE OBVIOUS PLACE
--------------------------------------------------------
The summary endpoint carries `scoringPlays` in order, but identifies the scorer
only inside free text — "Derrick Henry 5 Yd Run (Justin Tucker Kick)". Matching
that back to a roster by name is exactly the thing this project refuses to do
elsewhere: the touchdown ledger settles on ESPN athlete id precisely because
names are unreliable, and a silent mismatch here would poison the label rather
than fail loudly.

The core API's play feed carries participants with athlete REFS, and every
touchdown play has an explicit participant of type `scorer`:

    D.Henry right guard for 5 yards, TOUCHDOWN
      [('rusher', '3043078'), ('scorer', '3043078'), ('kicker', '15683'), ...]
    L.Jackson pass deep right to I.Likely
      [('passer', '3916387'), ('receiver', '4361050'), ('scorer', '4361050'), ...]

So the scorer is read directly for both rushing and receiving touchdowns, with
no parsing and no name matching.

DEFENSIVE AND RETURN TOUCHDOWNS are recorded rather than dropped. A pick-six or
a kick return opening the scoring means NO candidate on the board could have
been the first scorer, and a model trained on games where that was quietly
deleted would be fitted on a filtered world and would overstate every pick. The
`scorer_offensive` flag carries it through.
"""
import os, sys, json, csv, time
from concurrent.futures import ThreadPoolExecutor
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.path.join(DATA, "cache", "plays")
os.makedirs(CACHE, exist_ok=True)

CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
# The roles that mean the scorer carried or caught it. Anything else on a
# touchdown play (an interception return, a fumble recovery, a kick return) is
# a scorer the offensive board never had a candidate for.
OFFENSIVE_ROLES = {"rusher", "receiver"}


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


def athlete_id(ref):
    return ref.split("/athletes/")[1].split("?")[0] if "/athletes/" in ref else None


def first_td(game_id):
    """The first touchdown of one game, as a compact record. Cached."""
    fp = os.path.join(CACHE, f"{game_id}.json")
    if os.path.exists(fp):
        with open(fp) as f:
            return json.load(f)
    url = f"{CORE}/events/{game_id}/competitions/{game_id}/plays?limit=400"
    rec = {"game_id": game_id, "scorer_id": None, "scorer_team_id": None,
           "seq": None, "kind": None, "scorer_offensive": 0, "had_td": 0}
    try:
        d = get(url)
        items = d.get("items", []) or []
        # more than one page is possible on a long overtime game
        pages = int(d.get("pageCount") or 1)
        for p in range(2, min(pages, 4) + 1):
            items += (get(url + f"&page={p}").get("items", []) or [])
        tds = [
            x for x in items
            if x.get("scoringPlay") and (x.get("scoringType") or {}).get("name") == "touchdown"
        ]
        if tds:
            first = min(tds, key=lambda x: int(x.get("sequenceNumber") or 0))
            rec["had_td"] = 1
            rec["seq"] = int(first.get("sequenceNumber") or 0)
            rec["kind"] = (first.get("type") or {}).get("text")
            rec["scorer_team_id"] = str((first.get("team") or {}).get("$ref", "")
                                        .split("/teams/")[-1].split("?")[0]) or None
            parts = first.get("participants") or []
            roles = {pt.get("type"): athlete_id(pt["athlete"]["$ref"])
                     for pt in parts if pt.get("athlete", {}).get("$ref")}
            rec["scorer_id"] = roles.get("scorer")
            rec["scorer_offensive"] = int(any(r in OFFENSIVE_ROLES and roles[r] == rec["scorer_id"]
                                              for r in roles))
    except Exception as e:
        rec["error"] = str(e)[:80]
    with open(fp, "w") as f:
        json.dump(rec, f)
    return rec


def main():
    games = []
    with open(os.path.join(DATA, "nfl_games.csv")) as f:
        for row in csv.DictReader(f):
            games.append(row["game_id"])
    print(f"{len(games)} games to resolve", flush=True)

    t0 = time.time()
    done = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, rec in enumerate(ex.map(first_td, games), 1):
            done.append(rec)
            if i % 200 == 0:
                print(f"  {i}/{len(games)} in {time.time()-t0:.0f}s", flush=True)

    out = os.path.join(DATA, "nfl_first_td.csv")
    cols = ["game_id", "had_td", "seq", "kind", "scorer_id", "scorer_team_id",
            "scorer_offensive"]
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in done:
            w.writerow(r)

    err = sum(1 for r in done if r.get("error"))
    notd = sum(1 for r in done if not r["had_td"])
    off = sum(1 for r in done if r["scorer_offensive"])
    print(f"\nwrote {out}: {len(done):,} rows")
    print(f"  errors {err}, games with no touchdown {notd}")
    print(f"  first TD scored by a rusher/receiver: {off:,} "
          f"({off/max(len(done)-notd,1)*100:.1f}% of games that had one)")
    kinds = {}
    for r in done:
        if r["kind"]:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    for k, v in sorted(kinds.items(), key=lambda t: -t[1]):
        print(f"    {k:<32} {v:>5}")


if __name__ == "__main__":
    main()
