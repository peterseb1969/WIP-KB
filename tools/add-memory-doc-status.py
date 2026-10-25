#!/usr/bin/env python3
"""add-memory-doc-status.py — CASE-906: let a YAC_MEMORY record be marked retired.

Adds the optional `doc_status` field (a KB_DOC_STATUS term, the same shape other KB
types carry) to YAC_MEMORY, so the memory mirror can set `deprecated` on a record
whose file is gone from its owner's memory directory, and the project brief can
leave it out. Unset means live; no existing record changes.

Template create is an upsert: re-POSTing the full declaration with one extra field
yields a new version. The structured diff must be EXACTLY
added_optional=['doc_status'] — anything wider means the live template drifted
from what this script rebuilds, and versioning it would codify the drift, so it
aborts. `doc_status` is also MERGED into reporting.cross_version_view.columns (the
declaration the entity view is generated from; a column missing there is missing
from the view). A template that already has the field but lacks the column gets
the declaration updated in place (PUT) and a batch sync to rebuild the view.

The old version stays active (deactivating a doc-bearing version has wedged
archive restores before). Re-runs are idempotent.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  admin API key file (default: WIP_API_KEY_FILE from .env, sandbox target only)
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
CTX = ssl._create_unverified_context()
NS = "kb"
TYPE = "YAC_MEMORY"
FIELD = "doc_status"


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=30) as resp:
        return json.load(resp)


FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]

DOC_STATUS_FIELD = {"name": FIELD, "label": "Doc Status", "type": "term", "mandatory": False,
                    "reference_type": "term", "terminology_ref": "KB_DOC_STATUS"}

print(f"target: {BASE}  namespace: {NS}")
try:
    cur = req("GET", f"/api/template-store/templates/by-value/{TYPE}?namespace={NS}")
except urllib.error.HTTPError as e:
    sys.exit(f"ABORT {TYPE}: template not found in {NS} ({e.code})")

has_field = any(f["name"] == FIELD for f in cur["fields"])
rep = dict(cur.get("reporting") or {})
cvv = dict(rep.get("cross_version_view") or {})
declared = cvv.get("columns") or {}
if has_field and FIELD in declared:
    print(f"SKIP {TYPE}: {FIELD} present and projected (v{cur['version']})")
    sys.exit(0)

rep["sync_enabled"] = True
cvv["versions"] = cvv.get("versions") or "all"
cvv["columns"] = {**declared, FIELD: {}}
rep["cross_version_view"] = cvv

if has_field:
    # Declaration only: in-place update, then a batch sync to rebuild the view.
    item = req("PUT", f"/api/template-store/templates?namespace={NS}",
               [{"template_id": cur["template_id"], "reporting": rep}])["results"][0]
    if item.get("status") != "updated" or item.get("is_new_version"):
        sys.exit(f"ABORT {TYPE}: reporting update status={item.get('status')} "
                 f"new_version={item.get('is_new_version')} error={item.get('error')}")
    job = req("POST", f"/api/reporting-sync/sync/batch/{TYPE}?namespace={NS}")
    print(f"OK {TYPE}: v{cur['version']} reporting declaration -> {sorted(cvv['columns'])} "
          f"(in place); view rebuild job {job.get('job_id')}")
    sys.exit(0)

payload = {
    "value": cur["value"], "label": cur["label"], "namespace": NS,
    "description": cur.get("description") or "",
    "usage": cur.get("usage") or "entity",
    "identity_fields": cur.get("identity_fields") or [],
    "header_fields": cur.get("header_fields") or [],
    "fields": [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
              + [DOC_STATUS_FIELD],
    "rules": cur.get("rules") or [],
    "reporting": rep,
}
item = req("POST", "/api/template-store/templates", [payload])["results"][0]
if item["status"] != "updated":
    sys.exit(f"ABORT {TYPE}: status={item['status']} error={item.get('error')} "
             f"details={json.dumps(item.get('details'))[:400]}")
d = item.get("details") or {}
print(f"OK {TYPE}: v{cur['version']} -> v{item.get('version')}  "
      f"added_optional={d.get('added_optional')} cvv_columns={sorted(cvv['columns'])}")
if ((d.get("added_optional") or []) != [FIELD] or d.get("removed") or d.get("changed_type")
        or d.get("made_required") or d.get("modified_existing") or d.get("added_required")):
    sys.exit(f"ABORT {TYPE}: field diff is not exactly added_optional=['{FIELD}']: {json.dumps(d)[:400]}")
print("DONE")
