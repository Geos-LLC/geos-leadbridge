#!/usr/bin/env bash
# LeadBridge — Railway boot script
#
# Runs Prisma migrations BEFORE the API starts. Uses DIRECT_URL (port 5432)
# for the migration step because pgbouncer (port 6543, the default
# DATABASE_URL) doesn't support Prisma's migrate engine. The runtime API is
# left to use DATABASE_URL unchanged.
#
# Failure semantics: any non-zero exit short-circuits boot. Railway's
# restartPolicyType=ON_FAILURE will retry, but the API will NOT start with
# unapplied migrations on the database — that's the whole point of this
# script. Logs go to stdout so Railway's deploy log captures them.

set -euo pipefail

echo "[startup] LeadBridge boot starting..."

echo "[startup] DIRECT_URL present: ${DIRECT_URL:+yes}"
echo "[startup] DATABASE_URL present: ${DATABASE_URL:+yes}"

if [ -z "${DIRECT_URL:-}" ]; then
  echo "[startup] ERROR: DIRECT_URL is missing. Cannot run Prisma migrations."
  exit 1
fi

echo "[startup] Running Prisma migrations..."

# Override DATABASE_URL only for the duration of this command, so the migrate
# engine connects on port 5432. The runtime API below inherits the original
# DATABASE_URL (pgbouncer pool on 6543) from the parent env unchanged.
DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy

echo "[startup] Migrations complete."

echo "[startup] Starting API..."

# exec replaces the shell with the node process so signals (SIGTERM on Railway
# rolling deploys) reach Nest cleanly.
exec npm run start:prod
