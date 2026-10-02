#!/usr/bin/env bash
# Apply schema.sql to your Postgres database (idempotent).
# Requires the psql client. Alternative: paste schema.sql into the SQL editor
# in your Vercel dashboard (Storage -> Postgres -> SQL editor).
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Export the pooled Postgres URL first, e.g.:"
  echo "  export DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require"
  exit 1
fi

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "$(cd "$(dirname "$0")/.." && pwd)/schema.sql"
echo "✓ schema applied"
