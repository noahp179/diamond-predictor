"""
Collect every club match the Champions League model needs from ESPN's public
soccer API.

The Champions League cannot be modelled from its own results alone. A club
plays six to fifteen European matches a season and thirty to forty at home, and
the only way to put Arsenal, Slavia Prague and Sabah on one scale is to replay
both: domestic matches say how a club compares with its league, European
matches say how the leagues compare with each other. So this pulls the three
UEFA competitions (and their qualifiers) plus every domestic league ESPN
carries that regularly sends clubs to them.

ESPN stopped accepting date-range scoreboard queries (`dates=A-B` answers 400
for every sport) in autumn 2026, so each competition is read one calendar year
at a time with `dates=YYYY`, which still works and returns a whole year in one
call.

Outputs (research/ucl/data/, gitignored — regenerate with this script):
  matches.csv   one row per completed match, every competition
  fixtures.csv  scheduled matches (with ESPN's posted 1X2 prices where present)
  events.csv    goals and red cards with minute, team and player

Usage: python3 fetch_ucl.py [--from 2013] [--to 2026]
"""

import argparse
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
CACHE = os.environ.get(
    "UCL_CACHE",
    "/tmp/claude-0/-home-user-diamond-predictor/5aaa5c80-55e2-5b83-aa6e-de3bccebb687/scratchpad/ucl-cache",
)
API = "https://site.api.espn.com/apis/site/v2/sports/soccer"

# UEFA's three club competitions and their qualifiers. Qualifiers matter more
# than they look: they are most of the evidence on the smaller leagues.
EUROPE = [
    "uefa.champions",
    "uefa.champions_qual",
    "uefa.europa",
    "uefa.europa_qual",
    "uefa.europa.conf",
    "uefa.europa.conf_qual",
    "uefa.super_cup",
]

# Domestic leagues ESPN carries with full fixture lists. Czechia, Ukraine,
# Croatia, Serbia, Poland, Azerbaijan and Kazakhstan are absent from ESPN's
# feed, so their clubs are rated from European matches alone.
DOMESTIC = [
    "eng.1", "esp.1", "ger.1", "ita.1", "fra.1",
    "por.1", "ned.1", "bel.1", "tur.1", "sco.1", "aut.1", "gre.1", "sui.1",
    "den.1", "nor.1", "swe.1", "cyp.1", "rus.1", "isr.1", "rou.1", "irl.1",
    "eng.2",
]

SESSION = requests.Session()


def get(url, tries=5):
    """JSON or None. ESPN answers transient failures with 400 "Failed to get
    events endpoint" as well as 403/5xx, so every non-200 is retried."""
    for a in range(tries):
        try:
            r = SESSION.get(url, timeout=60)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(1.0 * (a + 1))
    return None


def year_events(comp, year, refresh_current):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{comp}_{year}.json")
    if os.path.exists(path) and not (refresh_current and year >= refresh_current):
        with open(path) as f:
            return comp, year, json.load(f)
    d = get(f"{API}/{comp}/scoreboard?dates={year}&limit=1000")
    if d is None:
        # A failed call is not an empty season: leave it uncached so the next
        # run asks again, and say so.
        print(f"  ! {comp} {year}: no answer from ESPN")
        return comp, year, []
    events = d.get("events", [])
    with open(path, "w") as f:
        json.dump(events, f)
    return comp, year, events


MIN_RE = re.compile(r"(\d+)'(?:\+(\d+)')?")


def minute_of(detail):
    """(minute, stoppage, regulation?) from ESPN's display clock, e.g. 90'+3'."""
    disp = (detail.get("clock") or {}).get("displayValue") or ""
    m = MIN_RE.match(disp)
    if not m:
        v = (detail.get("clock") or {}).get("value") or 0
        mins = int(v // 60) + 1
        return mins, 0, mins <= 90
    base = int(m.group(1))
    extra = int(m.group(2) or 0)
    return base, extra, base <= 90


def american_to_prob(s):
    try:
        v = float(str(s).replace("+", ""))
    except (TypeError, ValueError):
        return None
    if v == 0:
        return None
    return 100 / (v + 100) if v > 0 else -v / (-v + 100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=2013)
    ap.add_argument("--to", dest="end", type=int, default=2026)
    ap.add_argument("--refresh", type=int, default=2026,
                    help="re-download this calendar year and later (default 2026)")
    args = ap.parse_args()

    jobs = [(c, y) for c in EUROPE + DOMESTIC for y in range(args.start, args.end + 1)]
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda j: year_events(j[0], j[1], args.refresh), jobs))

    matches, fixtures, events = {}, {}, []
    for comp, year, evs in results:
        for e in evs:
            c = (e.get("competitions") or [{}])[0]
            comps = c.get("competitors") or []
            home = next((x for x in comps if x.get("homeAway") == "home"), None)
            away = next((x for x in comps if x.get("homeAway") == "away"), None)
            if not home or not away:
                continue
            st = (c.get("status") or e.get("status") or {}).get("type", {})
            row = dict(
                id=e["id"], comp=comp, date=e["date"], status=st.get("name", ""),
                neutral=bool(c.get("neutralSite")),
                home_id=home["team"]["id"], away_id=away["team"]["id"],
                home_name=home["team"].get("displayName", ""),
                away_name=away["team"].get("displayName", ""),
                home_abbr=home["team"].get("abbreviation", ""),
                away_abbr=away["team"].get("abbreviation", ""),
            )
            if st.get("completed"):
                try:
                    hg, ag = int(home["score"]), int(away["score"])
                except (TypeError, ValueError, KeyError):
                    continue
                if st.get("name") in ("STATUS_ABANDONED", "STATUS_CANCELED", "STATUS_POSTPONED"):
                    continue
                details = c.get("details") or []
                # 90-minute score: matches that went to extra time report the
                # 120-minute score, and 1X2 settles on 90 minutes.
                hg90, ag90, have_detail = 0, 0, False
                for d in details:
                    if not d.get("scoringPlay") or d.get("shootout"):
                        continue
                    have_detail = True
                    mins, extra, reg = minute_of(d)
                    if reg:
                        if (d.get("team") or {}).get("id") == row["home_id"]:
                            hg90 += 1
                        else:
                            ag90 += 1
                    ath = (d.get("athletesInvolved") or [{}])[0]
                    events.append(dict(
                        match_id=e["id"], kind="goal", minute=mins, stoppage=extra,
                        team_id=(d.get("team") or {}).get("id"),
                        player_id=ath.get("id"), player=ath.get("displayName"),
                        position=ath.get("position"),
                        pen=bool(d.get("penaltyKick")), own=bool(d.get("ownGoal")),
                    ))
                for d in details:
                    if d.get("redCard"):
                        mins, extra, _ = minute_of(d)
                        ath = (d.get("athletesInvolved") or [{}])[0]
                        events.append(dict(
                            match_id=e["id"], kind="red", minute=mins, stoppage=extra,
                            team_id=(d.get("team") or {}).get("id"),
                            player_id=ath.get("id"), player=ath.get("displayName"),
                            position=ath.get("position"), pen=False, own=False,
                        ))
                et = st.get("name") in ("STATUS_FINAL_AET", "STATUS_FINAL_PEN", "STATUS_FINAL_AGT")
                if et and not have_detail:
                    # Went to extra time and no goal log to recover 90 minutes:
                    # the 90-minute result was a draw, the score is unknown.
                    hg90 = ag90 = None
                elif not et:
                    hg90, ag90 = hg, ag
                stats = {}
                for side, comp_ in (("h", home), ("a", away)):
                    for s in comp_.get("statistics") or []:
                        if s.get("name") in ("totalShots", "shotsOnTarget"):
                            try:
                                stats[f"{side}_{s['name']}"] = float(s.get("displayValue"))
                            except (TypeError, ValueError):
                                pass
                row.update(hg=hg, ag=ag, hg90=hg90, ag90=ag90, et=et,
                           shootout_home=home.get("shootoutScore"),
                           shootout_away=away.get("shootoutScore"),
                           detail=have_detail, **stats)
                matches[e["id"]] = row
            elif st.get("state") == "pre":
                odds = ((c.get("odds") or [None])[0]) or {}
                ml = odds.get("moneyline") or {}
                def close(side):
                    s = ml.get(side) or {}
                    return american_to_prob(((s.get("close") or {}).get("odds")) or ((s.get("open") or {}).get("odds")))
                draw = (odds.get("drawOdds") or {}).get("moneyLine")
                row.update(
                    p_home_mkt=close("home"), p_away_mkt=close("away"),
                    p_draw_mkt=american_to_prob(draw) if draw is not None else close("draw"),
                    provider=(odds.get("provider") or {}).get("name"),
                )
                fixtures[e["id"]] = row

    os.makedirs(DATA, exist_ok=True)
    m = pd.DataFrame(matches.values()).sort_values("date")
    m.to_csv(os.path.join(DATA, "matches.csv"), index=False)
    f = pd.DataFrame(fixtures.values())
    if len(f):
        f = f[~f["id"].isin(m["id"])].sort_values("date")
    f.to_csv(os.path.join(DATA, "fixtures.csv"), index=False)
    ev = pd.DataFrame(events).drop_duplicates()
    ev.to_csv(os.path.join(DATA, "events.csv"), index=False)

    print(f"{len(m):,} completed matches, {len(f):,} fixtures, {len(ev):,} events")
    print(m.groupby("comp").size().to_string())


if __name__ == "__main__":
    main()
