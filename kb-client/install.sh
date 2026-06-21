#!/bin/sh
# install.sh (CASE-440) — bootstrap the served KB client onto this machine.
#
#   curl -fsSk -H "X-API-Key: $(cat ~/.wip-deploy/kb/secrets/api-key)" \
#     https://kb.internal/apps/kb/server-api/kb-client/install | sh
#
# Materializes the version-matched client bundle (loaders + kb-client.sh runner +
# case-workflow.md) into ${KB_CLIENT_CACHE:-$HOME/.cache/wip-kb-client}, digest-
# checked and idempotent. After install, everything goes through the runner —
# which self-refreshes on bundle_digest change, so install is one-time per machine:
#
#   bash ~/.cache/wip-kb-client/kb-client.sh case-fetch.py case 437
#
# Env (same family as kb-client.sh):
#   KB_APP_URL        https://kb.internal      KB_APP_BASE_PATH  /apps/kb
#   KB_API_KEY_FILE   ~/.wip-deploy/kb/secrets/api-key
#   KB_CLIENT_CACHE   ~/.cache/wip-kb-client
#
# POSIX sh (curl|sh target) — no bashisms.
set -eu

# When run from a repo, derive the instance from .claude/kb.json (single source
# of truth; PAIRED url+key so a hostname cutover is one edit). Best-effort: a
# bare `curl|sh` from an arbitrary cwd just uses the literal fallbacks below.
if [ -r ./.claude/kb.json ]; then
  if [ -z "${KB_APP_URL:-}" ]; then
    KB_APP_URL="$(python3 -c 'import json;print(json.load(open(".claude/kb.json")).get("kb_app_url",""))' 2>/dev/null || true)"
  fi
  if [ -z "${KB_API_KEY_FILE:-}" ]; then
    _kbj_key="$(python3 -c 'import json;print(json.load(open(".claude/kb.json")).get("kb_api_key_file",""))' 2>/dev/null || true)"
    [ -n "$_kbj_key" ] && KB_API_KEY_FILE="$_kbj_key"
  fi
fi

KB_APP_URL="${KB_APP_URL:-https://kb.internal}"
KB_APP_BASE_PATH="${KB_APP_BASE_PATH-/apps/kb}"  # `-` not `:-`: explicit empty = root-mounted instance
KBC="${KB_CLIENT_CACHE:-$HOME/.cache/wip-kb-client}"
KEYFILE="${KB_API_KEY_FILE:-$HOME/.wip-deploy/kb/secrets/api-key}"

if [ ! -r "$KEYFILE" ]; then
  echo "kb-client install: API key not readable at $KEYFILE (set KB_API_KEY_FILE)" >&2
  exit 2
fi
KEY="$(cat "$KEYFILE")"
BASE="$KB_APP_URL$KB_APP_BASE_PATH/server-api/kb-client"

want="$(curl -fsSk -m 15 -H "X-API-Key: $KEY" "$BASE/manifest" \
        | python3 -c 'import sys,json; m=json.load(sys.stdin); print(m.get("bundle_digest") or m.get("client_version") or "none")')" \
  || { echo "kb-client install: cannot reach manifest at $BASE/manifest" >&2; exit 2; }
have="$(cat "$KBC/.bundle_digest" 2>/dev/null || echo none)"

if [ "$want" = "$have" ]; then
  echo "kb-client install: already current (bundle_digest $want) in $KBC"
else
  tmp="$(mktemp)"
  curl -fsSk -m 30 -H "X-API-Key: $KEY" "$BASE/download" -o "$tmp" \
    || { echo "kb-client install: download failed from $BASE/download" >&2; rm -f "$tmp"; exit 2; }
  rm -rf "$KBC"; mkdir -p "$KBC"
  python3 - "$tmp" "$KBC" "$want" <<'PY'
import json, os, sys
bundle, kbc, ver = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(bundle))
for name, content in d["files"].items():
    src = content if isinstance(content, str) else content.get("content", "")
    open(os.path.join(kbc, name), "w").write(src)
open(os.path.join(kbc, ".bundle_digest"), "w").write(ver)
print(f"kb-client install: materialized {len(d['files'])} files (bundle_digest {ver[:16]}…)")
PY
  rm -f "$tmp"
fi

echo "kb-client install: ready — run scripts via:"
echo "  bash $KBC/kb-client.sh <script.py> [args...]   # self-refreshes on digest change"
echo "playbook: $KBC/case-workflow.md"
