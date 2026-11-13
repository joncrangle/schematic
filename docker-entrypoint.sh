#!/usr/bin/env sh
set -e

DATA_DIRECTORY="${DATA_DIR:-/app/data}"

# Create persistent data directory if missing
mkdir -p "$DATA_DIRECTORY"

# Cold start: copy pre-generated hierarchical database templates if volume
# databases are missing.
find /app/templates -type f -name '*.db' -print | while IFS= read -r template; do
  relative_path=${template#/app/templates/}
  target="$DATA_DIRECTORY/$relative_path"
  if [ ! -f "$target" ]; then
    mkdir -p "$(dirname "$target")"
    echo "Cold start: Initializing $target from pre-built template..."
    cp "$template" "$target"
    echo "Database initialized successfully at $target"
  fi
done

# If arguments are passed, execute them
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Start the Bun production server; its explicit bootstrap calls initSchedulers.
exec bun run start
