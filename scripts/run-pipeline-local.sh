#!/usr/bin/env bash
# Run the daily pipeline locally — the exact same code path as the Vercel
# cron (ingest & predict today for every model, settle finished games,
# recompute daily metrics).
#
# Requires SUPABASE_SERVICE_ROLE_KEY in diamond-predictor/.env
# (Supabase Dashboard → Project Settings → API keys → service_role).
#
# Usage:
#   scripts/run-pipeline-local.sh              # run for today
#   scripts/run-pipeline-local.sh 2026-07-11   # run for a specific date
#
# Suggested crontab (run `crontab -e`) until the Vercel cron is revived —
# morning run records the day's predictions, the late run settles them:
#   0 8 * * *   <repo>/diamond-predictor/scripts/run-pipeline-local.sh >> /tmp/diamond-pipeline.log 2>&1
#   50 23 * * * <repo>/diamond-predictor/scripts/run-pipeline-local.sh >> /tmp/diamond-pipeline.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "SUPABASE_SERVICE_ROLE_KEY is not set in .env — the pipeline cannot write. " \
    "Add it from Supabase Dashboard → Project Settings → API keys → service_role." >&2
  exit 1
fi

exec npx tsx scripts/test-pipeline.ts "$@"
