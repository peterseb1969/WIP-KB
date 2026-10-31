#!/usr/bin/env python3
"""add-case-status-enum.py — WIP refuses a case status outside the workflow's four.

CASE_RECORD.status was a free string: any value was stored, and a mis-parsed
status ("---") once replaced a case's real one without complaint. The case
workflow knows exactly four statuses — open, responded, closed, implemented —
with transitions enforced by the writers; this adds an `enum` validation with
those four, so WIP refuses anything else from any writer. The field stays a
string, so every reader and filter on data.status is unchanged. On canonical
(2026-10-31) all 903 cases already used only these four values.

Template create is an upsert: re-POSTing the full declaration with the enum on
`status` yields a new version. The structured diff must be EXACTLY
modified_existing=['status'], else the script aborts rather than version a
drifted template. New documents and patches of documents on the new version
validate at once; existing documents keep validating against their own version
until migrated (migrate_documents). The old version stays active (deactivating
a doc-bearing version has wedged archive restores before). Re-runs are
idempotent.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  admin API key file (default: WIP_API_KEY_FILE from .env, sandbox target only)
  DRY_RUN=1   report what would change, write nothing
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
DRY_RUN = os.environ.get("DRY_RUN") == "1"
CTX = ssl._create_unverified_context()
NS = "kb"

STATUSES = ["open", "responded", "closed", "implemented"]
TARGETS = {"CASE_RECORD": ["status"]}

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


def field_decl(f, with_pattern):
    out = {k: f[k] for k in FIELD_KEYS if f.get(k) is not None}
    if with_pattern:
        out["validation"] = {**(f.get("validation") or {}), "enum": STATUSES}
    return out


print(f"target: {BASE}  namespace: {NS}{'  (dry run)' if DRY_RUN else ''}")
failed = False
for value, names in TARGETS.items():
    try:
        cur = req("GET", f"/api/template-store/templates/by-value/{value}?namespace={NS}")
    except urllib.error.HTTPError as e:
        sys.exit(f"ABORT {value}: template not found in {NS} ({e.code})")
    by_name = {f["name"]: f for f in cur["fields"]}
    missing = [n for n in names if n not in by_name]
    if missing:
        sys.exit(f"ABORT {value}: fields {missing} not on v{cur['version']}")
    todo = [n for n in names if (by_name[n].get("validation") or {}).get("enum") != STATUSES]
    if not todo:
        print(f"SKIP {value}: enum already on {names} (v{cur['version']})")
        continue
    if DRY_RUN:
        print(f"WOULD {value}: v{cur['version']} -> v{cur['version'] + 1}, enum on {todo}")
        continue
    payload = {
        "value": cur["value"], "label": cur["label"], "namespace": NS,
        "description": cur.get("description") or "",
        "usage": cur.get("usage") or "entity",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": [field_decl(f, f["name"] in names) for f in cur["fields"]],
        "rules": cur.get("rules") or [],
    }
    for k in ("reporting", "metadata"):
        if cur.get(k):
            payload[k] = cur[k]
    item = req("POST", "/api/template-store/templates", [payload])["results"][0]
    if item["status"] != "updated":
        sys.exit(f"ABORT {value}: status={item['status']} error={item.get('error')} "
                 f"details={json.dumps(item.get('details'))[:400]}")
    d = item.get("details") or {}
    changed = sorted(d.get("modified_existing") or [])
    print(f"OK {value}: v{cur['version']} -> v{item.get('version')}  modified_existing={changed}")
    if (changed != sorted(todo) or d.get("added_optional") or d.get("added_required")
            or d.get("removed") or d.get("changed_type") or d.get("made_required")):
        print(f"ERROR {value}: diff is not exactly modified_existing={sorted(todo)}: "
              f"{json.dumps(d)[:400]}")
        failed = True
if failed:
    sys.exit(1)
print("DONE")
