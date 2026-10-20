#!/bin/sh
set -e

# Bind-mount + named node_modules volume often keeps a stale install.
# Re-sync production deps whenever package-lock changes / packages are missing.
if [ ! -d node_modules/multer ] || [ ! -d node_modules/axios ] || [ ! -d node_modules/form-data ]; then
  echo "[entrypoint] Installing/updating npm dependencies..."
  if [ -f package-lock.json ]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
fi

exec "$@"
