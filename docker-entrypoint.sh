#!/usr/bin/env sh
set -e

DATA_DIRECTORY="${DATA_DIR:-/app/data}"

# Create persistent data directory if missing
mkdir -p "$DATA_DIRECTORY"

if [ "${1:-}" = "init" ]; then
  shift
  exec bun dist/scripts/seed.js --database-only --db=sqlite "$@"
fi

# If arguments are passed, execute them
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Start the Bun production server; its explicit bootstrap calls initSchedulers.
exec bun run start
