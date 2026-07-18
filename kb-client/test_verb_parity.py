#!/usr/bin/env python3
"""Doc-parity regression: every case-fetch.py verb must appear in the curated
roster summaries that clients read (CASE-692).

argparse `--help` always lists the real verbs, so the hazard is never absolute
absence — it's the hand-kept roster lines silently drifting behind the code
(what bit twice: library/edges/flags/read were added to case-fetch.py but left
out of the rosters). This asserts each `add_parser("x")` verb is named in the
two surfaces that are meant to be COMPLETE rosters:

  - kb-client/README.md      — the served roster table row
  - src/pages/ClientPage.tsx — the app's rendered SCRIPT_ROLES entry

The case playbook (case-workflow.md) and the module `Usage:` docstring are
intentionally PARTIAL — a workflow reference and usage examples, not a full
roster (journey/fireside/library are documented elsewhere / via --help) — so
they are deliberately NOT policed here; doing so would force unrelated verbs
into a case playbook.

No network, no deps. Run: `python3 kb-client/test_verb_parity.py`.
A roster file that isn't found is SKIPPED (e.g. when this test runs from the
served bundle cache rather than the repo). The check is meaningful in-repo —
where drift is introduced and where `npm test` runs it.
"""
import os
import re

_here = os.path.dirname(os.path.abspath(__file__))
_repo = os.path.dirname(_here)


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


_fails = []

# 1. Enumerate the authoritative verb set from case-fetch.py's subparsers.
_src = _read(os.path.join(_here, "case-fetch.py")) or ""
verbs = re.findall(r'\.add_parser\(\s*["\']([a-z][a-z0-9_-]*)["\']', _src)
if len(verbs) < 3:
    # The scrape found ~nothing — the regex has gone stale vs the code. Fail
    # loud rather than silently vacuously-pass (a linter that checks nothing is
    # worse than no linter).
    _fails.append(f"verb scrape found only {verbs!r} — regex stale vs case-fetch.py?")

# 2. The curated full-roster surfaces every verb must be named in.
ROSTERS = [
    ("kb-client/README.md", os.path.join(_here, "README.md")),
    ("src/pages/ClientPage.tsx", os.path.join(_repo, "src", "pages", "ClientPage.tsx")),
]

for label, path in ROSTERS:
    text = _read(path)
    if text is None:
        print(f"skip: {label} not found (running outside the repo?)")
        continue
    # Case-sensitive, alnum-boundaried match. Verbs are lowercase tokens; this
    # will not false-match a MISSING verb against prose like "Read commands",
    # "cases", or "faceted lists" (capital / trailing-s breaks the boundary).
    missing = [
        v for v in verbs
        if not re.search(r'(?<![A-Za-z0-9])' + re.escape(v) + r'(?![A-Za-z0-9])', text)
    ]
    if missing:
        _fails.append(f"{label}: case-fetch verbs missing from the roster: {missing}")

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print(f"OK — all {len(verbs)} case-fetch verbs present in every roster: {verbs}")
