"""
Restore college box scores that ESPN's summary endpoint has since emptied.

    python3 research/football-td/patch_cfb_boxes.py [event_id ...]
    (default: 401762521, Army-Navy 2025-12-13), then rerun fetch_cfb.py

The 2025 Army-Navy game (event 401762521) now comes back from
`summary?event=` with EMPTY passing / rushing / receiving athlete lists (team
totals read 0 yards), so the research parser sees no ball-carriers at all.
The shipped pipeline evidently had it: its 2025 test set is 18,536 rows, ours
is 18,526 without this game and 18,536 with it. ESPN's core API still serves
the per-athlete game stats
(events/{id}/competitions/{id}/competitors/{team}/roster -> statistics), so the
rushing / receiving / passing categories are rebuilt from there and written to
data/patches/cfb/{event_id}.json. fetch_cfb.py overlays a patch onto the
compact box (only categories the summary left empty) when deriving its tables.
The raw summary in data/raw/ is left untouched.

Athlete order inside a rebuilt category is yards descending, ESPN's usual
order; for the CFB forest the order of players cannot change a prediction.
"""
import os, sys, json
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

OUT = os.path.join(HERE, "data", "patches", "cfb")
os.makedirs(OUT, exist_ok=True)
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"

CATS = {
    "passing": ["completions/passingAttempts", "passingYards", "yardsPerPassAttempt",
                "passingTouchdowns", "interceptions"],
    "rushing": ["rushingAttempts", "rushingYards", "yardsPerRushAttempt",
                "rushingTouchdowns", "longRushing"],
    "receiving": ["receptions", "receivingYards", "yardsPerReception",
                  "receivingTouchdowns", "longReception"],
}


def https(u):
    return u.replace("http://", "https://")


def fmt(v):
    if v is None:
        return "0"
    return str(int(v)) if float(v).is_integer() else f"{v:.1f}"


def patch(eid):
    box = json.load(open(os.path.join(HERE, "data", "box", "cfb", f"{eid}.json")))
    out = {"event_id": str(eid), "source": "espn core api per-athlete game statistics",
           "teams": {}}
    for t in box["teams"]:
        tid = t["team_id"]
        ro = C.get_json(f"{CORE}/events/{eid}/competitions/{eid}/competitors/{tid}/roster?limit=300")
        ents = [e for e in ro.get("entries", []) if e.get("statistics")]

        def stats(e):
            s = C.get_json(https(e["statistics"]["$ref"]))
            cats = {c["name"]: {x["name"]: x.get("value") for x in c.get("stats", [])}
                    for c in (s.get("splits") or {}).get("categories", [])}
            return cats

        with ThreadPoolExecutor(8) as ex:
            got = list(ex.map(stats, ents))
        cats = {k: [] for k in CATS}
        athletes = {}
        for e, s in zip(ents, got):
            pid = str(e["playerId"])
            pa, ru, re_ = s.get("passing", {}), s.get("rushing", {}), s.get("receiving", {})
            used = False
            if (pa.get("passingAttempts") or 0) > 0:
                cats["passing"].append((pa.get("passingYards") or 0, [pid, [
                    f"{fmt(pa.get('completions'))}/{fmt(pa.get('passingAttempts'))}",
                    fmt(pa.get("passingYards")), fmt(pa.get("yardsPerPassAttempt")),
                    fmt(pa.get("passingTouchdowns")), fmt(pa.get("interceptions"))]]))
                used = True
            if (ru.get("rushingAttempts") or 0) > 0:
                cats["rushing"].append((ru.get("rushingYards") or 0, [pid, [
                    fmt(ru.get("rushingAttempts")), fmt(ru.get("rushingYards")),
                    fmt(ru.get("yardsPerRushAttempt")), fmt(ru.get("rushingTouchdowns")),
                    fmt(ru.get("longRushing"))]]))
                used = True
            if (re_.get("receptions") or 0) > 0:
                cats["receiving"].append((re_.get("receivingYards") or 0, [pid, [
                    fmt(re_.get("receptions")), fmt(re_.get("receivingYards")),
                    fmt(re_.get("yardsPerReception")), fmt(re_.get("receivingTouchdowns")),
                    fmt(re_.get("longReception"))]]))
                used = True
            if used:
                a = C.get_json(https(e["athlete"]["$ref"]))
                athletes[pid] = {"name": a.get("displayName") or e.get("displayName", ""),
                                 "jersey": e.get("jersey")}
        out["teams"][tid] = {
            "athletes": athletes,
            "categories": {k: {"keys": CATS[k],
                               "athletes": [r for _, r in sorted(v, key=lambda x: -x[0])],
                               "totals": []} for k, v in cats.items()},
        }
        print(f"  {eid} team {tid}: " + ", ".join(
            f"{k} {len(v)}" for k, v in cats.items()))
    C.write_json_atomic(os.path.join(OUT, f"{eid}.json"), out)


def apply_patch(box):
    """Overlay data/patches/cfb/{event_id}.json onto a compact box, filling only
    categories the summary left empty. Returns the (possibly) patched box."""
    if not box:
        return box
    fp = os.path.join(OUT, f"{box['event_id']}.json")
    if not os.path.exists(fp):
        return box
    p = json.load(open(fp))
    for t in box["teams"]:
        pt = p["teams"].get(t["team_id"])
        if not pt:
            continue
        for k, cat in pt["categories"].items():
            cur = t["categories"].get(k)
            if cur is None or not cur.get("athletes"):
                t["categories"][k] = cat
        for pid, a in pt["athletes"].items():
            t["athletes"].setdefault(pid, a)
    box["patched"] = True
    return box


if __name__ == "__main__":
    for eid in (sys.argv[1:] or ["401762521"]):
        patch(eid)
