#!/usr/bin/env python3
"""add-response-files.py — add files_change / files_read to CASE_RESPONSE.

A response's `## Files in scope` section names the repo-relative files the fix
would change or only read. kb-write.py copies that list into two optional
`array<string>` fields, so a scheduler can see whether two cases touch the same
files with one reporting query on data, not by parsing markdown. This script adds
the two fields to an existing namespace; a fresh bootstrap gets them from the seed
(server/seed/templates/12b_CASE_RESPONSE.json).

One version event: the full current declaration is re-posted with the two fields
added, and the reporting cross_version_view is extended in the same post, so the
entity view `doc_case_response` (the view a scheduler reads) exposes the new
columns. Without that declaration the view carries only the columns every version
shares and would omit them. The declaration is merged, never assigned: assigning
it un-projects every column not relisted.

Additive only: existing responses keep their version and stay valid; responses
written after it may carry the fields. The structured diff is checked to be
exactly the two added optional fields, and anything wider aborts. Re-runs on a
namespace that has both fields are no-ops. The previous version stays active,
like every other field migration in tools/ (deactivating a document-bearing
version has wedged archive restores before).

Order against the image does not matter: kb-write.py sends the fields only where
the gateway's /types lists them on the namespace's template (WIP refuses an
undeclared field). Until this script runs there, the list stays in the body only.

Dry run by default. APPLY=1 writes.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  API key file with admin on the namespace (default: WIP_API_KEY_FILE
              from .env, sandbox target only)
  KB_NS       namespace          (default kb)
  APPLY=1     write; without it, report only
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _keyfile import read_key  # noqa: E402

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = read_key("KB_KEYFILE", "KB_TARGET")
NS = os.environ.get("KB_NS", "kb")
APPLY = os.environ.get("APPLY") == "1"
CTX = ssl._create_unverified_context()
VALUE = "CASE_RESPONSE"

WANT = [
    {"name": "files_change", "label": "Files to Change", "type": "array",
     "array_item_type": "string", "mandatory": False},
    {"name": "files_read", "label": "Files to Read", "type": "array",
     "array_item_type": "string", "mandatory": False},
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
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ABORT {method} {path}: HTTP {e.code} {e.read().decode()[:400]}")


print(f"target: {BASE}  namespace: {NS}{'  (APPLY)' if APPLY else '  (dry run)'}")
cur = req("GET", f"/api/template-store/templates/by-value/{VALUE}?namespace={NS}")
have = {f["name"] for f in cur["fields"]}
missing = [f for f in WANT if f["name"] not in have]
if not missing:
    print(f"SKIP {NS}/{VALUE}: all present (v{cur['version']})")
    sys.exit(0)

fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
fields.extend(missing)
rep = dict(cur.get("reporting") or {})
rep["sync_enabled"] = True
cvv = rep.get("cross_version_view") or {}
cols = dict(cvv.get("columns") or {})
for f in WANT:
    cols.setdefault(f["name"], {})
rep["cross_version_view"] = {"versions": cvv.get("versions", "all"), "columns": cols}
print(f"  v{cur['version']}: adding {[f['name'] for f in missing]}")
print(f"  cross_version_view.columns: {sorted((cvv.get('columns') or {}).keys())} -> {sorted(cols)}")
if not APPLY:
    print("dry run only — re-run with APPLY=1 to write")
    sys.exit(0)

resp = req("POST", "/api/template-store/templates", [{
    "value": cur["value"], "label": cur["label"], "namespace": NS,
    "description": cur.get("description") or "",
    "usage": cur.get("usage") or "entity",
    "identity_fields": cur.get("identity_fields") or [],
    "header_fields": cur.get("header_fields") or [],
    "fields": fields,
    "rules": cur.get("rules") or [],
    "metadata": cur.get("metadata") or {},
    "reporting": rep,
}])
item = resp["results"][0]
if item["status"] != "updated":
    sys.exit(f"ABORT {NS}/{VALUE}: status={item['status']} error={item.get('error')} "
             f"details={json.dumps(item.get('details'))[:400]}")
d = item.get("details") or {}
added = sorted(d.get("added_optional") or [])
print(f"OK {NS}/{VALUE}: v{cur['version']} -> v{item.get('version')}  added_optional={added}")
if added != sorted(f["name"] for f in missing):
    sys.exit(f"ABORT: expected {sorted(f['name'] for f in missing)}, got {added}")
if (d.get("removed") or d.get("changed_type") or d.get("made_required")
        or d.get("modified_existing") or d.get("added_required")):
    sys.exit(f"ABORT {NS}/{VALUE}: diff wider than the fields added — inspect before proceeding")
print("DONE")
