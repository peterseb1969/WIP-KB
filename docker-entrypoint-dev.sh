#!/bin/sh
# Dev-container entrypoint (the CASE-58 pattern): keeps the named node_modules
# volume in step with what the container runs.
#
# Handles:
#   1. First-start populate: named volume /app/node_modules is empty → npm ci.
#   2. Staleness: the install is redone when package-lock.json, the Node version
#      or the libc changes. The volume outlives image changes, so a bump of the
#      base image (Node 20 → 24, say) would otherwise keep modules installed for
#      the old Node, native packages (esbuild, rollup) included.
#   3. Corrupted install (killed mid-install): .package-lock.json absent → retry.
set -e

NODE_MODULES=/app/node_modules
LOCKFILE=/app/package-lock.json
HASH_MARKER="$NODE_MODULES/.wip-lock-hash"

# The libc the image's Node is linked against: musl on alpine, glibc otherwise.
libc() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi
}

current_hash() {
  [ -f "$LOCKFILE" ] || return 0
  { sha256sum "$LOCKFILE" | cut -c1-64; node -v; libc; } | sha256sum | cut -c1-64
}

run_install() {
  echo "[dev-entrypoint] $1"
  (cd /app && npm ci --prefer-offline)
  current_hash > "$HASH_MARKER"
}

if [ ! -f "$NODE_MODULES/.package-lock.json" ]; then
  run_install "node_modules empty — running npm ci (first run, expect 30-60s)"
elif [ "$(current_hash)" != "$(cat "$HASH_MARKER" 2>/dev/null)" ]; then
  run_install "package-lock.json, Node version or libc changed — re-running npm ci"
fi

exec "$@"
