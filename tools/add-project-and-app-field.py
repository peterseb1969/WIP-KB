#!/usr/bin/env python3
"""add-project-and-app-field.py — DECISION-1 option one: projects inside a domain.

Two schema steps, both idempotent:

1. Create the PROJECT template (one profile per project, identity = its KB_APP
   term) from its seed file, server/seed/templates/19e_PROJECT.json, so the live
   template and the seed a fresh bootstrap uses are the same declaration.
   Skipped when PROJECT already exists.

2. Add the optional `app` field (a KB_APP term, the same shape CASE_RECORD already
   carries) to DESIGN_DECISION, LESSON, FIRESIDE, SESSION, YAC_MEMORY and
   DOCUMENT. Template create is an upsert: re-POSTing the full declaration with
   one extra field yields a new version. The structured diff must be EXACTLY
   added_optional=['app'] — anything wider means the live template drifted from
   what this script rebuilds, and versioning it would codify the drift, so it
   aborts. Templates already carrying `app` are skipped.

   `app` is also added to reporting.cross_version_view.columns, MERGED into the
   columns already declared there: that declaration is what the entity view is
   generated from, and assigning it once un-projected `topics` on canonical
   (see repair-document-cross-version-view.py).

The OLD versions stay active. Writes resolve to the latest active version, so new
documents land on the new one anyway, and deactivating a doc-bearing version has
wedged archive restores before (see add-topics-field.py).

Existing documents are not tagged here: PATCH validates against each document's
pinned version, and only the new versions know `app`, so tagging needs a migrate
first. That is a separate, later step.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  admin API key file (default ~/.wip-deploy/wip-local/secrets/api-key)
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/wip-local/secrets/api-key")
)).expanduser().read_text().strip()
CTX = ssl._create_unverified_context()
NS = "kb"
SEED = Path(__file__).resolve().parent.parent / "server/seed/templates/19e_PROJECT.json"


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=30) as resp:
        return json.load(resp)


def get_template(value):
    try:
        return req("GET", f"/api/template-store/templates/by-value/{value}?namespace={NS}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]

APP_FIELD = {"name": "app", "label": "App", "type": "term", "mandatory": False,
             "reference_type": "term", "terminology_ref": "KB_APP"}

print(f"target: {BASE}  namespace: {NS}")

# --- 1. PROJECT ---------------------------------------------------------------
cur = get_template("PROJECT")
if cur:
    print(f"SKIP PROJECT: already exists (v{cur['version']})")
else:
    seed = json.loads(SEED.read_text())
    payload = {k: seed[k] for k in ("value", "label", "description", "usage", "identity_fields", "fields")}
    payload["namespace"] = NS
    item = req("POST", "/api/template-store/templates", [payload])["results"][0]
    if item["status"] != "created":
        sys.exit(f"ABORT PROJECT: status={item['status']} error={item.get('error')} "
                 f"details={json.dumps(item.get('details'))[:400]}")
    print(f"OK PROJECT: created v{item.get('version')} ({item.get('id')})")

# --- 2. optional `app` on six types ---------------------------------------------
for value in ["DESIGN_DECISION", "LESSON", "FIRESIDE", "SESSION", "YAC_MEMORY", "DOCUMENT"]:
    cur = get_template(value)
    if cur is None:
        sys.exit(f"ABORT {value}: template not found in {NS}")
    if any(f["name"] == "app" for f in cur["fields"]):
        print(f"SKIP {value}: app already present (v{cur['version']})")
        continue
    fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
    fields.append(APP_FIELD)
    payload = {
        "value": cur["value"], "label": cur["label"], "namespace": NS,
        "description": cur.get("description") or "",
        "usage": cur.get("usage") or "entity",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": fields,
        "rules": cur.get("rules") or [],
    }
    rep = dict(cur.get("reporting") or {})
    rep["sync_enabled"] = True
    cvv = dict(rep.get("cross_version_view") or {})
    cvv["versions"] = cvv.get("versions") or "all"
    cvv["columns"] = {**(cvv.get("columns") or {}), "app": {}}
    rep["cross_version_view"] = cvv
    payload["reporting"] = rep
    item = req("POST", "/api/template-store/templates", [payload])["results"][0]
    if item["status"] != "updated":
        sys.exit(f"ABORT {value}: status={item['status']} error={item.get('error')} "
                 f"details={json.dumps(item.get('details'))[:400]}")
    d = item.get("details") or {}
    print(f"OK {value}: v{cur['version']} -> v{item.get('version')}  "
          f"added_optional={d.get('added_optional')} cvv_columns={sorted(cvv['columns'])}")
    if (d.get("added_optional") != ["app"] or d.get("removed") or d.get("changed_type")
            or d.get("made_required") or d.get("modified_existing") or d.get("added_required")):
        sys.exit(f"ABORT {value}: diff is more than added_optional[app]: {json.dumps(d)[:400]}")
print("DONE")
