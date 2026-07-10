# Daily Cron — 3 AM Auto-sync

## Local operation (while the Vercel cron is down)

The cron stopped writing on 2026-06-15. Until it's revived, the same pipeline
can run from any machine with `SUPABASE_SERVICE_ROLE_KEY` in `.env`:

```bash
scripts/run-pipeline-local.sh        # ingest & predict today (all models), settle, metrics
```

Two crontab lines keep tracking alive locally (morning: record the day's
pre-game predictions; night: settle them) — see the script header. Predictions
are only ever recorded for games that haven't started (hindsight guard), so a
morning run is required to capture that day; an evening run can only settle.

The pipeline stores a prediction row per model per game: `baseline-v0.4`,
`sim-elo-v2`, `odds-blend-v1`, and `market-devig` (the devigged DraftKings
line, as the benchmark). The Track Record page compares them from
`TRACK_RECORD_START` (2026-07-10, `src/lib/mlb-models.ts`) forward.

**When reviving the Vercel cron, redeploy first** — the deployed build predates
the odds-blend-v1 / market-devig models and the hindsight guard.

## What it's doing

Every day at 8:00 AM UTC (≈3:00 AM ET when DST is active), Vercel fires a POST to:

```
POST /api/public/hooks/run-pipeline
```

Which runs:

1. **Ingest & predict** — fetches yesterday's schedule & standings, inserts games + predictions into Supabase.
2. **Settle finished games** — for any final games, scores them (correct/incorrect, Brier, log-loss).
3. **Recompute daily metrics** — aggregates per-day stats (accuracy, Brier, etc.) into `daily_metrics`.

The next morning, your `index` and `model` routes automatically read the newly scored data from the DB.

---

## 🔐 Security — CRON_SECRET (required)

The `POST` endpoint is **protected by a shared secret** to prevent unauthorized triggering.

### Set up the secret

1. Generate a strong secret:
   ```bash
   # macOS / Linux
   openssl rand -hex 32
   ```

2. **Add it to Vercel environment variables:**
   - Go to **Vercel Dashboard → Your Project → Settings → Environment Variables**
   - Add `CRON_SECRET` with the value from step 1
   - Click **Save**
   - **Redeploy** the project (Vercel injects env vars at build time)

3. **Test a manual trigger:
   ```bash
   curl -X POST https://your-app.vercel.app/api/public/hooks/run-pipeline \
     -H "Authorization: Bearer YOUR_CRON_SECRET"
   ```

### How it works

- Vercel Cron automatically sends the `CRON_SECRET` value in the `Authorization: Bearer <secret>` header when it calls your endpoint.
- If you use an external service (cron-job.org, etc.), you must manually configure the **Authorization header**.
- If `CRON_SECRET` is missing or wrong, the endpoint returns `401 Unauthorized`.

---

## Platform specifics

### Vercel

The `usanss.json in the repo root configures the cron (already set up):

```json
{
  "crons": [
    {
      "path": "/api/public/hooks/run-pipeline",
      "schedule": "0 8 * * *"
    }
  ]
}
```

- `0 8 * * *` = every day at 08:00 UTC.
  - During Daylight Saving Time (most of MLB season) that's 3:00 AM ET.
  - During Standard Time (Nov–Feb) that's 3:00 AM EST. ⚠ Adjust to `0 7 * * *` in winter if you want to stay at 3 AM ET.

**No additional code changes are needed** — Vercel picks this up on the next deploy.

### Other platforms

- **Netlify**: Add a `netlify.toml` with `[functions.cron]` → schedule pointing to the same POST endpoint.
- **Cloudflare Workers**: Add `[[triggers]]` in `wrangler.toml`.
- **Node / VPS**: Add the curl command below to the host's `crontab`.
- **Supabase cron** or a free external service (e.g. cron-job.org or UptimeRobot) can also POST to the same endpoint.

---

## Verification

### 1. Check the health-check endpoint

```bash
curl https://your-app.vercel.app/api/public/hooks/run-pipeline
```

Expected response:
```json
{
  "ok": true,
  "note": "Use POST to run the full pipeline...",
  "today": "2025-06-09",
  "env": "vercel"
}
```

### 2. Run the local test script (no HTTP needed)

```bash
# Run for today
bun scripts/test-pipeline.ts

# Run for a specific past date
bun scripts/test-pipeline.ts 2025-06-01
```

This executes the exact same functions as the production cron and prints the results. If this passes, the production cron will too.

### 3. Trigger the hook endpoint (manual)

```bash
# Production (requires CRON_SECRET)
curl -X POST https://your-app.vercel.app/api/public/hooks/run-pipeline \
  -H "Authorization: Bearer $CRON_SECRET"

# Or use the helper script
CRON_SECRET=your-secret-key bash scripts/test-hook.sh
```

### 4. Verify data in Supabase

After any of the above methods run successfully, check your `supabase` dashboard:

```sql
-- Settled predictions
SELECT COUNT(*) FROM predictions WHERE settled_at > now() - interval '1 hour' AND model_version = 'baseline-v0.4';

-- Daily metrics
SELECT * FROM daily_metrics ORDER BY metric_date DESC LIMIT 5;
```

---

## If something fails

1. Vercel auto-logs cron runs in your project → **Deployments → Functions tab** (filter for `/api/public/hooks/run-pipeline`). Look for the error message there.
2. The response from the POST includes `"startedAt"` and if it fails, an `"error"` field.
3. The omnichannel console also shows `[cron] pipeline failed` with the full stack trace.
4. The GET health-check (step 1 above) confirms the route is reachable and the environment is recognized.
