#!/usr/bin/env python3
"""Offline tests for kb-write.py's `## Files in scope` handling.

A response names the files its fix would change or read in a `## Files in scope`
section. kb-write.py copies that list into CASE_RESPONSE's files_change /
files_read fields, so a scheduler compares data rather than parsing markdown. It
sends them only where the namespace's template declares them (WIP refuses an
undeclared field), and warns, never refuses, when a respond lacks the section.

No network: the gateway's /types answer is stubbed.
Run: `python3 kb-client/test_response_files.py`.
"""
import contextlib
import importlib.util
import io
import os

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)

_fails = []


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


BODY = """**Bottom line:** x · **Root cause:** y · **Recommendation:** implement as filed

## Files in scope

- `docs/playbooks/case-workflow.md` — change (the served playbook)
- `server/seed/templates/12b_CASE_RESPONSE.json` — change, **shared contract** (served schema)
- `kb-client/test_response_files.py`, `kb-client/manifest.json` — change
- `server/kb-gateway.routes.ts` — read (writes resolve the latest version)
* src/pages/CasePage.tsx: read
- `docs/playbooks/case-workflow.md` — read
1. `server/lib/claims.ts` - **change**

A change to the template is a shared contract.

## Analysis

- `not/in/scope.ts` — change
"""

files, bad = kb.parse_files_in_scope(BODY)
check("change list, in order, a path with two markings kept once", files["files_change"], [
    "docs/playbooks/case-workflow.md", "server/seed/templates/12b_CASE_RESPONSE.json",
    "kb-client/test_response_files.py", "kb-client/manifest.json", "server/lib/claims.ts"])
check("read list: bare path, colon separator; a path also marked change is dropped",
      files["files_read"], ["server/kb-gateway.routes.ts", "src/pages/CasePage.tsx"])
check("prose in the section is not a bullet, so nothing is unread", bad, [])

check("no section → None", kb.parse_files_in_scope("## Analysis\n- `a` — change\n"), None)
check("heading is case-insensitive, may end in a colon",
      kb.parse_files_in_scope("## files in scope:\n- `a.py` — change\n")[0]["files_change"], ["a.py"])
check("the section ends at the next heading",
      kb.parse_files_in_scope("## Files in scope\n- `a` — read\n# Title\n- `b` — read\n")[0]["files_read"], ["a"])
check("the template's ## Scope section ends the file list",
      kb.parse_files_in_scope("## Files in scope\n- `a` — change\n\n## Scope\n\n"
                              "widened:\n- `b.py:12` — change, same defect\n")[0],
      {"files_change": ["a"], "files_read": []})
check("a ### subheading does not end it",
      kb.parse_files_in_scope("## Files in scope\n### server\n- `a` — read\n")[0]["files_read"], ["a"])
check("bullets inside a code fence are not read",
      kb.parse_files_in_scope("## Files in scope\n```\n- `x` — change\n```\n- `a` — read\n")[0],
      {"files_change": [], "files_read": ["a"]})
_, bad = kb.parse_files_in_scope("## Files in scope\n- `a.py` — touches the parser\n- just words here\n")
check("bullets without a kind or a path come back unread", bad,
      ["`a.py` — touches the parser", "just words here"])


def derive(data, declared, explicit=frozenset()):
    calls = []

    def fake_type_fields(t):
        calls.append(t)
        return declared
    real = kb._type_fields
    kb._type_fields = fake_type_fields
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            kb.derive_response_files("CASE_RESPONSE", data, set(explicit))
    finally:
        kb._type_fields = real
    return data, err.getvalue(), calls


ALL = {"case_number", "response_seq", "body", "files_change", "files_read"}
OLD = {"case_number", "response_seq", "body"}

d, err, _ = derive({"response_kind": "respond", "body": BODY}, ALL)
check("declared: fields filled", (d.get("files_change", [])[:1], d.get("files_read")),
      (["docs/playbooks/case-workflow.md"], ["server/kb-gateway.routes.ts", "src/pages/CasePage.tsx"]))
check("declared: no warning", "WARNING" in err, False)

d, err, _ = derive({"response_kind": "respond", "body": BODY}, OLD)
check("namespace without the fields: nothing sent", "files_change" in d or "files_read" in d, False)
check("namespace without the fields: a note says so", "has no files_change/files_read" in err, True)

d, err, _ = derive({"response_kind": "respond", "body": BODY}, None)
check("gateway that lists no fields: nothing sent", "files_change" in d, False)

d, err, calls = derive({"response_kind": "respond", "body": "## Analysis\nno list"}, ALL)
check("respond without the section: warned", "no '## Files in scope' section" in err, True)
check("respond without the section: not sent, /types not asked", ("files_change" in d, calls), (False, []))

d, err, _ = derive({"response_kind": "comment", "body": "a remark"}, ALL)
check("comment without the section: no warning", err, "")

d, err, _ = derive({"response_kind": "implement", "body": BODY}, ALL)
check("implement with the section: fields filled too", "files_change" in d, True)

d, err, calls = derive({"response_kind": "respond", "body": BODY, "files_change": ["mine"]}, ALL)
check("a value the writer set wins", (d["files_change"], "files_read" in d, calls), (["mine"], False, []))

d, err, calls = derive({"response_kind": "respond", "body": "## Files in scope\n- nothing yet\n"}, ALL)
check("section with no readable line: warned twice, nothing sent",
      (err.count("WARNING"), "files_change" in d, calls), (2, False, []))

data = {"response_kind": "respond", "body": BODY}
kb.derive_response_files("CASE_RECORD", data, set())
check("other types are left alone", "files_change" in data, False)

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — all files-in-scope cases pass")
