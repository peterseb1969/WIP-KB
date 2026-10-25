#!/usr/bin/env python3
"""narrow-tooling-types.py — PROJECT.tooling accepts only what WIP will store.

The tooling field allowed application/zip, application/x-tar, application/gzip and
application/x-gzip. WIP's file upload has its own allowlist, and its default holds
only application/zip and application/gzip, so a plain .tar passed the template's
check and was then refused at upload (CASE-889). This narrows the field to the two
types WIP stores, so the template no longer promises what the platform refuses.

Template create is an upsert: re-POSTing the full declaration with the narrowed
list yields a new version. Template-store has no dry run for that, so the payload
is compared with the live template FIRST and the script aborts unless the only
difference is tooling.file_config.allowed_types; after the POST the server's own
diff must name only `tooling`. The old version stays active (deactivating a
doc-bearing version has wedged archive restores before); it still validates
existing profiles, and no profile holds a .tar. Re-runs are idempotent.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  admin API key file (default: WIP_API_KEY_FILE from .env, sandbox target only)
  KB_NS       namespace          (default kb)
"""
import copy
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
NS = os.environ.get("KB_NS", "kb")
TYPE = "PROJECT"
FIELD = "tooling"
ALLOWED = ["application/zip", "application/gzip"]


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

print(f"target: {BASE}  namespace: {NS}")
try:
    cur = req("GET", f"/api/template-store/templates/by-value/{TYPE}?namespace={NS}")
except urllib.error.HTTPError as e:
    sys.exit(f"ABORT {TYPE}: template not found in {NS} ({e.code})")

fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
target = next((f for f in fields if f["name"] == FIELD), None)
if target is None:
    sys.exit(f"ABORT {TYPE}: v{cur['version']} has no {FIELD} field")
before = (target.get("file_config") or {}).get("allowed_types")
if sorted(before or []) == sorted(ALLOWED):
    print(f"SKIP {TYPE}: v{cur['version']} {FIELD} already allows {before}")
    sys.exit(0)

new_fields = copy.deepcopy(fields)
nt = next(f for f in new_fields if f["name"] == FIELD)
nt["file_config"] = {**(nt.get("file_config") or {}), "allowed_types": ALLOWED}

# The local pre-check: everything but the one list must be identical.
diff = [f["name"] for f, g in zip(fields, new_fields) if f != g]
if diff != [FIELD] or len(fields) != len(new_fields) or \
        {k: v for k, v in target["file_config"].items() if k != "allowed_types"} != \
        {k: v for k, v in nt["file_config"].items() if k != "allowed_types"}:
    sys.exit(f"ABORT {TYPE}: the planned change is wider than {FIELD}.allowed_types: {diff}")
print(f"plan {TYPE}: v{cur['version']} {FIELD}.allowed_types {before} -> {ALLOWED}")

payload = {
    "value": cur["value"], "label": cur["label"], "namespace": NS,
    "description": cur.get("description") or "",
    "usage": cur.get("usage") or "entity",
    "identity_fields": cur.get("identity_fields") or [],
    "header_fields": cur.get("header_fields") or [],
    "fields": new_fields,
    "rules": cur.get("rules") or [],
}
# Sent only when declared: an empty object would make the server write its
# defaults out explicitly, a cosmetic difference from the version it replaces.
if cur.get("reporting"):
    payload["reporting"] = cur["reporting"]
if cur.get("metadata"):
    payload["metadata"] = cur["metadata"]
item = req("POST", "/api/template-store/templates", [payload])["results"][0]
if item["status"] != "updated":
    sys.exit(f"ABORT {TYPE}: status={item['status']} error={item.get('error')} "
             f"details={json.dumps(item.get('details'))[:400]}")
d = item.get("details") or {}
print(f"OK {TYPE}: v{cur['version']} -> v{item.get('version')}  details={json.dumps(d)}")
wider = [k for k in ("added_optional", "added_required", "removed", "changed_type", "made_required")
         if d.get(k)]
if wider or (d.get("modified_existing") or []) not in ([FIELD], []):
    sys.exit(f"WARNING {TYPE}: the server reports more than {FIELD} changed: {json.dumps(d)[:400]}")
print("DONE")
