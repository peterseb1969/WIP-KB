#!/usr/bin/env python3
"""Offline regression test: a case can be named as the KB prints it.

Agents type CASE-1179 where a case number is wanted, and the client refused it
("case identifier must be an integer"). Every place that takes a case number now
accepts 1179, "1179", CASE-1179 (any case) and #1179; `case-fetch.py case` also
takes a response handle, CASE-1179#3. In writes, data.case_number, an edge to a
CASE_RECORD and --match case_number=… reach the gateway as the integer.

No network — run: `python3 kb-client/test_case_handle.py`.
"""
import contextlib
import importlib.util
import io
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
import kb_client_core as core  # noqa: E402

_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)
_fspec = importlib.util.spec_from_file_location("case_fetch", os.path.join(_here, "case-fetch.py"))
cf = importlib.util.module_from_spec(_fspec)
_fspec.loader.exec_module(cf)

_fails = []


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


def raises(name, fn):
    try:
        fn()
    except ValueError:
        return
    _fails.append(f"{name}: no ValueError")


# --- the parser ---
for s in ("1179", "CASE-1179", "case-1179", "Case-1179", " CASE-1179 ", "#1179", "CASE1179", 1179):
    check(f"parse {s!r}", core.parse_case_handle(s), (1179, None))
check("response handle", core.parse_case_handle("CASE-1179#3"), (1179, 3))
check("response handle, spaced", core.parse_case_handle("CASE-1179 # 3"), (1179, 3))
for s in ("", "CASE-", "CASE-x", "PAPER-12", "1179.5", "-1179", True):
    raises(f"refuse {s!r}", lambda s=s: core.parse_case_handle(s))
check("case number", core.parse_case_number("CASE-1179"), 1179)
raises("a response is not a case number", lambda: core.parse_case_number("CASE-1179#3"))

# --- case-fetch: `case CASE-1179` and `case CASE-1179#3` ---
calls = []
cf.fetch_case_payload = lambda n, view, resp: calls.append((n, view, resp)) or {"case": {}, "responses": []}
cf.render_case = lambda payload, view: ""


def fetch(*argv):
    saved = sys.argv
    sys.argv = ["case-fetch.py", "case", *argv]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                cf.main()
            except SystemExit as e:
                return e.code
    finally:
        sys.argv = saved


check("case CASE-1179: exit", fetch("CASE-1179"), 0)
check("case CASE-1179: fetched", calls[-1], (1179, "both", None))
check("case 1179 still works", (fetch("1179"), calls[-1]), (0, (1179, "both", None)))
check("case CASE-1179#3: exit", fetch("CASE-1179#3"), 0)
check("case CASE-1179#3: reads response 3", calls[-1], (1179, "responses", "3"))
n = len(calls)
check("handle and --response disagree: refused", fetch("CASE-1179#3", "--response", "2"), 2)
check("…and nothing fetched", len(calls), n)
check("garbage: refused", fetch("CASE-abc"), 2)


# --- kb-write: data, edges, --match ---
def run(*argv):
    posted = []
    kb.gw_post = lambda path, body: posted.append((path, body)) or {"result": "created", "document_id": "x"}
    saved = sys.argv
    sys.argv = ["kb-write.py", *argv]
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = kb.main()
    finally:
        sys.argv = saved
    return rc, posted


rc, posted = run("CASE_RECORD", "--patch", "status=closed", "--match", "case_number=CASE-1179")
check("--match case_number=CASE-1179", (rc, posted[0][1]["match"] if posted else None), (0, {"case_number": 1179}))

data = {"case_number": "CASE-1179", "response_kind": "comment"}
edges = [{"type": "RESPONDS_TO", "target_type": "CASE_RECORD", "target_key": "CASE-1179"},
         {"type": "CONTINUES_FROM", "target_type": "SESSION", "target_key": "APP-KB-1"}]
kb.normalise_case_refs("CASE_RESPONSE", data, edges)
check("data.case_number", data["case_number"], 1179)
check("edge to a case", edges[0]["target_key"], 1179)
check("other edges untouched", edges[1]["target_key"], "APP-KB-1")
other = {"case_number": "CASE-1179"}
kb.normalise_case_refs("LESSON", other, [])
check("a type without case_number semantics is untouched", other["case_number"], "CASE-1179")

if _fails:
    print("FAIL:\n  " + "\n  ".join(_fails))
    sys.exit(1)
print("OK — case handles are accepted wherever a case number is")
