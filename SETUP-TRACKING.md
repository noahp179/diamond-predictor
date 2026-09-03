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
| `event_predictions` (soccer, tennis, NFL, NBA) | table created 2026-09-03 · recording forward from the next cron run |
| Vercel cron | `cronSecretSet: true`, `writable: true`, `ledgerReady: true` |

All three gates are green. The cron runs at 08:20 UTC daily and needs nothing
further.

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
  "cronSecretSet": true,   ← Vercel can authenticate its own cron
  "writable": true,        ← SUPABASE_SERVICE_ROLE_KEY is present
  "ledgerReady": true }    ← the table exists
```

Any `false` is the reason nothing is being stored. Each of those three has
already been the cause of total silence at some point:

- `cronSecretSet: false` — the scheduled GET arrives unauthenticated and no-ops.
- `writable: false` — every insert is dropped.
- `ledgerReady: false` — the table does not exist; the writes go nowhere.

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
