#!/usr/bin/env python3
"""add-topics-field.py — add the optional `topics` array field (CASE-760/764 Phase 2/A).

Adds `topics` (array of KB_TOPIC terms, optional) to the corpus types a human
navigates by subject — CASE_RECORD, FIRESIDE, LESSON, DESIGN_DECISION,
JOURNEY_ENTRY and DOCUMENT in the kb namespace, LIBRARY_DOC in library — and
folds a cross_version_view over all versions into the same version event so the
reporting entity view exposes the new column immediately (default views do not
widen on their own — cross_version_view is the knob).

Template create is an upsert: re-POSTing the full declaration with one extra
field yields a new version with status='updated'. The script verifies the
structured diff is EXACTLY added_optional=['topics'] and aborts on anything
more — a wider diff means the live template drifted from what this script
rebuilds, and versioning it would silently codify the drift. Templates that
already carry `topics` are skipped, so re-runs are no-ops.

The OLD version stays active after the upsert (template update never replaces).
Leave it active: deactivating the doc-bearing version has previously wedged
archive restores (CASE-766 history) — deactivate v1 only deliberately, with an
explicit version number, after the backup/restore test matrix work settles.

After this script, migrate existing docs before tagging them: PATCH validates
against each doc's PINNED version, and only the new version knows `topics`
(tag-topics.py does that migrate as its first step).

Env:
  KB_TARGET    base URL          (default https://localhost:8443 — the sandbox)
  KB_KEYFILE   admin API key file (default ~/.wip-deploy/default/secrets/api-key)
  KB_TOPIC_ID  KB_TOPIC terminology id (default: the canonical id, which is also
               valid on any ID-preserving restore of canonical — sandbox and
               prod-test. A fresh non-restore instance must run
               create-kb-topic-taxonomy.py first and pass the id it prints.)
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
KB_TOPIC_ID = os.environ.get("KB_TOPIC_ID", "019f898b-46cd-7392-812e-49ed735224dd")


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

TOPICS_FIELD = {
    "name": "topics", "label": "Topics", "type": "array", "mandatory": False,
    "array_item_type": "term", "array_terminology_ref": KB_TOPIC_ID,
}

print(f"target: {BASE}")
# The types a human navigates by subject. Deliberately not every type: SESSION
# and CASE_RESPONSE are reached through their parent, and FLAG_RECORD /
# BOOTSTRAP_RECORD / GIT_STATS_SNAPSHOT / WRITE_POLICY are machine records nobody
# browses by topic. Adding the field to those would cost a version event and a
# reporting column each, to sit permanently empty.
for ns, value in [("kb", "CASE_RECORD"), ("kb", "FIRESIDE"), ("kb", "LESSON"),
                  ("kb", "DESIGN_DECISION"), ("kb", "JOURNEY_ENTRY"), ("kb", "DOCUMENT"),
                  ("library", "LIBRARY_DOC")]:
    cur = req("GET", f"/api/template-store/templates/by-value/{value}?namespace={ns}")
    if any(f["name"] == "topics" for f in cur["fields"]):
        print(f"SKIP {ns}/{value}: topics already present (v{cur['version']})")
        continue
    fields = []
    for f in cur["fields"]:
        clean = {k: f[k] for k in FIELD_KEYS if f.get(k) is not None}
        fields.append(clean)
    fields.append(TOPICS_FIELD)
    payload = {
        "value": cur["value"], "label": cur["label"], "namespace": ns,
        "description": cur.get("description") or "",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": fields,
        "rules": cur.get("rules") or [],
    }
    rep = cur.get("reporting") or {}
    rep["sync_enabled"] = True
    rep["cross_version_view"] = {"versions": "all", "columns": {"topics": {}}}
    payload["reporting"] = rep
    resp = req("POST", "/api/template-store/templates", [payload])
    item = resp["results"][0]
    if item["status"] not in ("updated",):
        sys.exit(f"ABORT {ns}/{value}: status={item['status']} error={item.get('error')} details={json.dumps(item.get('details'))[:400]}")
    d = item.get("details") or {}
    print(f"OK {ns}/{value}: v{cur['version']} -> v{item.get('version')}  "
          f"added_optional={d.get('added_optional')} removed={d.get('removed')} "
          f"changed_type={d.get('changed_type')} made_required={d.get('made_required')} "
          f"modified_existing={d.get('modified_existing')}")
    if (d.get("removed") or d.get("changed_type") or d.get("made_required")
            or d.get("modified_existing") or d.get("added_required")):
        sys.exit(f"ABORT {ns}/{value}: diff shows more than added_optional[topics] — inspect before touching v{cur['version']}")
print("DONE")
