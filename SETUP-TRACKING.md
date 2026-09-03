# Getting the ledger to actually store results

Exactly what is needed, where each thing goes, and how to tell it worked.

Nothing here needs to be sent to anyone. Every secret goes into a file or a
dashboard you already control.

---

## The situation

| | status |
|---|---|
| `predictions` (MLB) | **working** — 4,884 rows, 2026-07-10 → 2026-09-01 |
| `event_predictions` (soccer, tennis) | **does not exist** — nothing has ever been stored |

Two things have to be true before a single soccer or tennis result can be
stored, and right now neither is:

1. **The table has to exist.** It never has. Every write the tracking cycle
   attempted was rejected.
2. **Something has to run the write.** The Vercel cron fires `GET`; both hooks
   only did their work on `POST`, so the scheduled job returned `200` and did
   nothing. Fixed in the open PR, but it has to be merged and deployed.

---

## Step 1 — create the table

**What is needed:** the ability to run `CREATE TABLE` on the Supabase project.

A service-role key **cannot** do this. It authenticates against PostgREST,
which exposes tables — not DDL. So it takes one of these two:

### Option A — paste the SQL (nothing to install, nothing to configure)

1. Open <https://supabase.com/dashboard/project/fmhtbaikwlcjzrlisesf/sql/new>
2. Paste the entire contents of [`supabase/SETUP.sql`](supabase/SETUP.sql)
3. Run it

The file is both migrations concatenated and made re-runnable (`IF NOT EXISTS`
everywhere, policies and triggers dropped first), so running it twice is
harmless.

### Option B — a connection string, so the script does it

1. Supabase Dashboard → **Settings → Database → Connection string → URI**
2. Add it to `.env` in this repo:
   ```
   SUPABASE_DB_URL=postgresql://postgres.fmhtbaikwlcjzrlisesf:<password>@…pooler.supabase.com:5432/postgres
   ```
3. ```bash
   npx tsx scripts/provision-ledger.ts
   ```

Either way, confirm:

```bash
npx tsx scripts/check-ledger.ts
# event_predictions … STATUS  empty — the table exists but holds no rows yet.
```

---

## Step 2 — fill it

**What is needed:** `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Per `CRON.md` this is
already there, since the MLB pipeline has been running locally on it.

```bash
npx tsx scripts/backfill-ledger.ts --dry-run            # preview, writes nothing
npx tsx scripts/backfill-ledger.ts --since 2025-09-03   # ~12,000 rows
```

Every row is written `provenance='reconstructed'` — a backtest, replayed from
point-in-time ratings, stored beside the forward record and never averaged into
it. `--since 2026-08-15` (the default) restricts it to the period since the
sports actually shipped, which is ~740 matches.

---

## Step 3 — keep it recording forward

This is the part that produces the record actually worth having. Two ways, and
doing both is fine — writes are idempotent.

### Locally, immediately

```bash
scripts/run-tracking-local.sh
```

Then add it to the same crontab that runs the MLB pipeline:

```cron
20 8  * * *  <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
55 23 * * *  <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
```

The morning run records fixtures before they start; the late run settles them.

### On Vercel, so the local machine stops being load-bearing

Merge the open PR, then confirm both of these exist in
**Vercel → diamond-predictor → Settings → Environment Variables** (Production):

| variable | why | if missing |
|---|---|---|
| `CRON_SECRET` | Vercel sends it as `Authorization: Bearer …`; the hook runs only when it matches | the cron's GET is unauthenticated → no-op |
| `SUPABASE_SERVICE_ROLE_KEY` | the only credential that can write | every insert is silently dropped |

Verify without any secret — this endpoint is safe to open in a browser:

```
https://diamond-predictor-three.vercel.app/api/public/hooks/track-predictions
```

```json
{ "ok": true, "ran": false,
  "cronSecretSet": true,      ← must be true
  "writable": true,           ← must be true
  "ledgerReady": true }       ← must be true after step 1
```

Any `false` there is the reason nothing is being stored.

---

## Step 4 — confirm

```bash
npx tsx scripts/check-ledger.ts
```

```
event_predictions  — the soccer & tennis ledger (forward + reconstructed)
  STATUS  12762 rows
    soccer/epl    reconstructed  n=  370  settled=  370  acc= 48.9%  2025-09-13 → 2026-08-31
    tennis/atp    reconstructed  n= 3887  settled= 3887  acc= 64.1%  …
    tennis/atp    forward        n=   14  settled=    0  acc=     —  2026-09-04 → 2026-09-04
```

The `forward` rows are the ones that will matter in a few months. The
`reconstructed` ones are scaffolding so the pages are not blank until then.

---

## What I do not need

- Nobody needs to send me a service-role key or a database password. Steps 1–3
  are all run by you, locally or in a dashboard.
- If you *would* rather I ran them: add `SUPABASE_DB_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` to this Claude Code environment's variables
  (the same place `SUPABASE_URL` and `PUBLISHABLE_KEY` are already set), and I
  can do steps 1, 2 and 4 directly. Pasting them into chat would put them in
  the transcript, so that is the wrong channel for them either way.
