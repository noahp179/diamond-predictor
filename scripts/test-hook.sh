#!/usr/bin/env bash
# Test the /api/public/hooks/run-pipeline endpoint via curl.
# Usage: bash scripts/test-hook.sh
# Set LOCAL=true for local testing, e.g. LOCAL=true bash scripts/test-hook.sh

set -euo pipefail

deploy_url="${DEPLOY_URL:-https://your-app.vercel.app}"
[[ "${LOCAL:-}" = "true" ]] && deploy_url="http://localhost:3000"

echo "🚀 Hitting: $deploy_url/api/public/hooks/run-pipeline"

curl -s -X POST "$deploy_url/api/public/hooks/run-pipeline" \
  -H "Content-Type: application/json" | python3 -m json.tool 2>/dev/null || curl -s -X POST "$deploy_url/api/public/hooks/run-pipeline" -H "Content-Type: application/json"
