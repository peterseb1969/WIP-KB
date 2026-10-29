#!/usr/bin/env python3
"""Offline regression test: a patch sends every --match field (CASE-972).

`--match` used to be a single-value option, so `--match case_number=959
--match response_seq=3` sent only the last pair, and the gateway patched the
first document that pair matched: another case's response. The gateway now
refuses a match several documents satisfy (409); this test pins the client
half: --match repeats, and every pair reaches the request.

No network — run: `python3 kb-client/test_patch_match.py`.
"""
import contextlib
import importlib.util
import io
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)

_fails = []


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


def run(*argv):
    """main() with argv; returns the (path, body) of every gateway post."""
    posted = []
    kb.gw_post = lambda path, body: posted.append((path, body)) or {"result": "updated", "document_id": "x"}
    saved = sys.argv
    sys.argv = ["kb-write.py", *argv]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            rc = kb.main()
    finally:
        sys.argv = saved
    return rc, posted


rc, posted = run("CASE_RESPONSE", "--patch", "doc_status=published",
                 "--match", "case_number=959", "--match", "response_seq=3")
check("two --match: exit code", rc, 0)
check("two --match: both fields sent", posted[0][1]["match"], {"case_number": 959, "response_seq": 3})
check("two --match: path", posted[0][0], "/write/CASE_RESPONSE")

rc, posted = run("CASE_RECORD", "--patch", "status=closed", "--match", "case_number=12")
check("one --match still works", posted[0][1]["match"], {"case_number": 12})

with contextlib.redirect_stderr(io.StringIO()):
    rc, posted = run("CASE_RECORD", "--patch", "status=closed")
check("no --match is refused", (rc, posted), (2, []))

if _fails:
    print("FAIL:\n  " + "\n  ".join(_fails))
    sys.exit(1)
print("OK — every --match field reaches the patch request")
