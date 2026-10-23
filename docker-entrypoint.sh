#!/bin/sh
set -e

# Bind-mount + named node_modules volume keeps the previous install across deploys.
# Re-sync production deps whenever package-lock.json changes (any new package,
# e.g. socket.io) — compared by checksum stored inside the node_modules volume.
STAMP=node_modules/.package-lock.sha1
if [ -f package-lock.json ]; then
  CURRENT=$(sha1sum package-lock.json | cut -d' ' -f1)
else
  CURRENT=$(sha1sum package.json | cut -d' ' -f1)
fi

if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$CURRENT" ]; then
  echo "[entrypoint] Dependencies changed — installing npm packages..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
  echo "$CURRENT" > "$STAMP"
fi

exec "$@"
