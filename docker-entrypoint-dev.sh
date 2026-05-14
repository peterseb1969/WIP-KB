#!/bin/sh
# Canonical dev-container entrypoint from CASE-58 (CT-YAC wrote this pattern;
# WIP-KB adopts verbatim from RC's reference impl — no tarball-linking needed
# since libs/ lives inside the bind-mounted source dir).
#
# Handles:
#   1. First-start populate: named volume /app/node_modules is empty → npm ci.
#   2. Staleness after host dep changes: package-lock.json hash changed → npm ci.
#   3. Corrupted install (killed mid-install): .package-lock.json absent → retry.
set -e

NODE_MODULES=/app/node_modules
LOCKFILE=/app/package-lock.json
HASH_MARKER="$NODE_MODULES/.wip-lock-hash"

current_hash() {
  [ -f "$LOCKFILE" ] && sha256sum "$LOCKFILE" 2>/dev/null | cut -c1-64
}

run_install() {
  echo "[dev-entrypoint] $1"
  (cd /app && npm ci --prefer-offline)
  current_hash > "$HASH_MARKER"
}

if [ ! -f "$NODE_MODULES/.package-lock.json" ]; then
  run_install "node_modules empty — running npm ci (first run, expect 30-60s)"
elif [ "$(current_hash)" != "$(cat "$HASH_MARKER" 2>/dev/null)" ]; then
  run_install "package-lock.json changed — re-running npm ci"
fi

exec "$@"
