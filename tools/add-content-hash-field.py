#!/usr/bin/env python3
"""add-content-hash-field.py — add the optional `content_hash` field to DOCUMENT (CASE-825).

The gateway stamps a sha256 of the stored body into this field on every DOCUMENT
write and refuses to mint a NEW paper_number for content that already exists
under a different one. The field has to exist before the guard can store or
query anything, so this runs before the gateway change reaches an instance.

Why a stored field and not a hash computed at comparison time: the guard is a
single equality FILTER on the write path. Recomputing would mean fetching and
hashing every body on every write — O(corpus) per mirror.

Deliberately NOT an identity field. Identity must survive an edit, since that is
what makes an edit a new version rather than a new document; a content hash
changes on every edit, which is the opposite property. `paper_number` stays the
identity (PoNIF #3).

Same shape as add-topics-field.py: the template create is an upsert, the diff is
verified to be EXACTLY added_optional=['content_hash'], and cross_version_view
rides in the same payload so the reporting entity view exposes the column
immediately rather than only on new versions. Re-runs are no-ops.

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

FIELD = {"name": "content_hash", "label": "Content Hash", "type": "string", "mandatory": False}
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
for ns, value in [("kb", "DOCUMENT")]:
    cur = req("GET", f"/api/template-store/templates/by-value/{value}?namespace={ns}")
    if any(f["name"] == FIELD["name"] for f in cur["fields"]):
        print(f"SKIP {ns}/{value}: {FIELD['name']} already present (v{cur['version']})")
        continue
    fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
    fields.append(FIELD)
    rep = cur.get("reporting") or {}
    rep["sync_enabled"] = True
    rep["cross_version_view"] = {"versions": "all", "columns": {"content_hash": {}}}
    resp = req("POST", "/api/template-store/templates", [{
        "value": cur["value"], "label": cur["label"], "namespace": ns,
        "description": cur.get("description") or "",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": fields,
        "rules": cur.get("rules") or [],
        "reporting": rep,
    }])
    item = resp["results"][0]
    if item["status"] != "updated":
        sys.exit(f"ABORT {ns}/{value}: status={item['status']} error={item.get('error')}")
    d = item.get("details") or {}
    print(f"OK {ns}/{value}: v{cur['version']} -> v{item.get('version')}  added_optional={d.get('added_optional')}")
    if (d.get("removed") or d.get("changed_type") or d.get("made_required")
            or d.get("modified_existing") or d.get("added_required")):
        sys.exit(f"ABORT {ns}/{value}: diff wider than added_optional[{FIELD['name']}] — inspect before proceeding")
print("DONE")
