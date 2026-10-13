# Result tracking — how it works and how to check it

Every number on every Track Record page is a **forward result**: the model's
prediction was written to the database before the event started, and scored
after it finished. Nothing is replayed, reconstructed, or derived from a game
whose outcome was already known.

That rule is why these pages start empty and fill slowly. It is the only
property that makes them worth reading.

---

## Current state

| | status |
|---|---|
| `predictions` (MLB) | recording since 2026-07-10 · 4,965 rows · 10 model versions |
| `event_predictions` (soccer, tennis, NFL, NBA, college football) | table created 2026-09-03 · see the note below before trusting the NFL/NBA rows |
| `player_predictions` (touchdown scorers) | **needs creating** — apply `supabase/SETUP.sql`, which now includes it |
| Vercel cron | `cronSecretSet: true`, `writable: true`, `ledgerReady: true` |

The cron runs at 08:20 UTC daily. One thing is outstanding: the touchdown ledger
table does not exist yet. Until it does, the "Did they score?" section on both
touchdown boards says so explicitly rather than showing an empty record, because
those are different states and only one of them is fixable by waiting.

### The team-sport rows were never actually written

`snapshotTeamSport` only records games that have not kicked off, which is right,
but it tested that by asking whether the game had a score yet:

```
.filter((g) => g.winner == null && g.homeScore == null)
```

ESPN serves a **scheduled** game with `score: "0"`, not an empty string — in
every sport. So `homeScore` was `0` rather than `null` for exactly the games
this was meant to keep, the condition was never true, and the filter matched
nothing. The NFL and NBA ledgers have therefore been writing zero rows since the
day they were wired up, and the college football one inherited it on the day it
shipped. Nothing errored; the table simply stayed empty, which is
indistinguishable from a quiet week.

Fixed on 2026-09-13: `toSlateGame` now reads ESPN's own lifecycle state and
leaves the score `null` before kickoff, and the filter tests `state === "pre"`.
`bun scripts/test-td-ledger.ts` asserts both directions — a finished slate
contributes nothing, an upcoming one is fully recordable — against live ESPN.

The same placeholder was also rendering "0–0" on every game card that had not
kicked off yet.

---

## Why the Track Records froze (found 2026-10-13)

Every status flag was green — `writable`, `ledgerReady`, the cron secret — and
rows were being written every morning. Almost nothing was being **scored**.
By 13 October nothing in `event_predictions` dated after 23 September had
settled: NFL 17 of 64, college football 75 of 267, ATP 53 of 318.

**The settler fell behind by a day every day.** It settled each pending date by
rebuilding that date's full prediction slate — a three-season Elo replay for
the team sports, a two-year tennis window (hundreds of ESPN calls), three
soccer seasons — just to read the final scores off it. It ran last in a cycle
that already builds five sports, so the function's time limit arrived after a
handful of dates. Two dates were added a day and about one was settled.

**Rows older than 21 days were then orphaned.** The settler only looked back
21 days, so whatever it had not reached by then was never looked at again.

**Soccer stopped writing on 16 September.** ESPN began answering date-range
scoreboard queries with a 400, and every soccer slate is built from a season
range. Recording and settling both failed, silently, from then on.

**The NBA ledger was recording preseason games** — all 53 of its rows (3-14
October) were ESPN season type 1.

Fixed in code:

- Settlement reads only the date's scoreboard (`resultsFor` in
  `tracking.server.ts`; `tennisResults`, `soccerDayResults`). The whole
  backlog — 107 dates, 1,037 rows — resolves in about four seconds.
- It runs **first** in the cycle, pages past the API's 1,000-row cap, reaches
  back 120 days, works six dates at a time, and stops at a time budget.
- Soccer reads seasons a month at a time when ESPN refuses the range.
- Team sports skip preseason games.
- The status endpoint now reports `settleBacklog` — unsettled rows whose date
  has passed, how many are over three days old, and the oldest. That number
  should be zero or a few postponements; if it grows, the settler is behind.

**What to do once:**

1. Run `supabase/fixes/20261013_remove_nba_preseason.sql` in the SQL editor
   (deletes the preseason NBA rows; none had settled).
2. Run `supabase/migrations/20261013120000_ledger_health.sql` (a read-only
   view — `select * from ledger_health order by oldest_pending;`).
3. Deploy. The next 08:20 UTC cron clears the backlog — or trigger it now:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://diamond-predictor-three.vercel.app/api/public/hooks/track-predictions`
4. Check `settleBacklog.unsettledOver3Days` on the status URL is near zero.

`npx tsx scripts/test-settle.ts` checks every sport's result lookup against
live ESPN.

---

## What runs, and when

`vercel.json` schedules two jobs. Vercel Cron invokes them with **GET**, sending
`Authorization: Bearer $CRON_SECRET`.

| path | schedule (UTC) | what it does |
|---|---|---|
| `/api/public/hooks/run-pipeline` | `0 8 * * *` | MLB: ingest, predict, settle, recompute metrics |
| `/api/public/hooks/track-predictions` | `20 8 * * *` | soccer, tennis, NFL, NBA: record today + tomorrow, settle what finished |

Both also accept POST. Both are idempotent — a prediction conflicts on
`(model_version, event_id)` and is dropped rather than overwritten, so a second
run in a day cannot revise a call that was already written down.

---

## Checking it without any credentials

This endpoint is safe to open in a browser:

```
https://diamond-predictor-three.vercel.app/api/public/hooks/track-predictions
```

```json
{ "ok": true, "ran": false,
  "cronSecretSet": true,     ← Vercel can authenticate its own cron
  "writable": true,          ← SUPABASE_SERVICE_ROLE_KEY is present
  "ledgerReady": true,       ← event_predictions exists
  "tdLedgerReady": true,     ← player_predictions exists
  "tdLedgerStatus": { "cfb": "ok", "nfl": "ok" },
  "tdPicksRecorded": 0,      ← touchdown picks written so far
  "tdPicksSettled": 0 }      ← of those, scored against a box score
```

Any `false` is the reason nothing is being stored. Each of these has already
been the cause of total silence at some point:

- `cronSecretSet: false` — the scheduled GET arrives unauthenticated and no-ops.
- `writable: false` — every insert is dropped.
- `ledgerReady: false` — `event_predictions` does not exist; the writes go nowhere.
- `tdLedgerReady: false` — `player_predictions` does not exist; same.

`tdPicksRecorded` is the one to watch after that. Both flags can be `true` while
nothing is being written — that was exactly the state the team-sport ledger sat
in for months — so a count that stays at zero across a Saturday is the signal
that something upstream is wrong, not that the sport was quiet.

---

## Checking what is actually stored

```bash
npx tsx scripts/check-ledger.ts
```

```
event_predictions  — the ledger
  STATUS  59 rows
    nfl/nfl       forward   n=  16  settled=   0  acc=     —  2026-09-04 → 2026-09-04
    soccer/epl    forward   n=   1  settled=   0  acc=     —  2026-09-04 → 2026-09-04
    tennis/atp    forward   n=  16  settled=  16  acc= 62.5%  2026-09-03 → 2026-09-03
```

Needs only `SUPABASE_URL` and `PUBLISHABLE_KEY` — the table is world-readable.

---

## Running it by hand

Useful to seed the first day rather than waiting for 08:20 UTC. Needs
`SUPABASE_SERVICE_ROLE_KEY` in `.env`.

```bash
scripts/run-tracking-local.sh              # today
scripts/run-tracking-local.sh 2026-09-04   # a specific date
```

It refuses to run if the table is missing, rather than writing into the void.

If the Vercel cron ever stops again, the same two crontab lines that carry the
MLB pipeline will carry this:

```cron
20 8  * * *  <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
55 23 * * *  <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
```

Morning records fixtures before they start; the late run settles them.

---

## What was removed, and why

**The replayed-history section** on the soccer and tennis Track Record pages.
It re-ran the model over the last 365 days of finished matches. The arithmetic
was honest — each match was priced before its result was folded into the
ratings — but it was still a backtest, and a backtest on a page called Track
Record invites exactly the misreading the page exists to prevent.

**`scripts/backfill-ledger.ts`.** It wrote those replayed matches into the
ledger as `provenance = 'reconstructed'`. Nothing displays reconstructed rows
any more, so it wrote rows no one would ever see.

**`trackRecord()` and `TrackRecordView`.** The NFL and NBA pages were built
entirely on a replay of the last three seasons — a backtest wearing a track
record's name, and the reason those two pages looked full while every other
sport looked empty. They now read the same forward ledger as everything else,
which means they start empty too. That is the honest state of an NFL forward
record that began on 2026-09-03.

The `provenance` column survives, and `readLedger` takes it as a **required**
argument rather than an optional filter. There is no correct way to read
forward and reconstructed rows together, and forcing every caller to choose is
what stops them being averaged by accident later.

---

## Where a backtest is still shown, deliberately

Two places on the soccer and tennis pages, both labelled, neither plotted as
data:

1. One row in the **Claimed against actual** table — what the held-out backtest
   said to expect, beside what the ledger has recorded.
2. A **dashed reference line** on the accuracy chart at that same number, so
   "is it doing what it said?" is a visual question.

NFL and NBA show neither: they never had a held-out backtest, so that column
stays empty rather than being filled with the season replay it just replaced.
