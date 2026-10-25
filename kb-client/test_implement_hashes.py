#!/usr/bin/env python3
"""Offline regression tests for kb-write.py's implement-response hash check (CASE-935).

An implement response is where a reader finds the fix, so every commit hash it
cites must be on a remote branch. A hash copied from a local branch before a
rebase-and-push still resolves in the author's clone but nowhere else; these
tests build that situation with a temporary repo and a bare remote.

No network — run: `python3 kb-client/test_implement_hashes.py`.
"""
import argparse
import contextlib
import importlib.util
import io
import os
import subprocess
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)

_fails = []
_env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": os.devnull}


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


def git(repo, *argv):
    return subprocess.run(["git", "-C", repo, *argv], capture_output=True, text=True,
                          env=_env, check=True).stdout.strip()


def commit(repo, name):
    with open(os.path.join(repo, name), "w") as f:
        f.write(name)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", name)
    return git(repo, "rev-parse", "--short=8", "HEAD")


def run_check(body, repo):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        got = kb.check_implement_hashes(body, repo)
    return got, err.getvalue()


tmp = tempfile.mkdtemp()
remote, work, other = (os.path.join(tmp, d) for d in ("remote.git", "work", "other"))
subprocess.run(["git", "init", "-q", "--bare", "-b", "develop", remote], check=True, env=_env)
subprocess.run(["git", "clone", "-q", remote, work], check=True, env=_env, capture_output=True)
git(work, "checkout", "-q", "-b", "develop")
base = commit(work, "base")
git(work, "push", "-q", "origin", "develop")

# 1. A pushed commit passes.
got, _ = run_check(f"## Implemented — commit {base}", work)
check("pushed", got, [])

# 2. A local commit that was never pushed is refused.
local = commit(work, "fix")
got, _ = run_check(f"Fixed in {local}.", work)
check("unpushed", got, [local])

# 3. Another agent pushes first; the fix is rebased and pushed under a new hash.
#    The pre-rebase hash still resolves here, and is refused.
subprocess.run(["git", "clone", "-q", "-b", "develop", remote, other], check=True, env=_env,
               capture_output=True)
commit(other, "theirs")
git(other, "push", "-q", "origin", "develop")
git(work, "fetch", "-q")
git(work, "rebase", "-q", "origin/develop")
git(work, "push", "-q", "origin", "develop")
rebased = git(work, "rev-parse", "--short=8", "HEAD")
got, _ = run_check(f"Fixed in {local}.", work)
check("rebased.old_hash", got, [local])
got, _ = run_check(f"Fixed in {rebased}.", work)
check("rebased.new_hash", got, [])

# 4. UUIDs, date tags and words are not cited commits.
got, err = run_check("doc 01a1733d-41dd-7da4-bb6a-70f2fbdc324b, tag 20260726a, word deadbeef", work)
check("non_commits.refused", got, [])
check("non_commits.uuid_not_warned", "01a1733d" in err, False)
check("non_commits.word_skipped", "deadbeef" in err, False)  # hex but no digit
check("non_commits.date_tag_warned", "20260726a is not a commit" in err, True)

# 5. No hash at all: a warning, not a refusal.
got, err = run_check("Applied the KB data fix by hand.", work)
check("no_hash.refused", got, [])
check("no_hash.warned", "cites no commit hash" in err, True)

# 6. Outside a git repository: skipped with a note.
got, err = run_check(f"Fixed in {local}.", tmp)
check("no_repo.refused", got, [])
check("no_repo.noted", "not a git repository" in err, True)

# 7. cmd_write: refuses before writing; --no-hash-check and other kinds go through.
posted = []
kb._post_write = lambda *a, **k: posted.append(a) or 0
md = os.path.join(tmp, "implement.md")


def write(kind, no_check=False):
    with open(md, "w") as f:
        f.write(f"---\ncase_number: 1\nresponse_kind: {kind}\nauthor: t\n"
                f"doc_status: published\n---\nFixed in {local}.\n")
    args = argparse.Namespace(file=md, json=None, field=None, edge=None, metadata=None,
                              format="text", hash_repo=work, no_hash_check=no_check)
    posted.clear()
    with contextlib.redirect_stderr(io.StringIO()):
        rc = kb.cmd_write("CASE_RESPONSE", args)
    return rc, len(posted)


check("cmd_write.refused", write("implement"), (1, 0))
check("cmd_write.no_hash_check", write("implement", no_check=True), (0, 1))
check("cmd_write.comment_unchecked", write("comment"), (0, 1))

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — all implement-hash cases pass")
