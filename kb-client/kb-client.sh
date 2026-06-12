#!/usr/bin/env bash
# kb-client.sh (CASE-437/440) — fetch/refresh the version-matched KB client served
# by the running KB instance, then run one of its scripts.
#
# APP-KB-owned and SERVED FROM THE INSTANCE (this file ships inside the bundle and
# is materialized by `curl …/server-api/kb-client/install | sh`). Relocated out of
# FR-YAC/tools/ per CASE-440 — no FR-YAC checkout in the filing path. It contains
# no loader logic: it fetches the loaders (digest-checked) and runs them.
#
# Usage:  bash <cache>/kb-client.sh <script.py> [args...]
#   e.g.  bash ~/.cache/wip-kb-client/kb-client.sh case-fetch.py case 437
#         bash ~/.cache/wip-kb-client/kb-client.sh add-to-kb.py yac-discussions/CASE-…md
#
# Env (defaults target the canonical wip-kb.local KB app):
#   KB_APP_URL        https://wip-kb.local
#   KB_APP_BASE_PATH  /apps/kb
#   KB_API_KEY_FILE   ~/.wip-deploy/wip-kb/secrets/api-key
#   KB_CLIENT_CACHE   ~/.cache/wip-kb-client
#   KB_VERIFY_TLS     false (self-signed dev certs)
#
# Runs from the CALLER's cwd (so relative file args resolve against the calling
# repo) with PYTHONPATH=$KBC (so `from kb_write_core import …` resolves). The
# served scripts handshake against the instance manifest and refuse to write on
# schema_version skew because this wrapper exports KB_APP_URL/KB_APP_BASE_PATH.
#
# CASE-444 note: KB_API_KEY_FILE is exported ONLY when the caller set it. The
# served scripts resolve the same default themselves; always exporting the
# resolved default would defeat their pairing guard (a KB_BASE_URL override
# must fail loud when no key was explicitly provided, not silently run with
# the canonical instance's key).
set -euo pipefail

KB_APP_URL="${KB_APP_URL:-https://wip-kb.local}"
KB_APP_BASE_PATH="${KB_APP_BASE_PATH-/apps/kb}"  # `-` not `:-`: explicit empty = root-mounted instance
KB_VERIFY_TLS="${KB_VERIFY_TLS:-false}"
KBC="${KB_CLIENT_CACHE:-$HOME/.cache/wip-kb-client}"
export KB_APP_URL KB_APP_BASE_PATH KB_VERIFY_TLS
# Wrapper-local key for its own fetch curls; exported only if caller-set (CASE-444).
KEYFILE="${KB_API_KEY_FILE:-$HOME/.wip-deploy/wip-kb/secrets/api-key}"
if [ -n "${KB_API_KEY_FILE:-}" ]; then export KB_API_KEY_FILE; fi

if [ ! -r "$KEYFILE" ]; then echo "kb-client: API key not readable at $KEYFILE" >&2; exit 2; fi
KEY="$(cat "$KEYFILE")"
BASE="$KB_APP_URL$KB_APP_BASE_PATH/server-api/kb-client"

# Refetch the cached client when the instance's bundle_digest differs. bundle_digest
# is a sha256 over the served file contents, auto-derived at serve time (CASE-437) —
# it changes whenever ANY served file changes, with no hand-maintained version to
# drift. schema_version still guards WRITE-refuse (the served scripts' handshake);
# bundle_digest is the fetch-currency signal. Fallback to client_version for an
# instance that hasn't deployed the auto-derived manifest yet.
want="$(curl -fsSk -m 15 -H "X-API-Key: $KEY" "$BASE/manifest" \
        | python3 -c 'import sys,json; m=json.load(sys.stdin); print(m.get("bundle_digest") or m.get("client_version") or "none")')" \
  || { echo "kb-client: cannot reach manifest at $BASE/manifest" >&2; exit 2; }
have="$(cat "$KBC/.bundle_digest" 2>/dev/null || echo none)"
if [ "$want" != "$have" ]; then
  tmp="$(mktemp)"
  curl -fsSk -m 30 -H "X-API-Key: $KEY" "$BASE/download" -o "$tmp" \
    || { echo "kb-client: download failed from $BASE/download" >&2; rm -f "$tmp"; exit 2; }
  rm -rf "$KBC"; mkdir -p "$KBC"
  python3 - "$tmp" "$KBC" "$want" <<'PY'
import json, os, sys
bundle, kbc, ver = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(bundle))
for name, content in d["files"].items():
    src = content if isinstance(content, str) else content.get("content", "")
    open(os.path.join(kbc, name), "w").write(src)
open(os.path.join(kbc, ".bundle_digest"), "w").write(ver)  # refetch gate (bundle_digest; client_version fallback)
PY
  rm -f "$tmp"
fi

[ "$#" -ge 1 ] || { echo "usage: kb-client.sh <script.py> [args...]" >&2; exit 2; }
script="$1"; shift
exec env PYTHONPATH="$KBC${PYTHONPATH:+:$PYTHONPATH}" python3 "$KBC/$script" "$@"
