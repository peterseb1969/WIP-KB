#!/usr/bin/env bash
# PreToolUse/Bash guard: refuse ad-hoc WRITE calls to the canonical instance.
#
# Origin: LESSON-44. Twice on 2026-07-29 I ran test writes against kb.internal,
# the second creating a duplicate paper in the middle of reconciling a case about
# duplicate papers. Canonical is deletion_mode=retain, so nothing there is ever
# really removed — a "revert" only marks the row inactive and the minted number is
# consumed forever. The rule "canonical is read-mostly" was already in CLAUDE.md
# and had been read that morning; knowing it did not reach the moment of the
# write. Hence a gate on the action rather than another line in a reading list.
#
# Canonical hosts: prod.internal (WIP; the KB app is kb.prod.internal) since the
# apps-at-root cut-over of 2026-11-09, and kb.internal (kb.kb.internal for the KB),
# the previous canonical install, still reachable and still holding data. Both are
# guarded: a host the guard does not name is a host it does not protect, so a
# canonical move must update CANONICAL_HOSTS in the same change.
CANONICAL_HOSTS='(^|[^a-z0-9.-])([a-z0-9-]+\.)?(prod|kb)\.internal'
#
# Deliberately narrow, because a guard that blocks ordinary work gets disabled:
#   - fires ONLY on commands that literally name a canonical host
#   - `kbc …` never matches: the served client resolves the host from
#     .claude/kb.json, so filing cases and responses is untouched
#   - POST to the query endpoints is a READ and stays allowed
#   - ALLOW_CANONICAL_WRITE=1 is the escape hatch for deliberate migrations
set -euo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -n "$CMD" ] || exit 0

# Not aimed at canonical → not our business.
printf '%s' "$CMD" | grep -Eq "$CANONICAL_HOSTS" || exit 0

# Deliberate, marked migration.
printf '%s' "$CMD" | grep -q 'ALLOW_CANONICAL_WRITE=1' && exit 0

# Read-only POSTs. The query surfaces take a body, so method alone cannot tell a
# read from a write; these paths are reads and must stay free.
if printf '%s' "$CMD" | grep -Eq '(reporting-sync/query|documents/query|entries/lookup|/search)'; then
  exit 0
fi

# Write indicators. Three families, because a canonical write does not always
# look like curl:
#   1. an explicit write verb, or curl's -d/--data (which implies POST). -d counts
#      only in a curl command: `tr -d`, `cut -d` and friends are not writes.
#   2. a python urllib method= write
#   3. a migration tool pointed at canonical — `--apply`, or one of the scripts
#      that writes unconditionally. These carry no HTTP verb on the command line,
#      so pattern (1) never sees them, and they are exactly the runs that must be
#      deliberate. Their DRY-RUNS stay allowed: rehearsing against canonical is
#      read-only and is the habit worth encouraging, not taxing.
if printf '%s' "$CMD" | grep -Eqi -- \
  '-X[[:space:]]+(POST|PUT|PATCH|DELETE)|--request[[:space:]]+(POST|PUT|PATCH|DELETE)|curl[^|;&]*[[:space:]]-d[[:space:]]|--data|method[[:space:]]*=[[:space:]]*.(POST|PUT|PATCH|DELETE)|--apply|add-document-fields|add-content-hash-field|add-topics-field|create-kb-topic-taxonomy'; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: write-method HTTP call to canonical (prod.internal / kb.internal). Canonical is deletion_mode=retain — nothing written there can be removed, only marked inactive, and a minted number is consumed permanently. Test on localhost (hotwired to the working tree), then prod-test. If this is a deliberate migration Peter asked for, prefix the command with ALLOW_CANONICAL_WRITE=1. See LESSON-44."}}
JSON
  exit 0
fi
exit 0
