"""
Fetch every match summary the anytime-goalscorer backtest needs from ESPN.

Competitions: the five domestic leagues (eng.1, esp.1, ger.1, ita.1, fra.1)
and the Champions League (uefa.champions), seasons 2021-22 .. 2026-27 to date.

ESPN refuses scoreboard date RANGES (HTTP 400) since autumn 2026, so the
fixture list is read one calendar month at a time (`dates=YYYYMM`). Each
completed match's summary is then fetched once and compacted to what the
backtest reads:

  * header      kickoff, status, neutral flag, both sides' final score
  * rosters     every named player (starters AND bench) with the starter /
                subbedIn / subbedOut flags, slot position, formation place,
                the numeric box-score stats (totalGoals, ownGoals, shots, ...)
                and the player's own `plays` (substitution, goal, red card,
                each with its clock) -- which is what gives real minutes
  * keyEvents   goals, substitutions and red cards with clock and period

Compacted JSON is cached at data/raw/<comp>/<event id>.json, so a re-run only
fetches what is missing. Raw ESPN payloads are not kept (they are ~150 KB each).

Usage:
    python3 fetch.py                      # all six competitions
    python3 fetch.py --comps eng.1 esp.1  # a subset
    python3 fetch.py --first 2021 --last 2026 --workers 8
"""

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(DATA, "raw")
API = "https://site.api.espn.com/apis/site/v2/sports/soccer"
COMPS = ["eng.1", "esp.1", "ger.1", "ita.1", "fra.1", "uefa.champions"]
NUMERIC = ["totalGoals", "ownGoals", "totalShots", "shotsOnTarget", "goalAssists",
           "yellowCards", "redCards", "foulsCommitted", "foulsSuffered", "saves",
           "shotsFaced", "goalsConceded", "appearances", "subIns", "offsides"]

_session = requests.Session()


def get(url, tries=5, timeout=30):
    for a in range(tries):
        try:
            r = _session.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 400:      # a refused query will not succeed on retry
                return None
        except Exception:
            pass
        time.sleep(0.8 * (a + 1))
    return None


def months(first_season, last_season, until):
    out = []
    for s in range(first_season, last_season + 1):
        for y, m in [(s, mm) for mm in range(7, 13)] + [(s + 1, mm) for mm in range(1, 7)]:
            ym = f"{y}{m:02d}"
            if ym <= until:
                out.append(ym)
    return out


def scoreboard(comp, ym):
    d = get(f"{API}/{comp}/scoreboard?dates={ym}&limit=1000")
    rows = []
    for e in (d or {}).get("events", []):
        c = (e.get("competitions") or [{}])[0]
        st = (c.get("status") or e.get("status") or {}).get("type", {})
        rows.append(dict(id=str(e["id"]), date=e.get("date", ""), completed=bool(st.get("completed")),
                         status=st.get("name", "")))
    return rows


def compact(comp, d):
    h = (d.get("header") or {})
    c = (h.get("competitions") or [{}])[0]
    out = dict(
        comp=comp,
        date=c.get("date"),
        neutral=bool(c.get("neutralSite")),
        status=((c.get("status") or {}).get("type") or {}).get("name"),
        completed=bool(((c.get("status") or {}).get("type") or {}).get("completed")),
        season=(h.get("season") or {}).get("year"),
        teams=[dict(id=str((x.get("team") or {}).get("id", x.get("id"))), homeAway=x.get("homeAway"),
                    score=x.get("score"), shootout=x.get("shootoutScore"),
                    abbr=(x.get("team") or {}).get("abbreviation"),
                    name=(x.get("team") or {}).get("displayName"))
               for x in c.get("competitors") or []],
        rosters=[],
        events=[],
    )
    for side in d.get("rosters") or []:
        players = []
        for p in side.get("roster") or []:
            ath = p.get("athlete") or {}
            if not ath.get("id"):
                continue
            stats = {s.get("name"): s.get("value") for s in (p.get("stats") or [])}
            plays = []
            for pl in p.get("plays") or []:
                plays.append(dict(clock=(pl.get("clock") or {}).get("displayValue"),
                                  sub=bool(pl.get("substitution")), score=bool(pl.get("didScore")),
                                  assist=bool(pl.get("didAssist")), red=bool(pl.get("redCard")),
                                  pen=bool(pl.get("penaltyKick")), og=bool(pl.get("ownGoal"))))
            players.append(dict(
                id=str(ath["id"]), name=ath.get("displayName", ""),
                pos=(p.get("position") or {}).get("abbreviation", ""),
                starter=bool(p.get("starter")), subIn=bool(p.get("subbedIn")),
                subOut=bool(p.get("subbedOut")), fp=p.get("formationPlace"),
                stats={k: stats.get(k) for k in NUMERIC if k in stats},
                plays=plays,
            ))
        out["rosters"].append(dict(team=str((side.get("team") or {}).get("id")),
                                   homeAway=side.get("homeAway"),
                                   formation=side.get("formation"), players=players))
    for e in d.get("keyEvents") or []:
        t = (e.get("type") or {}).get("type") or ""
        keep = (t in ("substitution", "end-regular-time", "halftime", "start-extra-time",
                      "end-extra-time", "start-shootout") or e.get("scoringPlay")
                or any(w in t for w in ("goal", "penalty", "red", "own")))
        if not keep:
            continue
        out["events"].append(dict(
            type=t, clock=(e.get("clock") or {}).get("displayValue"),
            secs=(e.get("clock") or {}).get("value"), period=(e.get("period") or {}).get("number"),
            team=str((e.get("team") or {}).get("id")) if e.get("team") else None,
            who=[str((x.get("athlete") or {}).get("id")) for x in e.get("participants") or []],
            scoring=bool(e.get("scoringPlay")), shootout=bool(e.get("shootout")),
            text=(e.get("text") or "")[:160] if (e.get("scoringPlay") or "goal" in t) else None,
        ))
    return out


def fetch_summary(comp, eid):
    fp = os.path.join(RAW, comp, f"{eid}.json")
    if os.path.exists(fp):
        return "cached"
    d = get(f"{API}/{comp}/summary?event={eid}")
    if not d:
        return "failed"
    c = compact(comp, d)
    tmp = fp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, separators=(",", ":"))
    os.replace(tmp, fp)
    return "fetched"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--comps", nargs="*", default=COMPS)
    ap.add_argument("--first", type=int, default=2021)
    ap.add_argument("--last", type=int, default=2026)
    ap.add_argument("--until", default=time.strftime("%Y%m"))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    index = []
    for comp in args.comps:
        os.makedirs(os.path.join(RAW, comp), exist_ok=True)
        idx_fp = os.path.join(DATA, f"index_{comp}.json")
        ev = {}
        for ym in months(args.first, args.last, args.until):
            for r in scoreboard(comp, ym):
                ev[r["id"]] = r
        json.dump(sorted(ev.values(), key=lambda r: (r["date"], r["id"])), open(idx_fp, "w"))
        done = [r for r in ev.values() if r["completed"]]
        print(f"{comp}: {len(ev)} events, {len(done)} completed", flush=True)
        index += [(comp, r["id"]) for r in done]

    t0 = time.time()
    counts = {"cached": 0, "fetched": 0, "failed": 0}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(fetch_summary, c, i) for c, i in index]
        for k, f in enumerate(as_completed(futs), 1):
            counts[f.result()] += 1
            if k % 500 == 0:
                print(f"  {k}/{len(index)} {counts} {time.time() - t0:.0f}s", flush=True)
    print(f"done: {counts} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
