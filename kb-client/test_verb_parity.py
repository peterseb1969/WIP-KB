#!/usr/bin/env python3
"""Doc-parity regression: the curated docs must not lag the code (CASE-692/718).

Two checks, both over surfaces that are enumerable from source:
  1. every `case-fetch.py` verb appears in the two full-roster summaries;
  2. every KB gateway route appears in the Client page's endpoint table.

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

# 3. Every gateway route must appear in the Client page's endpoint table.
#    Verbs were only half the surface: /read/:type, /search, /edges, /flags and
#    /library-docs shipped without ever reaching that table, so a reader concluded
#    they did not exist (CASE-718). Routes are enumerable from source, so this is
#    mechanically checkable — unlike the playbook's prose, which stays a human
#    responsibility and is deliberately NOT faked into a test.
ROUTE_RE = re.compile(r"router\.(get|post)\(\s*['\"]([^'\"]+)['\"]")
ENDPOINT_RE = re.compile(r"\[\s*['\"](GET|POST)['\"]\s*,\s*['\"]([^'\"]*)['\"]")

_gw = _read(os.path.join(_repo, "server", "kb-gateway.routes.ts"))
_cp = _read(os.path.join(_repo, "src", "pages", "ClientPage.tsx"))
if _gw is None or _cp is None:
    print("skip: gateway routes / ClientPage not found (running outside the repo?)")
else:
    routes = [(m.group(1).upper(), m.group(2)) for m in ROUTE_RE.finditer(_gw)]
    documented = [(m.group(1), m.group(2)) for m in ENDPOINT_RE.finditer(_cp)]
    if len(routes) < 5:
        _fails.append(f"route scrape found only {routes!r} — regex stale vs kb-gateway.routes.ts?")
    missing = []
    for method, path in routes:
        # The table writes paths as `kb<path>`. The boundary stops a parent route
        # being satisfied by a child: `kb/edges` must not match `kb/edges/:handle`.
        pat = re.escape("kb" + path) + r"(?![/\w:])"
        if not any(m == method and re.search(pat, text) for m, text in documented):
            missing.append(f"{method} {path}")
    if missing:
        _fails.append(
            "src/pages/ClientPage.tsx: gateway routes absent from the endpoint table: "
            + ", ".join(missing)
        )

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print(f"OK — {len(verbs)} case-fetch verbs in every roster, and every gateway route "
      f"documented on the Client page: {verbs}")
