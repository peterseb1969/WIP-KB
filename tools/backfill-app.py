#!/usr/bin/env python3
"""backfill-app.py — tag existing documents with their project (`app`, DECISION-1).

The optional `app` field (a KB_APP term) exists only on the new template versions
created by add-project-and-app-field.py, so existing documents carry none. This
infers each one's project from fields it already has, per
tools/backfill-app-mapping.json:

  SESSION        role         -> role_to_app
  YAC_MEMORY     owner        -> role_to_app
  DOCUMENT       repo_id      -> repo_id_to_app
  LESSON, DESIGN_DECISION, FIRESIDE
                 authored_by  -> the YAC roles in it that are listed in
                                 infer_from_author_roles, mapped through
                                 role_to_app; tagged only if exactly ONE app results

Documents that already carry `app`, or whose project cannot be inferred, are left
alone. CASE_RECORD already has `app` and is out of scope.

How a document is tagged: its complete current data plus `app` is re-submitted
against the template's latest version. The identity is unchanged, so WIP records an
UPDATE of the same document (a new version, same document_id) — not a migrate, which
would bump every document in a version cohort, tagged or not. Metadata is carried
over. Only tagged documents get a new version.

Dry run is the default and writes nothing. It validates every planned write against
the latest template version and checks that the identity hash it would produce equals
the document's current one, so an apply can only update, never fork. --apply writes,
and aborts on the first item that does not come back as 'updated'.

Usage:
  KB_TARGET=https://localhost:8443 KB_KEYFILE=~/.wip-deploy/wip-local/secrets/api-key \\
    python3 tools/backfill-app.py [--apply] [--types SESSION,DOCUMENT] [--namespace kb]
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/wip-local/secrets/api-key")
)).expanduser().read_text().strip()
CTX = ssl._create_unverified_context()
MAPPING = Path(__file__).resolve().parent / "backfill-app-mapping.json"
TYPES = ["SESSION", "YAC_MEMORY", "DOCUMENT", "LESSON", "DESIGN_DECISION", "FIRESIDE"]
WRITER = "tools/backfill-app"


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
        return json.load(resp)


def all_docs(template_id, ns):
    out, page = [], 1
    while True:
        d = req("POST", f"/api/document-store/documents/query?namespace={ns}",
                {"template_id": template_id, "page": page, "page_size": 1000})
        out += d["items"]
        if page >= (d.get("pages") or 1):
            return out
        page += 1


# A session id is <ROLE>-YYYYMMDD[-HHMM[SS]]; strip that suffix to get the role.
ROLE_RE = re.compile(r"^([A-Za-z]+(?:-[A-Za-z]+)*?)(?:-\d{8}(?:-\d{4,6})?)?$")


def author_roles(authored_by):
    roles = set()
    for tok in re.split(r"[,/;&]|\band\b", authored_by or ""):
        tok = tok.strip().strip('"').strip()
        m = ROLE_RE.match(tok)
        if m:
            roles.add(m.group(1))
    return roles


def infer(type_, data, mp):
    """(app or None, reason) for one document's data."""
    if type_ in ("SESSION", "YAC_MEMORY"):
        key = data.get("role") if type_ == "SESSION" else data.get("owner")
        app = mp["role_to_app"].get(key)
        return (app, f"{key}") if app else (None, f"unmapped role {key!r}")
    if type_ == "DOCUMENT":
        key = data.get("repo_id")
        app = mp["repo_id_to_app"].get(key)
        return (app, f"repo {data.get('repo_origin')}") if app else (
            None, f"unmapped repo_id ({data.get('repo_origin')})")
    roles = {r for r in author_roles(data.get("authored_by")) if r in mp["infer_from_author_roles"]}
    apps = {mp["role_to_app"][r] for r in roles if r in mp["role_to_app"]}
    if len(apps) == 1:
        return next(iter(apps)), f"author {'/'.join(sorted(roles))}"
    if not apps:
        return None, "no app-YAC author"
    return None, f"several app-YAC authors {sorted(roles)}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--types", help=f"comma list, default all of {','.join(TYPES)}")
    ap.add_argument("--namespace", default="kb")
    args = ap.parse_args()
    ns = args.namespace
    types = args.types.split(",") if args.types else TYPES
    mp = json.loads(MAPPING.read_text())

    print(f"target: {BASE}  namespace: {ns}  mode: {'APPLY' if args.apply else 'dry run'}")
    # Every app the mapping names must be a KB_APP term here, before anything else.
    kb_app = req("GET", f"/api/def-store/terminologies/by-value/KB_APP?namespace={ns}")["terminology_id"]
    named = set(mp["role_to_app"].values()) | set(mp["repo_id_to_app"].values())
    for app in sorted(named):
        r = req("POST", "/api/def-store/validate", {"terminology_id": kb_app, "value": app})
        if not r.get("valid"):
            sys.exit(f"ABORT: mapping names {app!r}, which is not a KB_APP term in {ns}")

    problems = 0
    for type_ in types:
        tpl = req("GET", f"/api/template-store/templates/by-value/{type_}?namespace={ns}")
        if not any(f["name"] == "app" for f in tpl["fields"]):
            sys.exit(f"ABORT {type_}: latest version v{tpl['version']} has no `app` field — "
                     f"run add-project-and-app-field.py first")
        docs = all_docs(tpl["template_id"], ns)
        plan, already, untagged = [], 0, Counter()
        for d in docs:
            if d["data"].get("app"):
                already += 1
                continue
            app, why = infer(type_, d["data"], mp)
            if app:
                plan.append((d, app, why))
            else:
                untagged[why] += 1
        # Prove each planned write updates the same document: same identity hash.
        for d, app, _ in plan:
            # validate checks the latest active version — the one the write targets
            v = req("POST", "/api/document-store/validation/validate", {
                "template_id": tpl["template_id"], "namespace": ns, "data": {**d["data"], "app": app}})
            if v.get("template_version") != tpl["version"]:
                problems += 1
                print(f"  VERSION {type_} {d['document_id']}: validated v{v.get('template_version')}, "
                      f"write would target v{tpl['version']}")
            elif not v.get("valid"):
                problems += 1
                print(f"  INVALID {type_} {d['document_id']}: {[e.get('message') for e in v.get('errors', [])][:2]}")
            elif v.get("identity_hash") != d["identity_hash"]:
                problems += 1
                print(f"  FORK {type_} {d['document_id']}: identity hash would change")
        by_app = Counter(app for _, app, _ in plan)
        print(f"\n{type_} (latest v{tpl['version']}): {len(docs)} docs — "
              f"{already} already tagged, {len(plan)} to tag, {sum(untagged.values())} left untagged")
        for app, n in by_app.most_common():
            print(f"    tag {app:14} {n}")
        for why, n in untagged.most_common():
            print(f"    untagged: {why} ({n})")

        if args.apply and plan:
            if problems:
                sys.exit("ABORT: problems above — nothing applied")
            for i in range(0, len(plan), 100):
                batch = plan[i:i + 100]
                body = []
                for d, app, _ in batch:
                    item = {"template_id": tpl["template_id"], "template_version": tpl["version"],
                            "namespace": ns, "data": {**d["data"], "app": app}, "created_by": WRITER}
                    custom = (d.get("metadata") or {}).get("custom")
                    if custom:
                        item["metadata"] = custom
                    body.append(item)
                res = req("POST", "/api/document-store/documents", body)["results"]
                for (d, _, _), r in zip(batch, res):
                    if r.get("status") != "updated" or r.get("document_id", d["document_id"]) != d["document_id"]:
                        sys.exit(f"ABORT {type_} {d['document_id']}: status={r.get('status')} "
                                 f"error={r.get('error')} — stopping")
            print(f"    applied: {len(plan)} updated")

    if problems:
        print(f"\n{problems} problem(s) — an apply would refuse to run.")
        sys.exit(1)
    print("\nDONE" + ("" if args.apply else " (dry run — nothing written)"))


if __name__ == "__main__":
    main()
