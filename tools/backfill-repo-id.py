#!/usr/bin/env python3
"""backfill-repo-id.py — stamp each DOCUMENT with its source repository's identity (CASE-825).

`repo_origin` is a NAME someone assigns; `repo_id` is what the repository itself
says it is — its root-commit SHA, or all roots sorted and comma-joined when a
repo has several. Identical across every clone by construction, distinct between
repositories. That is the property CASE-825 needed and a directory name never had.

The map from name to identity is computed from the CLONES ON DISK, not hardcoded:
each `repo_origin` value in the corpus is matched to a sibling clone directory and
fingerprinted with `git rev-list --max-parents=0 HEAD`. A value with no matching
clone ABORTS the run rather than guessing — an unknown origin is exactly the
condition that produced this case, and inventing an id for it would repeat the
mistake in a new form.

Two clones of one repository therefore collapse onto ONE repo_id, which is the
point: on the origin machine `World-in-a-Pie` and `WIP-TC01` both fingerprint to
`5157b9ad…`.

Order matters. Documents are pinned to the template version they were written
against, and PATCH validates against that PINNED version — so a doc on a version
predating `repo_id` rejects the field with "Unknown field". The cohorts are
migrated to the current version FIRST; skipping that step is how the same mistake
already bit the topic picker (a control that appeared on 200 documents and 422'd
on every save).

Default is a dry-run: the migrate runs dry_run only and the plan is printed but
not written. Pass --apply for real.

Env:
  KB_TARGET     base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE    admin API key file (default ~/.wip-deploy/default/secrets/api-key)
  CLONES_ROOT   directory holding the repo clones (default ~/Development/Amrum)
  KB_TO_VERSION target template version (default: current active DOCUMENT version)
"""
import argparse
import json
import os
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/default/secrets/api-key")
)).expanduser().read_text().strip()
CLONES = Path(os.environ.get("CLONES_ROOT", str(Path.home() / "Development/Amrum"))).expanduser()
CTX = ssl._create_unverified_context()


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
        return json.load(resp)


def report(sql, ns="kb"):
    return req("POST", f"/api/reporting-sync/query?namespace={ns}",
               {"namespace": ns, "sql": sql, "max_rows": 5000})["rows"]


def fingerprint(clone: Path) -> str | None:
    """Sorted root-commit SHAs, comma-joined. Raw rather than hashed so it stays
    checkable by hand and needs no algorithm agreement with the writer."""
    if not (clone / ".git").exists():
        return None
    out = subprocess.run(["git", "-C", str(clone), "rev-list", "--max-parents=0", "HEAD"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        return None
    roots = sorted(x for x in out.stdout.split() if x)
    return ",".join(roots) or None


def main():
    ap = argparse.ArgumentParser(description="CASE-825 repo_id backfill")
    ap.add_argument("--apply", action="store_true", help="migrate and PATCH for real (default: dry-run)")
    args = ap.parse_args()
    print(f"target: {BASE}  clones: {CLONES}  mode: {'APPLY' if args.apply else 'DRY-RUN'}")

    tpl = req("GET", "/api/template-store/templates/by-value/DOCUMENT?namespace=kb")
    to_v = int(os.environ.get("KB_TO_VERSION", tpl["version"]))
    if not any(f["name"] == "repo_id" for f in tpl["fields"]):
        sys.exit("ABORT: DOCUMENT has no repo_id field — run tools/add-document-fields.py first")
    print(f"DOCUMENT current version: v{tpl['version']}  target: v{to_v}")

    origins = [r["repo_origin"] for r in
               report("SELECT DISTINCT repo_origin FROM kb.doc_document WHERE status='active' ORDER BY 1")]
    fps, unknown = {}, []
    for o in origins:
        fp = fingerprint(CLONES / o)
        (fps.__setitem__(o, fp) if fp else unknown.append(o))
    for o, fp in fps.items():
        print(f"  {o:18s} -> {fp}")
    if unknown:
        sys.exit(f"ABORT: no clone/fingerprint for {unknown} under {CLONES}. "
                 "An unknown origin is what caused this case; refusing to invent an id.")
    collapsed = {}
    for o, fp in fps.items():
        collapsed.setdefault(fp, []).append(o)
    for fp, names in collapsed.items():
        if len(names) > 1:
            print(f"  NOTE {names} are the SAME repository ({fp[:12]}…) — they collapse to one repo_id")

    # 1. migrate cohorts onto the version that knows repo_id
    versions = [r["template_version"] for r in report(
        "SELECT DISTINCT template_version FROM kb.doc_document WHERE status='active' ORDER BY 1")]
    for v in versions:
        if v == to_v:
            continue
        dry = req("POST", "/api/document-store/documents/migrate?namespace=kb",
                  {"template_id": "DOCUMENT", "from_version": v, "to_version": to_v, "dry_run": True})
        print(f"migrate v{v}->v{to_v} DRY: total={dry.get('total')} failed={dry.get('failed')}")
        if dry.get("failed"):
            sys.exit(f"ABORT migrate v{v}: {json.dumps(dry.get('results', [])[:3])[:400]}")
        if args.apply and dry.get("total"):
            res = req("POST", "/api/document-store/documents/migrate?namespace=kb",
                      {"template_id": "DOCUMENT", "from_version": v, "to_version": to_v, "dry_run": False})
            print(f"migrate v{v}->v{to_v} APPLY: succeeded={res.get('succeeded')} failed={res.get('failed')}")
            if res.get("failed"):
                sys.exit("ABORT: migrate failed")

    # 2. plan the stamp — only documents that lack one
    rows = report("SELECT document_id, repo_origin, repo_id FROM kb.doc_document WHERE status='active'")
    plan = {r["document_id"]: fps[r["repo_origin"]] for r in rows
            if not r.get("repo_id") and r["repo_origin"] in fps}
    print(f"backfill plan: {len(plan)}/{len(rows)} documents ({len(rows) - len(plan)} already stamped or skipped)")
    if not args.apply:
        print("(dry-run: no writes — re-run with --apply)")
        return

    patched = failed = 0
    ids = list(plan.items())
    for i in range(0, len(ids), 100):
        batch = [{"document_id": d, "patch": {"repo_id": fp}} for d, fp in ids[i:i + 100]]
        resp = req("PATCH", "/api/document-store/documents?namespace=kb", batch)
        for r in resp.get("results", []):
            if r.get("status") in ("updated", "unchanged"):
                patched += 1
            else:
                failed += 1
                if failed <= 3:
                    print("PATCH FAIL:", json.dumps(r)[:300])
    print(f"patched={patched} failed={failed}")
    if failed:
        sys.exit(1)
    print("DONE")


if __name__ == "__main__":
    main()
