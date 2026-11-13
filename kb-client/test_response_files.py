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

# --- ## Questions (CASE-1290) ---------------------------------------------------
Q = """**Bottom line:** x

## Files in scope

- `a.py` — change

## Questions

1. **Split the bundle?** Into four cases:
   - (a) merge
   - (b) backup
2. **Read or admin for downloads?** Today read.
3. **Locked namespaces?** A policy call.
"""
check("numbered questions, nested options not counted", kb.parse_questions(Q), 3)
check("no section → None", kb.parse_questions("## Analysis\n1. x\n"), None)
check("prose-only section asks one",
      kb.parse_questions("## Questions\n\nShould the release cut also freeze wip-auth?\n"), 1)
check("bulleted questions count", kb.parse_questions("## Questions\n- a?\n- b?\n"), 2)
check("an empty section asks none", kb.parse_questions("## Questions\n\n## Next\n"), 0)
check("the section ends at the next heading",
      kb.parse_questions("## Questions\n1. a?\n## Notes\n1. not a question\n"), 1)


def derive_q(data, declared, explicit=frozenset()):
    real = kb._type_fields
    kb._type_fields = lambda t: declared
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            kb.derive_response_questions("CASE_RESPONSE", data, set(explicit))
    finally:
        kb._type_fields = real
    return data, err.getvalue()


d, err = derive_q({"response_kind": "respond", "body": Q}, {"questions", "body"})
check("declared: questions filled", d.get("questions"), 3)
d, err = derive_q({"response_kind": "respond", "body": Q}, {"body"})
check("namespace without the field: not sent, a note says so",
      ("questions" in d, "no questions field" in err), (False, True))
d, err = derive_q({"response_kind": "respond", "body": "## Analysis\nnone"}, {"questions"})
check("no section: nothing sent, no note", ("questions" in d, err), (False, ""))
d, err = derive_q({"response_kind": "respond", "body": Q, "questions": 7}, {"questions"})
check("a value the writer set wins", d["questions"], 7)


def owner_answer(type_, data, flag, declared):
    real = kb._type_fields
    kb._type_fields = lambda t: declared
    try:
        return kb.apply_owner_answer(type_, data, flag), data
    finally:
        kb._type_fields = real


err, d = owner_answer("CASE_RESPONSE", {"body": "x"}, True, {"body", "owner_answer"})
check("--owner-answer where declared: set, no refusal", (err, d.get("owner_answer")), (None, True))
err, d = owner_answer("CASE_RESPONSE", {"body": "x"}, True, {"body"})
check("--owner-answer where the template lacks it: refused, nothing set",
      (err is not None and "no owner_answer field" in err, "owner_answer" in d), (True, False))
err, d = owner_answer("CASE_RESPONSE", {"body": "x"}, True, None)
check("--owner-answer when the gateway lists no fields: refused", err is not None, True)
err, d = owner_answer("CASE_RESPONSE", {"body": "x", "owner_answer": True}, False, {"body"})
check("owner_answer typed as a field is checked the same way", err is not None, True)
err, d = owner_answer("CASE_RECORD", {"body": "x"}, True, {"body", "owner_answer"})
check("--owner-answer on another type: refused", "CASE_RESPONSE only" in (err or ""), True)
err, d = owner_answer("CASE_RESPONSE", {"body": "x"}, False, {"body"})
check("no mark: nothing asked, nothing set", (err, "owner_answer" in d), (None, False))

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — all files-in-scope cases pass")
