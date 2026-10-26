#!/bin/sh
# install.sh (CASE-440) — bootstrap the served KB client onto this machine.
#
#   curl -fsSk -H "X-API-Key: $(cat <key-file>)" \
#     https://<kb-host>/apps/kb/server-api/kb-client/install \
#     | KB_APP_URL=https://<kb-host> KB_API_KEY_FILE=<key-file> sh
#
# <key-file> is the KB API key file issued when the project was installed. Run
# from a project with a .claude/kb.json, leave both variables out and the pair
# is read from there instead.
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
#   KB_API_KEY_FILE   no default: from .claude/kb.json, or set it with KB_APP_URL
#   KB_CLIENT_CACHE   ~/.cache/wip-kb-client
#
# POSIX sh (curl|sh target) — no bashisms.
set -eu

# The instance URL and its key come from ONE source, as a pair — the same rule
# as kb-client.sh (CASE-950), so a key is never sent to an instance it was not
# issued for:
#   1. the environment, when KB_APP_URL or KB_API_KEY_FILE is set: then BOTH
#      must be set there (the one-liner above passes both);
#   2. otherwise the project's .claude/kb.json ($CLAUDE_PROJECT_DIR's when set,
#      else the cwd's), which must name both kb_app_url and kb_api_key_file — a
#      kb.json that exists without both is exit 2 (CASE-755), never a silent
#      fall-through to the canonical default;
#   3. otherwise the canonical default URL, with a key still required below.
KBJSON="${CLAUDE_PROJECT_DIR:+$CLAUDE_PROJECT_DIR/.claude/kb.json}"
KBJSON="${KBJSON:-./.claude/kb.json}"
if [ -n "${KB_APP_URL:-}" ] || [ -n "${KB_API_KEY_FILE:-}" ]; then
  if [ -z "${KB_APP_URL:-}" ] || [ -z "${KB_API_KEY_FILE:-}" ]; then
    echo "kb-client install: set KB_APP_URL and KB_API_KEY_FILE together (the instance you fetched this from, and the key issued for it), or neither to use .claude/kb.json — half a pair is never completed from kb.json." >&2
    exit 2
  fi
elif [ -r "$KBJSON" ]; then
  KB_APP_URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("kb_app_url",""))' "$KBJSON" 2>/dev/null || true)"
  KB_API_KEY_FILE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("kb_api_key_file",""))' "$KBJSON" 2>/dev/null || true)"
  if [ -z "$KB_APP_URL" ] || [ -z "$KB_API_KEY_FILE" ]; then
    echo "kb-client install: $KBJSON exists but does not name both kb_app_url and kb_api_key_file — fix the file, or set KB_APP_URL and KB_API_KEY_FILE together." >&2
    exit 2
  fi
fi

KB_APP_URL="${KB_APP_URL:-https://kb.internal}"
KB_APP_BASE_PATH="${KB_APP_BASE_PATH-/apps/kb}"  # `-` not `:-`: explicit empty = root-mounted instance
KBC="${KB_CLIENT_CACHE:-$HOME/.cache/wip-kb-client}"
# The key is per-installation configuration, so there is no default path to guess.
KEYFILE="${KB_API_KEY_FILE:-}"
case "$KEYFILE" in "~/"*) KEYFILE="$HOME/${KEYFILE#\~/}" ;; esac
if [ -z "$KEYFILE" ]; then
  echo "kb-client install: no KB API key file configured. Set kb_api_key_file in .claude/kb.json, or KB_API_KEY_FILE, to the key file issued when this project was installed." >&2
  exit 2
fi

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

# kbc shim (CASE-510): a stable, name-keyed entrypoint so a single Bash(kbc:*)
# allowlist rule can retire the per-call approval tax — the long
# `bash <cache>/kb-client.sh` form defeats prefix matching under $VAR-expansion
# and ~-vs-absolute paths. Version-free: it just execs the runner, which
# self-refreshes the bundle underneath it by .bundle_digest. Rewritten on every
# install (idempotent). Pairs with BE-YAC's Bash(kbc:*) baseline.
BIN="${KBC_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
cat > "$BIN/kbc" <<'SHIM'
#!/bin/sh
# kbc — stable entrypoint for the served KB client (CASE-510). Auto-generated by
# the kb-client installer/runner; safe to delete (any install or kb-client.sh run
# restores it). A wrapper (not a symlink) so kb-client.sh resolves its siblings +
# .claude/kb.json by the cache path and the caller's cwd. Honors KB_CLIENT_CACHE.
exec bash "${KB_CLIENT_CACHE:-$HOME/.cache/wip-kb-client}/kb-client.sh" "$@"
SHIM
chmod +x "$BIN/kbc"
echo "kb-client install: kbc shim -> $BIN/kbc"
case ":$PATH:" in
  *":$BIN:"*) : ;;
  *) echo "kb-client install: NOTE $BIN is not on PATH — add it so 'kbc' resolves: export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2 ;;
esac

echo "kb-client install: ready — run scripts via:"
echo "  kbc <script.py> [args...]   (or: bash $KBC/kb-client.sh …)   # self-refreshes on digest change"
echo "playbook: $KBC/case-workflow.md"
