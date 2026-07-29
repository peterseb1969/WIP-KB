#!/usr/bin/env python3
"""add-document-fields.py — ensure DOCUMENT carries the CASE-825 identity fields.

Adds whichever of `content_hash` and `repo_id` are missing, in ONE version event.
Supersedes add-content-hash-field.py, which added only the first: canonical had
neither, and two version bumps for two optional fields is churn for nothing.

  content_hash — sha256 of the stored body, stamped by the gateway on every
                 DOCUMENT write. Powers the refusal to mint a NEW paper_number
                 for content that already exists under a different one.

  repo_id      — the SOURCE REPOSITORY's identity: its root-commit SHA, or for a
                 repo with several roots, all of them sorted and comma-joined.
                 Stored raw rather than hashed so it stays verifiable by hand
                 (`git rev-list --max-parents=0 HEAD | sort`) and needs no
                 algorithm agreement between writer and store.

Why repo_id exists: `repo_origin` is a NAME someone assigns, and CASE-825 is what
that costs — two clones of one repository presented as two repositories and forked
18 papers. A root-commit set is identical across every clone by construction and
distinct between repositories, so two checkouts cannot disagree about which repo
they are. Measured across seven clones on the origin machine: World-in-a-Pie and
WIP-TC01 both `5157b9ad…`, every other repo distinct.

Both are OPTIONAL and NEITHER is an identity field. They must not be mandatory:
this ships BEFORE any writer sends repo_id, and a required field would reject
every existing writer on deploy. Identity stays `paper_number`; switching the
mint's search key to repo_id is a later, separate step that must not happen until
the backfill has run (a search key preferring a field half the corpus lacks would
fork it again — the same bug, caused by its own fix).

Idempotent: fields already present are left alone; if none are missing the
template is untouched. The diff is verified to contain ONLY the fields this script
adds, and it aborts on anything wider.

Env:
  KB_TARGET    base URL          (default https://localhost:8443 — the sandbox)
  KB_KEYFILE   admin API key file (default ~/.wip-deploy/default/secrets/api-key)
"""
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/default/secrets/api-key")
)).expanduser().read_text().strip()
CTX = ssl._create_unverified_context()

WANT = [
    {"name": "content_hash", "label": "Content Hash", "type": "string", "mandatory": False},
    {"name": "repo_id",      "label": "Repo ID",      "type": "string", "mandatory": False},
    {"name": "path_tail",    "label": "Path (repo-relative)", "type": "string", "mandatory": False},
]
FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=30) as resp:
        return json.load(resp)


print(f"target: {BASE}")
NS, VALUE = "kb", "DOCUMENT"
cur = req("GET", f"/api/template-store/templates/by-value/{VALUE}?namespace={NS}")
have = {f["name"] for f in cur["fields"]}
missing = [f for f in WANT if f["name"] not in have]
if not missing:
    print(f"SKIP {NS}/{VALUE}: all present (v{cur['version']}) — {[f['name'] for f in WANT]}")
    sys.exit(0)

fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
fields.extend(missing)
rep = cur.get("reporting") or {}
rep["sync_enabled"] = True
# cross_version_view.columns is the DECLARATION the entity view is generated from,
# so it must be MERGED, never assigned. Assigning it silently un-projects every
# column not relisted: doing exactly that on canonical removed `topics` from
# kb.doc_document while leaving the data untouched in the per-version tables —
# invisible to the Topic facet and to any SQL over the view, with nothing failing.
# Read the current declaration, add to it, keep everything already there.
cvv = rep.get("cross_version_view") or {}
cols = dict(cvv.get("columns") or {})
for f in WANT:
    cols.setdefault(f["name"], {})
rep["cross_version_view"] = {"versions": cvv.get("versions", "all"), "columns": cols}
print(f"  cross_version_view.columns: {sorted((cvv.get('columns') or {}).keys())} -> {sorted(cols)}")
resp = req("POST", "/api/template-store/templates", [{
    "value": cur["value"], "label": cur["label"], "namespace": NS,
    "description": cur.get("description") or "",
    "identity_fields": cur.get("identity_fields") or [],
    "header_fields": cur.get("header_fields") or [],
    "fields": fields,
    "rules": cur.get("rules") or [],
    "reporting": rep,
}])
item = resp["results"][0]
if item["status"] != "updated":
    sys.exit(f"ABORT {NS}/{VALUE}: status={item['status']} error={item.get('error')}")
d = item.get("details") or {}
added = sorted(d.get("added_optional") or [])
print(f"OK {NS}/{VALUE}: v{cur['version']} -> v{item.get('version')}  added_optional={added}")
if added != sorted(f["name"] for f in missing):
    sys.exit(f"ABORT: expected {sorted(f['name'] for f in missing)}, got {added}")
if (d.get("removed") or d.get("changed_type") or d.get("made_required")
        or d.get("modified_existing") or d.get("added_required")):
    sys.exit(f"ABORT {NS}/{VALUE}: diff wider than the fields added — inspect before proceeding")
print("DONE")
