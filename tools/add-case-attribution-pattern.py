#!/usr/bin/env python3
"""add-case-attribution-pattern.py — CASE-957: WIP refuses a malformed case attribution.

Adds a `pattern` validation to CASE_RECORD.filed_by, CASE_RECORD.authored_by and
CASE_RESPONSE.author, so a value that names no writer is refused by WIP itself,
whichever client sends it: an old cached kb-write.py, a script, or the gateway.
An unexpanded `$(cat .claude/.session-id)` once reached canonical this way
(CASE-945). The pattern admits exactly the three kinds of attribution the KB
produces:
  - a YAC session ID, <ROLE>-YYYYMMDD-HHMMSS (HHMM before seconds precision;
    roles are mixed-case, e.g. FRanC);
  - a signed-in user's email, which the KB UI stamps on the responses and flags
    it writes (server/ui-author.ts);
  - WEB-UI, the UI's attribution on an install without authentication.
Older shapes (date-only FRanC-YYYYMMDD IDs, `unknown`) live only on records pinned
to the earlier template version, which stay valid; no current writer produces them.

Template create is an upsert: re-POSTing the full declaration with the pattern on
those fields yields a new version. The structured diff must be EXACTLY
modified_existing on the expected fields — anything wider means the live template
drifted from what this script rebuilds, and versioning it would codify the drift,
so it aborts. New documents validate against the new latest version at once (the
gateway posts without a template_version). Status changes on existing cases are
PATCHes, which validate against each document's own version, so existing records
are unaffected.

The old version stays active (deactivating a doc-bearing version has wedged
archive restores before). Re-runs are idempotent.

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

PATTERN = (r"^(?:[A-Za-z][A-Za-z0-9-]*-[0-9]{8}-[0-9]{4}(?:[0-9]{2})?"
           r"|[^@\s]+@[^@\s]+"
           r"|WEB-UI)$")
TARGETS = {"CASE_RECORD": ["filed_by", "authored_by"], "CASE_RESPONSE": ["author"]}

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
        out["validation"] = {**(f.get("validation") or {}), "pattern": PATTERN}
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
    todo = [n for n in names if (by_name[n].get("validation") or {}).get("pattern") != PATTERN]
    if not todo:
        print(f"SKIP {value}: pattern already on {names} (v{cur['version']})")
        continue
    if DRY_RUN:
        print(f"WOULD {value}: v{cur['version']} -> v{cur['version'] + 1}, pattern on {todo}")
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
