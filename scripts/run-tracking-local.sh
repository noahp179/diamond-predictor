#!/usr/bin/env bash
# Record today's soccer & tennis predictions and settle finished ones — the
# same code path as the Vercel cron hook.
#
# Requires SUPABASE_SERVICE_ROLE_KEY in diamond-predictor/.env, and the
# event_predictions table to exist (scripts/provision-ledger.ts creates it).
#
# Usage:
#   scripts/run-tracking-local.sh              # record today
#   scripts/run-tracking-local.sh 2026-09-03   # a specific date
#
# Suggested crontab alongside the MLB pipeline — a morning run records the
# day's fixtures before they start, a late run settles them:
#   20 8 * * *  <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
#   55 23 * * * <repo>/diamond-predictor/scripts/run-tracking-local.sh >> /tmp/diamond-tracking.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "SUPABASE_SERVICE_ROLE_KEY is not set in .env — nothing would be written." >&2
  exit 1
fi

exec npx tsx scripts/run-tracking-local.ts "$@"
