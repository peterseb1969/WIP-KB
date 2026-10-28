#!/usr/bin/env python3
"""Offline regression tests for case attribution (CASE-957).

The session that wrote a CASE_RECORD (filed_by, authored_by) or CASE_RESPONSE
(author) is filled by the client from .claude/.session-id. An agent-typed value
must have a session ID's shape: an unexpanded `$(cat .claude/.session-id)` once
reached canonical as the literal attribution. --field values are explicit and
win unchecked.

No network — run: `python3 kb-client/test_attribution.py`.
"""
import argparse
import contextlib
import importlib.util
import io
import os
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)

_fails = []
SID = "APP-KB-20261028-221500"


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


posted = []
kb._post_write = lambda type_, data, *a, **k: posted.append(dict(data)) or 0

with_sentinel = tempfile.mkdtemp()
os.makedirs(os.path.join(with_sentinel, ".claude"))
with open(os.path.join(with_sentinel, ".claude", ".session-id"), "w") as f:
    f.write(SID + "\n")
without_sentinel = tempfile.mkdtemp()


def write(type_, frontmatter, project=with_sentinel, fields=None):
    """(exit code, posted data or None, stderr) for one cmd_write."""
    md = os.path.join(tempfile.mkdtemp(), "doc.md")
    with open(md, "w") as f:
        f.write("---\n" + "".join(f"{k}: {v}\n" for k, v in frontmatter.items()) + "---\nbody\n")
    args = argparse.Namespace(file=md, json=None, field=fields, edge=None, metadata=None,
                              format="text", hash_repo=None, no_hash_check=True)
    os.environ["CLAUDE_PROJECT_DIR"] = project
    cwd = os.getcwd()
    os.chdir(project)  # _read_local also looks in the cwd; keep the repo's own sentinel out
    posted.clear()
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            rc = kb.cmd_write(type_, args)
    finally:
        os.chdir(cwd)
    return rc, (posted[0] if posted else None), err.getvalue()


case = {"title": "t", "status": "open", "doc_status": "published", "type": "bug",
        "severity": "fyi", "component": "other", "target_yac": "any"}
resp = {"case_number": 1, "response_kind": "comment", "doc_status": "published"}

# 1. Omitted attribution is filled from the sentinel.
rc, data, _ = write("CASE_RECORD", case)
check("record.filled.rc", rc, 0)
check("record.filled.filed_by", data and data.get("filed_by"), SID)
check("record.filled.authored_by", data and data.get("authored_by"), SID)
rc, data, _ = write("CASE_RESPONSE", resp)
check("response.filled.author", data and data.get("author"), SID)

# 2. A well-formed typed value is kept, including mixed-case roles and old HHMM times.
for sid in ("BE-YAC-20261025-221016", "FRanC-20261026-195850", "APP-RC-20260409-1649"):
    rc, data, _ = write("CASE_RESPONSE", {**resp, "author": sid})
    check(f"response.kept.{sid}", (rc, data and data.get("author")), (0, sid))

# 3. The CASE-945 shape, placeholders and other non-IDs are refused before writing.
for bad in ("$(cat .claude/.session-id)", "<your session ID>", "unknown", "FRanC-20260523",
            "peter@example.com"):
    rc, data, err = write("CASE_RECORD", {**case, "authored_by": f'"{bad}"'})
    check(f"record.refused.{bad}", (rc, data), (1, None))
    check(f"record.refused.{bad}.msg", "omit authored_by" in err, True)

# 4. No sentinel and no value: refused, pointing at /wip-setup and /wip-wake.
rc, data, err = write("CASE_RESPONSE", resp, project=without_sentinel)
check("no_sentinel.rc", (rc, data), (1, None))
check("no_sentinel.msg", "/wip-setup" in err and "/wip-wake" in err, True)

# 5. --field is explicit and wins unchecked (imports write for other sessions).
rc, data, _ = write("CASE_RESPONSE", resp, fields=["author=WEB-UI"])
check("field.wins", (rc, data and data.get("author")), (0, "WEB-UI"))

# 6. Other types are untouched.
rc, data, _ = write("LESSON", {"title": "t", "authored_by": "anything"})
check("other_type.untouched", data and data.get("authored_by"), "anything")

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — case attribution is filled from the sentinel and checked")
